/**
 * M24 网页翻译 · 页面世界运行时与注入调用构造
 *
 * 职责：
 * 1. translatePageRuntime：注入到页面（BrowserView，无 preload——TP1 教训）的
 *    自包含运行时，在页面世界维护「文本节点 ↔ 段 ID」映射（DOM 节点不可跨 executeJavaScript
 *    返回主进程，故节点引用必须留在页面侧，主进程只拿纯文本段）
 * 2. build*Call：主进程经 webContents.executeJavaScript 调用运行时各方法的代码串
 *
 * 设计理由（agents.md §七.2）：
 * - 用「类型化自包含函数 + Function.prototype.toString()」而非字符串模板（区别于
 *   zoom/ad-block-css）：本运行时逻辑复杂（TreeWalker 过滤/增量采集/恢复一致性），
 *   以真实 TS 函数编写可获得类型检查，jsdom 单测 eval 同一序列化结果（同源执行），
 *   并规避注入字符串转义坑（dev.57 教训：注入串内引号未转义 → SyntaxError）
 * - 约束：函数体必须自包含——只允许引用 window/document 等页面全局与自身局部变量，
 *   不得引用模块作用域的「值」（bundle 改名/作用域丢失会直接 ReferenceError；
 *   模块内的 TypeScript 类型不受限，转译后已擦除）
 * - 幂等守卫 window.__ubTranslate：重复注入（did-finish-load 重入）复用既有实例
 *   （zoom 的 __ubZoomInstalled 同款模式）
 */

/**
 * 页面世界运行时（自包含，禁止引用模块作用域的运行时值）。
 *
 * 方法契约：
 * - collect()：恢复既有译文 → 重置状态 → TreeWalker 采集全页可翻译文本节点 →
 *   重启 MutationObserver（childList 增量）→ 返回 { lang, segments }
 * - apply(items)：按 id 写回译文（节点已被页面移除时静默跳过）
 * - restore()：全部恢复原文
 * - takePending(max)：取出并清空增量队列（导航轮询拉取模型，§4）
 * - teardown()：恢复原文 + 断开 Observer + 删除全局标志（停止翻译）
 */
