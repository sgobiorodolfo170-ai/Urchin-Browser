/**
 * M26 剪藏 · 页面快照脚本与主进程采集
 *
 * 职责：
 * 1. 在目标 tab 内执行自包含脚本，返回清理后的完整 HTML、选区 HTML、保护信号。
 * 2. 自动解除可解除的前端限制：直接读 DOM，不依赖页面复制事件。
 * 3. 跨域 iframe 由主进程通过 webFrameMain 逐帧补抽（executeJavaScript 在各自 frame 内运行）。
 * 4. 可选的懒加载滚动（仅当设置开启，限制步数与总时长）。
 *
 * 设计理由：
 * - 页面内容只在页面上下文读取，主进程不解析 DOM；Defuddle 在面板渲染进程执行。
 * - 不对页面做持久性修改；滚动后恢复原位置。
 */
import type { ClipperPageSignals } from '@urchin/ipc-contract';

/** 快照 HTML 上限（与 IPC schema 对齐） */
const MAX_HTML_CHARS = 16 * 1024 * 1024;
/** 选区 HTML 上限（与 IPC schema 对齐） */
const MAX_SELECTION_HTML_CHARS = 4 * 1024 * 1024;
/** 选区纯文本上限（与 IPC schema 对齐） */
const MAX_SELECTION_TEXT_CHARS = 2 * 1024 * 1024;
/** 单次 executeJavaScript 超时（毫秒） */
const FRAME_TIMEOUT_MS = 15_000;
/** 最多补抽的 iframe 数量（防止广告位大量 frame 拖慢） */
const MAX_FRAMES = 20;

/** WebContents 最小接口（便于单测 mock） */
export interface SnapshotWebContents {
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  getURL(): string;
  readonly id?: number;
}

export interface SnapshotFrameLike {
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly favicon?: string;
  readonly html: string;
  readonly selectionHtml: string;
  readonly selectionText: string;
  readonly signals: ClipperPageSignals;
}

interface RawFrameSnapshot {
  readonly ok?: boolean;
  readonly url?: string;
  readonly title?: string;
  readonly favicon?: string | null;
  readonly html?: string;
  readonly selectionHtml?: string;
  readonly selectionText?: string;
  readonly textLength?: number;
  readonly imageCount?: number;
  readonly frameCount?: number;
  readonly copyBlocked?: boolean;
  readonly userSelectNone?: boolean;
  readonly hasCanvas?: boolean;
  readonly hasOpenShadow?: boolean;
  readonly error?: string;
}

/**
 * 构造页面快照脚本。
 *
 * 脚本是自包含 IIFE（不依赖页面全局变量），返回结构见 RawFrameSnapshot。
 * loadLazy=true 时先滚动到底加载懒加载资源，再恢复原滚动位置。
 */
