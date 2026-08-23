/**
 * pi 网页版 · 原生目录选择器注入（dev.44）
 *
 * 需求（用户反馈）：pi 页面右下角「📁 项目路径」点击后要求手输路径，使用不便。
 * 改为：点击直接弹出 Windows 原生目录选择窗口（主进程 dialog.showOpenDialog），
 * 手动选择目标目录后自动切换 pi 工作目录——全程无需输入。
 *
 * 实现（不动第三方包源码，延续 pi-web 所有改造的既定原则）：
 * - 主进程协议端点：`urchin://pi-pick-dir` → 弹原生目录选择器 → 返回 JSON {path}
 *   （响应带 CORS 头供页面读取；Referer 白名单校验，防远程网页诱弹对话框盗读路径，
 *   复用 file-resource 的 isTrustedReferer 语义）
 * - 页面注入脚本（executeJavaScript，did-finish-load 后，__ubCwdPickerInstalled 幂等）：
 *   捕获阶段拦截 button.status-cwd 的点击（stopPropagation 阻止 pi 原生输入框逻辑），
 *   fetch 端点拿路径后，再放行一次点击让 pi 自己打开输入框 → React 原生 setter
 *   写入路径 + 派发 input/Enter → 走 pi 自己的 set_cwd 切换（不绕过其校验/会话逻辑）
 * - 暴露 window.__ubCwdPickerPick(path) 供 E2E/调试直调（跳过原生弹窗）
 */
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-web-dir-picker');

/** 目录选择协议 host（urchin://pi-pick-dir） */
export const PICK_DIR_HOST = 'pi-pick-dir';

/** 注入脚本幂等标志 + 调试入口名 */
const INSTALLED_FLAG = '__ubCwdPickerInstalled';
const BYPASS_FLAG = '__ubCwdPickerBypass';
const BUSY_FLAG = '__ubCwdPickerBusy';
const PICK_FN = '__ubCwdPickerPick';

/**
 * 构建注入到 pi-web-ui 页面的目录选择拦截脚本（纯字符串，可单测）。
 *
 * 行为：
 * - 捕获阶段监听 click：命中 button.status-cwd 且非放行态 → preventDefault +
 *   stopPropagation（阻断 pi 原生「打开手输输入框」逻辑）→ fetch urchin://pi-pick-dir
 * - 返回 { path } → doPick(path)：置放行标志后重新 click 按钮（pi 打开输入框），
 *   React 原生 value setter 写入路径 + input 事件 + Enter keydown → pi 自身 set_cwd
 * - 用户取消选择（path 为空）→ 什么都不做（也不打开输入框）
 * - window.__ubCwdPickerPick 暴露直调入口（E2E/调试绕过原生弹窗）
 */
export function buildCwdPickerInjectionScript(): string {
  return (
    '(function(){' +
    `if (window.${INSTALLED_FLAG}) return;` +
    `window.${INSTALLED_FLAG} = true;` +
    // 写入路径：等 React 渲染出输入框（btn.click() 后异步提交，轮询等待），
    // 原生 setter 写值 + input 事件；延时派发 Enter——等 React 提交 onChange 状态，
    // 避免 Enter 处理器读到旧值
    'function doPick(path){' +
    'function fill(el){' +
    "var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;" +
    'setter.call(el, path);' +
    "el.dispatchEvent(new Event('input', { bubbles: true }));" +
    'setTimeout(function(){' +
    'el.focus();' +
    "el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));" +
    '}, 60);' +
    'return true;' +
    '}' +
    'function attempt(tries){' +
    "var el = document.querySelector('input.status-cwd-input');" +
    'if (el) { fill(el); return; }' +
    'if (tries <= 0) return;' +
    "var btn = document.querySelector('button.status-cwd');" +
    'if (!btn) return;' +
    `window.${BYPASS_FLAG} = true;` +
    'btn.click();' +
    `window.${BYPASS_FLAG} = false;` +
    'setTimeout(function(){ attempt(tries - 1); }, 50);' +
    '}' +
    'attempt(12);' + // ~600ms 窗口：覆盖 React 渲染 + 慢机器
    '}' +
    'function openPicker(){' +
    `window.${BUSY_FLAG} = true;` +
    "fetch('urchin://pi-pick-dir', { mode: 'cors' })" +
    '.then(function(r){ return r.json(); })' +
    '.then(function(data){ if (data && data.path) doPick(data.path); })' +
    '.catch(function(){})' +
    `.then(function(){ window.${BUSY_FLAG} = false; });` +
    '}' +
    "document.addEventListener('click', function(e){" +
    `if (window.${BUSY_FLAG}) return;` +
    `if (window.${BYPASS_FLAG}) return;` +
    'var t = e.target;' +
    "var btn = t && t.closest ? t.closest('button.status-cwd') : null;" +
    'if (!btn) return;' +
    'e.preventDefault();' +
    'e.stopPropagation();' +
    'openPicker();' +
    '}, true);' +
    `window.${PICK_FN} = doPick;` +
    '})();'
  );
}