export function translatePageRuntime(): void {
  const w = window as typeof window & { __ubTranslate?: RuntimeState };
  // 幂等守卫：同一文档重复注入直接复用（did-finish-load 重入）
  if (w.__ubTranslate) return;

  /** 采集过滤：最短文本长度（更短的独立文本节点多为符号/残留，翻译价值低） */
  const MIN_CHARS = 2;
  /** 单页采集段数上限（超大国页面保护，与主进程 TRANSLATE_PAGE_MAX_SEGMENTS 对齐） */
  const MAX_SEGMENTS = 3000;
  /**
   * 排除选择器：脚本样式模板 / SVG 数学标记 / 嵌入对象 / 表单控件与可编辑区
   * （防误翻用户输入，规划 §7.2）/ aria-hidden / 标准不翻译约定
   * （translate="no" 属性与 notranslate 类是谷歌翻译内容脚本的事实标准，站点作者
   * 已用它标记品牌名/代码片段，遵循之成本为零）。
   * 注意：不排除 pre/code——文档型站点大量正文出现在代码块外的段落，
   * v1 保持覆盖面，误翻场景由「一键恢复原文」兜底（规划 §7.2）。
   */
  const EXCLUDE_SELECTOR =
    'script,style,noscript,template,svg,math,iframe,object,embed,select,option,textarea,' +
    'input,[contenteditable="true"],[aria-hidden="true"],[translate="no"],.notranslate';

  interface SegmentPayload {
    id: number;
    text: string;
  }

  interface Entry {
    id: number;
    node: Text;
    original: string;
    translated: string | null;
  }

  interface RuntimeState {
    collect(): { lang: string; segments: SegmentPayload[] };
    apply(items: SegmentPayload[]): number;
    restore(): void;
    takePending(max: number): SegmentPayload[];
    teardown(): void;
  }

  const entries: Entry[] = [];
  const byId = new Map<number, Entry>();
  const pending: SegmentPayload[] = [];
  // 可见集合用 WeakSet 防同节点重复 track；collect 重置时整体换新（WeakSet 不可清空）
  let seen = new WeakSet<Text>();
  let seq = 0;
  // 采集进行中标志：初始 collect 返回的段直接作为 collect() 结果交给主进程，
  // 不得同时进 pending（否则轮询会把同样的段重复翻译——测试暴露的成环风险）
  let inCollect = false;
  let observer: MutationObserver | null = null;

  /**
   * 可见性判定：优先 Element.checkVisibility（Chromium 原生，含祖先链 display/
   * visibility/content-visibility）；无此 API 的环境（jsdom 单测）沿祖先链查内联
   * 样式近似判定——不追求全量样式模拟，只保证「显式隐藏」被排除。
   */
  function isVisible(el: Element): boolean {
    const checker = el as Element & { checkVisibility?: () => boolean };
    if (typeof checker.checkVisibility === 'function') {
      try {
        return checker.checkVisibility();
      } catch {
        // 某些实现签名差异导致抛错时退化为内联样式检查
      }
    }
    let cur: Element | null = el;
    while (cur) {
      const style = (cur as HTMLElement).style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      cur = cur.parentElement;
    }
    return true;
  }

  /** 文本节点可翻译判定（规划 §7.2 采集过滤规则） */
  function isTranslatable(node: Text): boolean {
    const el = node.parentElement;
    if (!el) return false;
    if (el.closest(EXCLUDE_SELECTOR)) return false;
    if (!isVisible(el)) return false;
    const text = node.nodeValue ?? '';
    if (text.trim().length < MIN_CHARS) return false;
    // 至少含一个 Unicode 字母（排除纯数字/符号/空白节点）；\p{L} 需 u 标志
    if (!/\p{L}/u.test(text)) return false;
    return true;
  }

  /** 登记文本节点：分配段 ID、记录原文；非采集期（动态新增）进 pending 队列 */
  function track(node: Text): void {
    if (seen.has(node) || entries.length >= MAX_SEGMENTS) return;
    seen.add(node);
    seq += 1;
    const entry: Entry = { id: seq, node, original: node.nodeValue ?? '', translated: null };
    entries.push(entry);
    byId.set(entry.id, entry);
    if (!inCollect) pending.push({ id: entry.id, text: entry.original });
  }

  function collectTextNodes(root: Node): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let cur = walker.nextNode();
    while (cur) {
      if (isTranslatable(cur as Text)) track(cur as Text);
      cur = walker.nextNode();
    }
  }

  function startObserver(): void {
    if (observer) observer.disconnect();
    if (typeof MutationObserver !== 'function' || !document.body) return;
    // v1 仅跟进新增节点（childList）：characterData 变更包含自身译文写回，监听会成环；
    // 动态文本更新场景留给 v2 评估（规划 §7.2）
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            if (isTranslatable(n as Text)) track(n as Text);
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            collectTextNodes(n);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const runtime: RuntimeState = {
    collect() {
      // 重复 collect（重译/重新开始）：先恢复旧译文再重置，避免旧 entry 指向已变化文档
      runtime.restore();
      entries.length = 0;
      byId.clear();
      pending.length = 0;
      seen = new WeakSet<Text>();
      seq = 0;
      inCollect = true;
      try {
        collectTextNodes(document.body ?? document.documentElement);
      } finally {
        inCollect = false;
      }
      startObserver();
      return {
        lang: document.documentElement.lang || '',
        segments: entries.map((e) => ({ id: e.id, text: e.original })),
      };
    },
    apply(items) {
      let applied = 0;
      for (const item of items) {
        const entry = byId.get(item.id);
        if (!entry) continue;
        entry.node.nodeValue = item.text;
        entry.translated = item.text;
        applied += 1;
      }
      return applied;
    },
    restore() {
      for (const entry of entries) {
        if (entry.translated !== null) {
          try {
            entry.node.nodeValue = entry.original;
          } catch {
            // 节点已随页面销毁：忽略
          }
        }
        entry.translated = null;
      }
      pending.length = 0;
    },
    takePending(max) {
      return pending.splice(0, Math.max(0, max));
    },
    teardown() {
      runtime.restore();
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      entries.length = 0;
      byId.clear();
      pending.length = 0;
      delete w.__ubTranslate;
    },
  };

  w.__ubTranslate = runtime;
}

/** 运行时安装代码（函数序列化 + 立即执行） */
export function buildTranslateRuntimeInjection(): string {
  return `(${translatePageRuntime.toString()})();`;
}

/**
 * collect 调用：安装运行时并执行首轮采集。
 * 采集失败（极端页面脚本错误）时返回空结果而非抛错——调用方可走 skipped/空段路径。
 */
export function buildCollectCall(): string {
  return (
    `${buildTranslateRuntimeInjection()}` +
    ' (function(){ var t = window.__ubTranslate;' +
    ' if (!t) return { lang: "", segments: [] };' +
    ' try { return t.collect(); } catch (e) { return { lang: "", segments: [] } } })()'
  );
}

/** apply 调用：写回一批译文（items 经 JSON.stringify 内联；JSON 是合法 JS 字面量） */
export function buildApplyCall(items: readonly { id: number; text: string }[]): string {
  return `window.__ubTranslate ? window.__ubTranslate.apply(${JSON.stringify(items)}) : 0`;
}

/** pending 拉取调用（增量动态内容，主进程轮询） */
export function buildTakePendingCall(max: number): string {
  return `window.__ubTranslate ? window.__ubTranslate.takePending(${max}) : []`;
}

/** 恢复原文 + 拆除运行时（停止翻译） */
export const TEARDOWN_CALL = 'window.__ubTranslate && window.__ubTranslate.teardown()';
