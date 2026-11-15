/** ADR-022：主进程管理 F12、目标所有权与原生窗口；不依赖 renderer 或 CDP 采集器。 */
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import type { WindowManager } from '../windows/window-manager';
import { createLogger } from '@urchin/logger';

const log = createLogger('native-devtools');
type Listener = (...args: unknown[]) => void;
interface EventSource {
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}
interface NativeContents extends EventSource {
  isDestroyed(): boolean;
  getURL(): string;
  focus(): void;
  openDevTools(options: { mode: 'detach' }): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  readonly devToolsWebContents?: NativeContents | null;
}
export interface NativeDevtoolsOptions {
  /** data: 只作为隔离 E2E fixture 启用。 */
  allowTestPages?: boolean;
  onUnavailable?: (windowId: number, reason: string) => void;
}
export type NativeDevtoolsInstallation = (() => void) & {
  /** 主进程显式登记有 owner 的壳子窗口（如独立地址栏），不按 URL 猜测归属。 */
  registerOwnerInput(windowId: number, source: unknown): void;
};
interface Session {
  tabId: number;
  windowId: number;
  target: NativeContents;
  phase: 'opening' | 'open' | 'closing';
  dispose: (() => void)[];
  timer?: ReturnType<typeof setTimeout>;
  focusOnClose: boolean;
}
// Electron 的内置 DevTools delegate 不转发 before-input-event（43.8.x 实测）。
// 仅在原生前端桥接其自带 closeWindow，不注入应用 preload/IPC，不改主题或面板。
const TOOL_F12_INSTALL = `(() => {
  const host = globalThis.DevToolsHost;
  if (!host || typeof host.sendMessageToEmbedder !== 'function') return false;
  globalThis.__urchinDisposeF12?.();
  const key = event => {
    if (event.key !== 'F12') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'keydown' && !event.repeat) {
      host.sendMessageToEmbedder(JSON.stringify({ id: 0, method: 'closeWindow', params: [] }));
    }
  };
  addEventListener('keydown', key, true); addEventListener('keyup', key, true);
  globalThis.__urchinDisposeF12 = () => {
    removeEventListener('keydown', key, true); removeEventListener('keyup', key, true);
    delete globalThis.__urchinDisposeF12;
  };
  return true;
})()`;
const TOOL_F12_REMOVE = 'globalThis.__urchinDisposeF12?.()';
function eventSource(value: unknown): value is EventSource {
  const source = value as Partial<EventSource> | null;
  return !!source && typeof source.on === 'function' && typeof source.removeListener === 'function';
}
function nativeContents(value: unknown): value is NativeContents {
  const wc = value as Partial<NativeContents> | null;
  return (
    eventSource(wc) &&
    ['isDestroyed', 'getURL', 'focus', 'openDevTools', 'closeDevTools', 'isDevToolsOpened'].every(
      (key) => typeof (wc as unknown as Record<string, unknown>)[key] === 'function',
    )
  );
}
function listen(source: EventSource, event: string, listener: Listener): () => void {
  source.on(event, listener);
  return () => source.removeListener(event, listener);
}
/** 吃掉 F12 down/up；焦点转移后仍以 autoRepeat 抑制长按。 */
function keyboard(source: EventSource, action: () => void): () => void {
  let pressed = false;
  const offInput = listen(source, 'before-input-event', (event, raw) => {
    const input = raw as { key?: string; type?: string; isAutoRepeat?: boolean } | undefined;
    if (input?.key !== 'F12') return;
    (event as { preventDefault(): void }).preventDefault();
    if (input.type === 'keyUp') {
      pressed = false;
      return;
    }
    if (input.type !== 'keyDown' || input.isAutoRepeat || pressed) return;
    pressed = true;
    action();
  });
  // Native tools can take focus before keyUp reaches the page. Closing the
  // tool starts a fresh press sequence; OS autoRepeat remains suppressed.
  const offClosed = listen(source, 'devtools-closed', () => {
    pressed = false;
  });
  const offBlur = listen(source, 'blur', () => {
    pressed = false;
  });
  return () => {
    offInput();
    offClosed();
    offBlur();
  };
}