/**
 * 目录选择协议响应（纯函数，可单测）：Referer 白名单校验 + 回调选取 + JSON 返回。
 *
 * 安全：urchin: 已配 corsEnabled，任意网页可跨源请求——非受信 Referer
 * （urchin:// / file:// / localhost）一律 403，杜绝远程网页诱弹原生对话框
 * 并盗读用户选取的本地路径。
 *
 * @param referer 请求 Referer（空串 = 放行，与 file-resource 语义一致）
 * @param onPick 弹出原生目录选择器，返回所选绝对路径或 null（取消）
 */
export async function buildPickDirectoryResponse(
  referer: string,
  onPick: () => Promise<string | null>,
): Promise<Response> {
  if (referer !== '' && !isTrustedPickReferer(referer)) {
    log.warn('pi-pick-dir denied', { referer });
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }
  let path: string | null = null;
  try {
    path = await onPick();
  } catch (e) {
    log.error('pi-pick-dir onPick failed', { error: String(e) });
  }
  const body = JSON.stringify({ path });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** pi-pick-dir Referer 白名单：urchin:// 内部页、localhost/127.0.0.1（pi 页面所在）、file:// */
function isTrustedPickReferer(referer: string): boolean {
  if (referer.startsWith('urchin://')) return true;
  if (referer.startsWith('file://')) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(referer);
}

/**
 * 安装目录选择器注入（镜像 zoom 的生命周期模式）。
 *
 * 对每个网页 tab 的 webContents（created 事件 + 存量补装）注入拦截脚本：
 * did-finish-load 后注入（整页导航重新注入），已加载完成的立即补注入。
 * 脚本自身按 DOM 是否存在 button.status-cwd 生效，其他页面零影响。
 *
 * @param tabManager 网页 tab 管理实例
 * @returns 卸载函数（移除 created 与 did-finish-load 监听）
 */
export function installCwdPickerControl(tabManager: {
  on(event: 'created', listener: (snapshot: { id: number }) => void): unknown;
  off(event: 'created', listener: (snapshot: { id: number }) => void): unknown;
  getTab(id: number): { webContents: unknown } | undefined;
  query(_: unknown): readonly { id: number }[];
}): () => void {
  const disposers: (() => void)[] = [];

  /** 向单个 webContents 注入目录选择脚本（挂 did-finish-load + 立即补注入）。 */
  const injectInto = (wc: unknown): void => {
    const electronWc = wc as Electron.WebContents;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    const inject = (): void => {
      try {
        // userGesture=true：注入脚本中的 fetch 视为用户手势发起
        void electronWc.executeJavaScript(buildCwdPickerInjectionScript(), true).catch(() => {
          /* 忽略：页面导航/卸载中注入失败不影响下次 */
        });
      } catch {
        /* 忽略 */
      }
    };
    electronWc.on('did-finish-load', inject);
    disposers.push(() => {
      if (typeof electronWc.removeListener === 'function') {
        electronWc.removeListener('did-finish-load', inject);
      }
    });
    inject(); // 已加载完成的立即补注入（install 晚于首次导航时兜底）
  };

  const attachToTab = (snapshot: { id: number }): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) injectInto(tab.webContents);
  };
  tabManager.on('created', attachToTab);
  for (const snapshot of tabManager.query({})) {
    attachToTab(snapshot);
  }

  return () => {
    tabManager.off('created', attachToTab);
    for (const dispose of disposers) {
      dispose();
    }
  };
}
