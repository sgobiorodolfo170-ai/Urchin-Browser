/**
 * M15 DevTools · F12 快捷键安装器
 *
 * 依据：实施规划 §9 / 契约 G DT8。
 * 职责：对每个网页 tab 的 webContents 与主窗口 webContents 挂 before-input-event，
 * 命中 F12 → preventDefault() + sendToMainWindow('devtools:toggle')。
 *
 * 设计理由（agents.md §七.2）：F12 在页面聚焦时由 BrowserView 的 webContents
 * 接收，主窗口聚焦时由主窗口 webContents 接收；两处都挂才能覆盖所有焦点场景。
 * 安装/卸载复用 installZoomControl 的 created 监听 + 存量补挂 + dispose 模式。
 *
 * 已知限制（规划 §12）：F12 在面板求值输入框按下会关闭面板（主进程拦截优先
 * 于渲染层 keydown，无法 stopPropagation）；接受为 Chrome 行为差异。
 */
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import { createLogger } from '@urchin/logger';

const log = createLogger('devtools-shortcut');

/** before-input-event 处理函数类型（Electron）。 */
interface BeforeInputEventLike {
  readonly type: string;
  readonly key: string;
}

/** webContents 最小接口（便于测试 mock）。 */
interface WebContentsLike {
  on(event: 'before-input-event', handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isDestroyed?(): boolean;
}

/** toggle 通知回调（主进程 sendToMainWindow('devtools:toggle')）。 */
export type DevtoolsToggleNotifier = () => void;

/**
 * 安装 F12 快捷键：对每个 tab webContents + 主窗口 webContents 挂 before-input-event。
 *
 * @param tabManager 网页 tab 管理实例（订阅 created 补挂新标签 + 遍历存量）
 * @param mainWebContents 主窗口 webContents（可选；面板聚焦在主窗口时兜底）
 * @param notify toggle 通知回调
 * @returns 卸载函数（移除 created 监听与各 webContents 的 before-input-event）
 */
export function installDevtoolsShortcuts(
  tabManager: TabManager,
  mainWebContents: unknown,
  notify: DevtoolsToggleNotifier,
): () => void {
  const disposers: (() => void)[] = [];

  /** 单个 webContents 的 F12 拦截器。 */
  const installOn = (wc: unknown): void => {
    const electronWc = wc as WebContentsLike;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    // 防御：webContents 可能已销毁（测试 mock 无 isDestroyed）
    if (typeof electronWc.isDestroyed === 'function' && electronWc.isDestroyed()) return;

    const handler = (...args: unknown[]): void => {
      // before-input-event 签名：(event, input)
      const input = args[1] as BeforeInputEventLike | undefined;
      if (input?.type === 'keyDown' && input?.key === 'F12') {
        // 阻止页面接收 F12（与 Chrome 行为一致：F12 专属 DevTools 切换）
        (args[0] as { preventDefault?: () => void } | undefined)?.preventDefault?.();
        try {
          notify();
        } catch (err) {
          log.warn('devtools toggle notify failed', { error: String(err) });
        }
      }
    };
    electronWc.on('before-input-event', handler);
    disposers.push(() => {
      if (typeof electronWc.removeListener === 'function') {
        electronWc.removeListener('before-input-event', handler);
      }
    });
  };

  // 新标签补挂
  const onCreated = (snapshot: TabSnapshot): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) installOn(tab.webContents);
  };
  tabManager.on('created', onCreated);

  // 存量标签补挂
  for (const snapshot of tabManager.query({})) {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) installOn(tab.webContents);
  }

  // 主窗口
  if (mainWebContents) installOn(mainWebContents);

  log.info('devtools F12 shortcut installed');

  return () => {
    tabManager.off('created', onCreated);
    for (const dispose of disposers) dispose();
    log.info('devtools F12 shortcut uninstalled');
  };
}