export function installDevtoolsShortcuts(
  tabs: TabManager,
  windows: WindowManager,
  options: NativeDevtoolsOptions = {},
): NativeDevtoolsInstallation {
  const sessions = new Map<number, Session>();
  const tabInputs = new Map<number, () => void>();
  const windowInputs = new Map<number, () => void>();
  const extraInputs = new Map<EventSource, { windowId: number; dispose: () => void }>();
  let disposed = false;
  const report = (
    windowId: number,
    tabId: number | undefined,
    stage: string,
    reason: string,
  ): void => {
    // 不记录上游异常文本（可能含 URL/页面内容），只记录阶段和内部标识。
    log.warn('native DevTools unavailable', { windowId, tabId, stage });
    if (!disposed && windows.getWindow(windowId)) options.onUnavailable?.(windowId, reason);
  };
  const restoreFocus = (session: Session): void => {
    const owner = windows.getWindow(session.windowId)?.browserWindow;
    if (!owner || owner.isDestroyed()) return;
    owner.focus?.();
    const active = tabs.query({ windowId: session.windowId }).find((tab) => tab.active);
    const target = tabs.getTab(session.tabId);
    // 同工作区回到工具绑定的网页；不通过关闭工具偷偷切换工作区。
    if (target && active?.workspaceId === target.workspaceId && !session.target.isDestroyed()) {
      tabs.setActive(session.tabId);
      session.target.focus();
    }
  };
  const release = (session: Session, closeTool: boolean, focus = false): void => {
    if (sessions.get(session.tabId) !== session) return;
    sessions.delete(session.tabId);
    clearTimeout(session.timer);
    for (const off of session.dispose.splice(0)) off();
    if (closeTool && !session.target.isDestroyed()) {
      try {
        session.target.closeDevTools();
      } catch {
        /* 目标关闭中，仍释放所有权。 */
      }
    }
    if (focus && !disposed) restoreFocus(session);
  };
  const deadline = (session: Session): void => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      release(session, true);
      report(
        session.windowId,
        session.tabId,
        session.phase,
        '开发者工具未能完成打开或关闭，请重试。',
      );
    }, 10_000);
    session.timer.unref?.();
  };
  const close = (session: Session): void => {
    if (sessions.get(session.tabId) !== session || session.phase !== 'open') return;
    session.phase = 'closing';
    session.focusOnClose = true;
    deadline(session);
    try {
      session.target.closeDevTools();
    } catch {
      release(session, true, true);
      report(session.windowId, session.tabId, 'close', '开发者工具关闭失败，请重试。');
    }
  };
  const toggle = (windowId: number): void => {
    if (disposed) return;
    const owner = windows.getWindow(windowId)?.browserWindow;
    if (!owner || owner.isDestroyed()) return;
    const snapshot = tabs.query({ windowId }).find((tab) => tab.active);
    const tab = snapshot && tabs.getTab(snapshot.id);
    if (!tab) {
      report(windowId, undefined, 'target', '当前窗口没有可调试的网页。');
      return;
    }
    const wc = tab.webContents;
    const supported = (url: string): boolean =>
      /^(https?:|file:)/i.test(url) || (!!options.allowTestPages && /^data:/i.test(url));
    if (tab.viewKind !== 'browser' || !supported(tab.url)) {
      report(windowId, tab.id, 'target', '内部页面和 GenOffice 视图暂不支持开发者工具。');
      return;
    }
    if (!nativeContents(wc) || wc.isDestroyed() || tab.crashed || !supported(wc.getURL())) {
      report(windowId, tab.id, 'target', '当前网页尚未就绪或已停止运行。');
      return;
    }
    const existing = sessions.get(tab.id);
    if (existing) {
      close(existing);
      return;
    } // opening/closing 中重复请求合并。
    const session: Session = {
      tabId: tab.id,
      windowId,
      target: wc,
      phase: 'opening',
      dispose: [],
      focusOnClose: true,
    };
    sessions.set(tab.id, session);
    session.dispose.push(
      listen(wc, 'devtools-opened', () => {
        if (sessions.get(tab.id) !== session || session.phase !== 'opening') return;
        const tool = wc.devToolsWebContents;
        if (!tool || tool.isDestroyed() || !wc.isDevToolsOpened()) {
          release(session, true);
          report(windowId, tab.id, 'opened', '开发者工具状态异常，请重试。');
          return;
        }
        session.phase = 'open';
        // 闭包绑定打开时的目标，不查询另一个窗口/当前标签。
        session.dispose.push(keyboard(tool, () => close(session)));
        session.dispose.push(() => {
          if (!tool.isDestroyed())
            void tool.executeJavaScript(TOOL_F12_REMOVE).catch(() => undefined);
        });
        void tool
          .executeJavaScript(TOOL_F12_INSTALL)
          .then((ready) => {
            if (sessions.get(tab.id) !== session) return;
            if (ready !== true) throw new Error('native-keyboard-bridge-unavailable');
            if (session.phase === 'open') clearTimeout(session.timer);
          })
          .catch(() => {
            if (sessions.get(tab.id) !== session) return;
            release(session, true);
            report(windowId, tab.id, 'keyboard', '开发者工具快捷键初始化失败，请重试。');
          });
      }),
      listen(wc, 'devtools-closed', () => release(session, false, session.focusOnClose)),
      listen(wc, 'destroyed', () => release(session, false)),
      listen(wc, 'render-process-gone', () => release(session, true)),
    );
    deadline(session);
    try {
      wc.openDevTools({ mode: 'detach' });
    } catch {
      release(session, true);
      report(windowId, tab.id, 'open', '开发者工具打开失败，请重试。');
    }
  };
  const installTab = (snapshot: TabSnapshot): void => {
    if (tabInputs.has(snapshot.id)) return;
    const wc = tabs.getTab(snapshot.id)?.webContents;
    if (!wc || !eventSource(wc) || wc.isDestroyed?.()) return;
    const offKey = keyboard(wc, () => toggle(snapshot.windowId));
    const offDestroyed = listen(wc, 'destroyed', () => {
      tabInputs.get(snapshot.id)?.();
      tabInputs.delete(snapshot.id);
    });
    tabInputs.set(snapshot.id, () => {
      offKey();
      offDestroyed();
    });
  };
  const installWindow = (windowId: number): void => {
    if (windowInputs.has(windowId)) return;
    const owner = windows.getWindow(windowId)?.browserWindow;
    if (owner && eventSource(owner.webContents)) {
      windowInputs.set(
        windowId,
        keyboard(owner.webContents, () => toggle(windowId)),
      );
    }
  };
  const removeTab = (snapshot: TabSnapshot): void => {
    const session = sessions.get(snapshot.id);
    if (session) release(session, true);
    tabInputs.get(snapshot.id)?.();
    tabInputs.delete(snapshot.id);
  };
  const removeWindow = (windowId: number): void => {
    windowInputs.get(windowId)?.();
    windowInputs.delete(windowId);
    for (const snapshot of tabs.query({ windowId })) removeTab(snapshot);
    for (const session of sessions.values())
      if (session.windowId === windowId) release(session, true);
    for (const [source, entry] of extraInputs)
      if (entry.windowId === windowId) {
        entry.dispose();
        extraInputs.delete(source);
      }
  };
  const registerOwnerInput = (windowId: number, source: unknown): void => {
    if (disposed || !windows.getWindow(windowId) || !eventSource(source) || extraInputs.has(source))
      return;
    const offKey = keyboard(source, () => toggle(windowId));
    const offDestroyed = listen(source, 'destroyed', () => {
      extraInputs.get(source)?.dispose();
      extraInputs.delete(source);
    });
    extraInputs.set(source, {
      windowId,
      dispose: () => {
        offKey();
        offDestroyed();
      },
    });
  };
  const updateTab = (snapshot: TabSnapshot): void => {
    const session = sessions.get(snapshot.id);
    if (
      session &&
      (snapshot.crashed || snapshot.viewKind !== 'browser' || /^urchin:/i.test(snapshot.url))
    ) {
      release(session, true);
    }
  };
  tabs.on('created', installTab);
  tabs.on('removed', removeTab);
  tabs.on('updated', updateTab);
  windows.on('window-created', installWindow);
  windows.on('window-closed', removeWindow);
  for (const snapshot of tabs.query({})) installTab(snapshot);
  for (const owner of windows.getAllWindows()) installWindow(owner.id);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    tabs.off('created', installTab);
    tabs.off('removed', removeTab);
    tabs.off('updated', updateTab);
    windows.off('window-created', installWindow);
    windows.off('window-closed', removeWindow);
    for (const session of sessions.values()) release(session, true);
    for (const off of tabInputs.values()) off();
    tabInputs.clear();
    for (const off of windowInputs.values()) off();
    windowInputs.clear();
    for (const entry of extraInputs.values()) entry.dispose();
    extraInputs.clear();
  };
  return Object.assign(dispose, { registerOwnerInput });
}