export function buildPageSnapshotScript(loadLazy: boolean): string {
  const lazyPrelude = loadLazy
    ? `
    // 懒加载收集：分步滚到底，最多 20 步；结束后恢复原位置。
    // 限制步数防止无限滚动页面（如社交信息流）阻塞剪藏。
    try {
      var startScrollY = window.scrollY;
      var step = Math.max(400, Math.round(window.innerHeight * 0.8));
      var index = 0;
      while (index < 20) {
        window.scrollBy(0, step);
        await new Promise(function (resolve) { setTimeout(resolve, 120); });
        var atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
        index += 1;
        if (atBottom) break;
      }
      window.scrollTo(0, startScrollY);
    } catch (e) { console.warn('[urchin snapshot]', e); }
`
    : '';

  return `
(async function () {
  function safeUrl(value) {
    if (!value) return '';
    try { return new URL(value, location.href).href; } catch (e) { return String(value); }
  }

  ${lazyPrelude}

  var MAX_HTML = ${MAX_HTML_CHARS};
  var MAX_SELECTION_HTML = ${MAX_SELECTION_HTML_CHARS};
  var MAX_SELECTION_TEXT = ${MAX_SELECTION_TEXT_CHARS};

  // 开放 Shadow DOM：把 shadowRoot 内容作为独立 section 追加，供 Defuddle 读取。
  // 闭 Shadow DOM 由主进程 CDP 兜底（页面脚本无法拿到 closed root）。
  function collectOpenShadowHtml() {
    var chunks = [];
    try {
      var nodes = document.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i += 1) {
        var root = nodes[i].shadowRoot;
        if (!root) continue;
        var wrap = document.createElement('section');
        wrap.setAttribute('data-urchin-shadow-root', '');
        wrap.innerHTML = root.innerHTML || '';
        chunks.push(wrap.outerHTML);
        if (chunks.length >= 30) break;
      }
    } catch (e) { console.warn('[urchin snapshot]', e); }
    return chunks.join('');
  }

  function collectSelection() {
    var html = '';
    var text = '';
    try {
      var selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        text = selection.toString() || '';
        var holder = document.createElement('div');
        for (var i = 0; i < selection.rangeCount; i += 1) {
          holder.appendChild(selection.getRangeAt(i).cloneContents());
        }
        html = holder.innerHTML || '';
      }
    } catch (e) { console.warn('[urchin snapshot]', e); }
    return { html: html, text: text };
  }

  function detectCopyBlocked() {
    try {
      if (document.oncopy || document.oncut || document.onselectstart || document.oncontextmenu) {
        return true;
      }
      var body = document.body;
      if (body && (
        body.getAttribute('oncopy') ||
        body.getAttribute('oncontextmenu') ||
        body.getAttribute('onselectstart')
      )) {
        return true;
      }
    } catch (e) { console.warn('[urchin snapshot]', e); }
    return false;
  }

  function detectUserSelectNone() {
    try {
      var targets = [document.body, document.documentElement];
      var article = document.querySelector('article, main, [role="main"]');
      if (article) targets.push(article);
      for (var i = 0; i < targets.length; i += 1) {
        var el = targets[i];
        if (!el) continue;
        var style = window.getComputedStyle(el);
        if (style.userSelect === 'none' || style.webkitUserSelect === 'none') return true;
      }
    } catch (e) { console.warn('[urchin snapshot]', e); }
    return false;
  }

  var selection = collectSelection();
  // 选区同样受 IPC schema 上限约束：页面脚本内先截断，避免超大选区导致
  // 响应校验失败、用户看到“剪藏失败”而不是部分内容。
  if (selection.html.length > MAX_SELECTION_HTML) {
    selection.html = selection.html.slice(0, MAX_SELECTION_HTML);
  }
  if (selection.text.length > MAX_SELECTION_TEXT) {
    selection.text = selection.text.slice(0, MAX_SELECTION_TEXT);
  }
  var favicon = document.querySelector('link[rel~="icon"]');
  var copyBlocked = detectCopyBlocked();
  var userSelectNone = detectUserSelectNone();
  var hasCanvas = document.querySelectorAll('canvas').length > 0;
  var hasOpenShadow = false;
  try {
    var all = document.querySelectorAll('*');
    for (var s = 0; s < all.length; s += 1) {
      if (all[s].shadowRoot) { hasOpenShadow = true; break; }
    }
  } catch (e) { console.warn('[urchin snapshot]', e); }

  var clone = document.documentElement.cloneNode(true);
  // 移除脚本/样式/模板等非正文资源：Defuddle 只需要结构，快照导出会重新构建页面。
  var removable = clone.querySelectorAll('script, style, noscript, template, link[rel="stylesheet"]');
  for (var r = removable.length - 1; r >= 0; r -= 1) {
    if (removable[r].parentNode) removable[r].parentNode.removeChild(removable[r]);
  }

  var shadowHtml = collectOpenShadowHtml();
  if (shadowHtml) {
    var body = clone.querySelector('body');
    if (body) body.insertAdjacentHTML('beforeend', shadowHtml);
  }

  var html = clone.outerHTML || '';
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);

  var textLength = 0;
  try { textLength = (document.body && document.body.innerText ? document.body.innerText.length : 0); } catch (e) { console.warn('[urchin snapshot]', e); }

  return {
    ok: true,
    url: location.href,
    title: document.title || '',
    favicon: favicon ? safeUrl(favicon.getAttribute('href') || '') : '',
    html: html,
    selectionHtml: selection.html,
    selectionText: selection.text,
    textLength: textLength,
    imageCount: document.images ? document.images.length : 0,
    frameCount: window.frames ? window.frames.length : 0,
    copyBlocked: copyBlocked,
    userSelectNone: userSelectNone,
    hasCanvas: hasCanvas,
    hasOpenShadow: hasOpenShadow
  };
})();
`;
}

/** 带超时的 executeJavaScript（页面卡死时不让剪藏无限等待） */
async function executeWithTimeout<T>(
  target: { executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T> },
  code: string,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.executeJavaScript<T>(code, true),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`executeJavaScript timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 从 frame 返回值构造最小快照（异常时返回 null） */
function normalizeFrame(raw: RawFrameSnapshot | null | undefined): RawFrameSnapshot | null {
  if (raw?.ok !== true || typeof raw?.html !== 'string') return null;
  return raw;
}

/** 把子 frame 正文追加到主文档（作为独立 section，避免 Defuddle 丢弃孤立文本） */
function appendFrameHtml(mainHtml: string, frameSnapshots: readonly RawFrameSnapshot[]): string {
  if (frameSnapshots.length === 0) return mainHtml;
  const sections = frameSnapshots.map((frame) => {
    const source = frame.url ? ` data-urchin-frame-src="${escapeHtmlAttr(frame.url)}"` : '';
    return `<section${source}>${frame.html ?? ''}</section>`;
  });
  const merged = `${mainHtml}\n${sections.join('\n')}`;
  return merged.length > MAX_HTML_CHARS ? merged.slice(0, MAX_HTML_CHARS) : merged;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 主进程采集入口：主 frame + 同页所有子 frame（含跨域 iframe）。 */
export async function capturePageSnapshot(
  webContents: SnapshotWebContents,
  options: { readonly loadLazy: boolean; readonly frameList?: readonly SnapshotFrameLike[] },
): Promise<PageSnapshot> {
  const script = buildPageSnapshotScript(options.loadLazy);
  const raw = normalizeFrame(
    await executeWithTimeout(webContents as unknown as SnapshotFrameLike, script),
  );
  if (!raw) {
    throw new Error('页面快照失败');
  }

  const frames = options.frameList ?? [];
  const frameSnapshots: RawFrameSnapshot[] = [];
  for (const frame of frames.slice(0, MAX_FRAMES)) {
    try {
      const snapshot = normalizeFrame(
        await executeWithTimeout(frame, buildPageSnapshotScript(false)),
      );
      // 只收有实际文本的 frame，避免广告 iframe 塞进正文。
      if (snapshot && (snapshot.textLength ?? 0) >= 80) {
        frameSnapshots.push(snapshot);
      }
    } catch {
      // 单个 frame 超时/跨进程失败不影响主 frame 剪藏
    }
  }

  const signals: ClipperPageSignals = {
    copyBlocked: raw.copyBlocked === true,
    userSelectNone: raw.userSelectNone === true,
    hasCanvas: raw.hasCanvas === true,
    hasOpenShadow: raw.hasOpenShadow === true,
    hasClosedShadow: false,
    frameCount: raw.frameCount ?? 0,
    imageCount: raw.imageCount ?? 0,
    textLength: raw.textLength ?? 0,
  };

  return {
    url: raw.url ?? webContents.getURL(),
    title: raw.title ?? '',
    ...(raw.favicon ? { favicon: raw.favicon } : {}),
    html: appendFrameHtml(raw.html ?? '', frameSnapshots),
    selectionHtml: (raw.selectionHtml ?? '').slice(0, MAX_SELECTION_HTML_CHARS),
    selectionText: (raw.selectionText ?? '').slice(0, MAX_SELECTION_TEXT_CHARS),
    signals,
  };
}
