import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDevtoolsShortcuts } from '../../src/main/devtools/install-shortcuts';
import type { TabManager } from '../../src/main/tabs/tab-manager';
import type { WindowManager } from '../../src/main/windows/window-manager';

class Contents extends EventEmitter {
  destroyed = false;
  opened = false;
  deferred = false;
  devToolsWebContents: Contents | null = null;
  constructor(public url = 'https://fixture.test/') {
    super();
  }
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  focus = vi.fn();
  executeJavaScript = vi.fn<(code: string) => Promise<unknown>>(() => Promise.resolve(true));
  isDevToolsOpened = () => this.opened;
  finishOpen() {
    this.opened = true;
    this.devToolsWebContents = new Contents('devtools://devtools/');
    this.emit('devtools-opened');
  }
  openDevTools = vi.fn(() => {
    if (!this.deferred) this.finishOpen();
  });
  closeDevTools = vi.fn(() => {
    this.opened = false;
    if (this.devToolsWebContents) this.devToolsWebContents.destroyed = true;
    this.devToolsWebContents = null;
    this.emit('devtools-closed');
  });
  key(type = 'keyDown', repeat = false, key = 'F12') {
    const event = { preventDefault: vi.fn() };
    this.emit('before-input-event', event, { type, key, isAutoRepeat: repeat });
    return event;
  }
  press() {
    this.key();
    this.key('keyUp');
  }
}
function fixture() {
  const tabEvents = new EventEmitter();
  const windowEvents = new EventEmitter();
  const tabList = [
    {
      id: 11,
      windowId: 1,
      workspaceId: 'a',
      active: true,
      viewKind: 'browser',
      crashed: false,
      url: 'https://fixture.test/a',
      webContents: new Contents(),
    },
    {
      id: 12,
      windowId: 1,
      workspaceId: 'a',
      active: false,
      viewKind: 'browser',
      crashed: false,
      url: 'https://fixture.test/b',
      webContents: new Contents(),
    },
    {
      id: 21,
      windowId: 2,
      workspaceId: 'b',
      active: true,
      viewKind: 'browser',
      crashed: false,
      url: 'https://fixture.test/c',
      webContents: new Contents(),
    },
  ];
  const owners = [1, 2].map((id) => ({
    id,
    browserWindow: {
      webContents: new Contents(),
      isDestroyed: () => false,
      focus: vi.fn(),
    },
  }));
  const tabs = Object.assign(tabEvents, {
    query: ({ windowId }: { windowId?: number }) =>
      tabList.filter((t) => windowId === undefined || t.windowId === windowId),
    getTab: (id: number) => tabList.find((t) => t.id === id),
    setActive: vi.fn((id: number) => {
      const target = tabList.find((t) => t.id === id)!;
      for (const tab of tabList) if (tab.windowId === target.windowId) tab.active = tab.id === id;
    }),
  });
  const windows = Object.assign(windowEvents, {
    getAllWindows: () => owners,
    getWindow: (id: number) => owners.find((w) => w.id === id),
  });
  const report = vi.fn();
  const dispose = installDevtoolsShortcuts(
    tabs as unknown as TabManager,
    windows as unknown as WindowManager,
    { onUnavailable: report },
  );
  return {
    tabs,
    windows,
    tabList,
    owners,
    report,
    dispose,
    a: tabList[0]!.webContents,
    b: tabList[1]!.webContents,
    c: tabList[2]!.webContents,
    shell: owners[0]!.browserWindow.webContents,
  };
}
const cleanups: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanups.push(f.dispose);
  return f;
}
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  vi.useRealTimers();
});

describe('native F12 ownership and lifecycle', () => {
  it('routes explicitly registered address-bar contents to its owner and reclaims them', () => {
    const f = setup();
    const addressBar = new Contents();
    f.dispose.registerOwnerInput(2, addressBar);
    f.dispose.registerOwnerInput(2, addressBar);
    addressBar.press();
    expect(f.c.opened).toBe(true);
    expect(f.a.opened).toBe(false);
    f.windows.emit('window-closed', 2);
    expect(addressBar.eventNames()).toEqual([]);
    f.dispose.registerOwnerInput(1, addressBar);
    addressBar.emit('destroyed');
    expect(addressBar.eventNames()).toEqual([]);
  });
  it('the native frontend adapter replaces listeners without evaluating a closing frontend', () => {
    const f = setup();
    f.shell.press();
    const tool = f.a.devToolsWebContents!;
    const send = vi.fn();
    const target = new EventTarget();
    const context = createContext({
      DevToolsHost: { sendMessageToEmbedder: send },
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    });
    const installed: unknown = runInContext(tool.executeJavaScript.mock.calls[0]![0], context);
    expect(installed).toBe(true);
    const event = new KeyboardEvent('keydown', { key: 'F12', cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', repeat: true }));
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]![0] as string)).toEqual({
      id: 0,
      method: 'closeWindow',
      params: [],
    });
    // A reused frontend replaces the old listener instead of stacking handlers.
    runInContext(tool.executeJavaScript.mock.calls[0]![0], context);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' }));
    expect(send).toHaveBeenCalledTimes(2);
    f.dispose();
    expect(tool.executeJavaScript).toHaveBeenCalledOnce();
    expect(tool.listenerCount('before-input-event')).toBe(0);
  });
  it('closes a tool if its native frontend bridge is missing', async () => {
    const f = setup();
    f.shell.press();
    const tool = f.a.devToolsWebContents!;
    const context = createContext({});
    const ready: unknown = runInContext(tool.executeJavaScript.mock.calls[0]![0], context);
    expect(ready).toBe(false);
    // 第二次打开时模拟该运行时不支持原生桥。
    f.a.closeDevTools();
    const finish = f.a.finishOpen.bind(f.a);
    f.a.openDevTools.mockImplementation(() => {
      f.a.opened = true;
      f.a.devToolsWebContents = new Contents('devtools:');
      f.a.devToolsWebContents.executeJavaScript.mockResolvedValue(false);
      f.a.emit('devtools-opened');
    });
    f.shell.press();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.a.opened).toBe(false);
    expect(f.report).toHaveBeenCalledWith(1, expect.stringContaining('快捷键'));
    f.a.finishOpen = finish;
  });
  it('toggles the current owner page from shell and page; swallows down/up only for F12', async () => {
    const f = setup();
    expect(f.shell.key().preventDefault).toHaveBeenCalledOnce();
    f.shell.key('keyUp');
    expect(f.a.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(f.c.openDevTools).not.toHaveBeenCalled();
    f.a.press();
    expect(f.a.opened).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.a.focus).toHaveBeenCalledOnce();
    expect(f.shell.key('keyDown', false, 'F11').preventDefault).not.toHaveBeenCalled();
  });
  it('ignores held/repeated keys, including repeat after focus moves to native tools', () => {
    const f = setup();
    f.shell.key();
    f.shell.key('keyDown', true);
    f.shell.key('keyDown', true);
    const tool = f.a.devToolsWebContents!;
    tool.key('keyDown', true);
    expect(f.a.openDevTools).toHaveBeenCalledOnce();
    expect(f.a.closeDevTools).not.toHaveBeenCalled();
    f.shell.emit('blur');
    tool.press();
    expect(f.a.opened).toBe(false);
  });
  it('accepts a fresh page press after the tool consumed the previous keyUp', () => {
    const f = setup();
    f.a.key('keyDown');
    f.a.devToolsWebContents!.press();
    expect(f.a.opened).toBe(false);
    f.a.key('keyDown', true);
    expect(f.a.opened).toBe(false);
    f.a.key('keyDown');
    expect(f.a.opened).toBe(true);
    f.dispose();
  });
  it('native F12 closes its bound A while B is active; never retargets or closes B', async () => {
    const f = setup();
    f.shell.press();
    const aTool = f.a.devToolsWebContents!;
    f.tabs.setActive(12);
    f.shell.press();
    expect(f.a.opened).toBe(true);
    expect(f.b.opened).toBe(true);
    aTool.press();
    expect(f.a.opened).toBe(false);
    expect(f.b.opened).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.tabs.getTab(11)?.active).toBe(true);
    expect(aTool.listenerCount('before-input-event')).toBe(0);
  });
  it('each owner chooses its own active tab and closes independently', () => {
    const f = setup();
    f.shell.press();
    f.owners[1]!.browserWindow.webContents.press();
    expect(f.a.opened).toBe(true);
    expect(f.c.opened).toBe(true);
    f.windows.emit('window-closed', 1);
    expect(f.a.opened).toBe(false);
    expect(f.c.opened).toBe(true);
    expect(f.shell.listenerCount('before-input-event')).toBe(0);
  });
  it('returns to the bound page and workspace when its native tool closes', async () => {
    const f = setup();
    f.shell.press();
    const tool = f.a.devToolsWebContents!;
    f.tabList[1]!.workspaceId = 'other';
    f.tabs.setActive(12);
    f.tabs.setActive.mockClear();
    tool.press();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.tabs.setActive).toHaveBeenCalledWith(11);
    expect(f.a.focus).toHaveBeenCalledOnce();
    expect(f.owners[0]!.browserWindow.focus).toHaveBeenCalledOnce();
  });
  it('returns to the owner if the target disappears before deferred focus restoration', async () => {
    const f = setup();
    f.shell.press();
    f.a.devToolsWebContents!.press();
    f.tabList.splice(0, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.owners[0]!.browserWindow.focus).toHaveBeenCalledOnce();
    expect(f.a.focus).not.toHaveBeenCalled();
  });
  it('keeps focus on the owner if the former target became an internal page', async () => {
    const f = setup();
    f.shell.press();
    f.a.devToolsWebContents!.press();
    f.tabList[0]!.url = 'urchin://settings';
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.owners[0]!.browserWindow.focus).toHaveBeenCalledOnce();
    expect(f.a.focus).not.toHaveBeenCalled();
  });
  it.each(['urchin://newtab', 'urchin://settings', 'about:blank', 'data:text/html,test'])(
    'rejects internal/unapproved target %s with a reason',
    (url) => {
      const f = setup();
      f.tabList[0]!.url = url;
      f.shell.press();
      expect(f.a.openDevTools).not.toHaveBeenCalled();
      expect(f.report).toHaveBeenCalledWith(1, expect.any(String));
    },
  );
  it('accepts a new non-repeat press after an unsupported target consumed keyUp', () => {
    const f = setup();
    f.tabList[0]!.url = 'urchin://settings';
    f.shell.key('keyDown');
    f.shell.key('keyDown', true);
    expect(f.report).toHaveBeenCalledOnce();
    f.tabList[0]!.url = 'https://fixture.test/';
    f.shell.key('keyDown');
    expect(f.a.opened).toBe(true);
  });
  it('rejects GenOffice, missing, crashed and not-yet-loaded targets', () => {
    const f = setup();
    f.tabList[0]!.viewKind = 'genoffice';
    f.shell.press();
    f.tabList[0]!.viewKind = 'browser';
    f.a.url = '';
    f.shell.press();
    f.a.url = 'https://fixture.test/';
    f.tabList[0]!.crashed = true;
    f.shell.press();
    f.tabList[0]!.active = false;
    f.shell.press();
    expect(f.a.openDevTools).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledTimes(4);
  });
  it('merges requests while opening/closing and times out an incomplete open so it can retry', () => {
    vi.useFakeTimers();
    const f = setup();
    f.a.deferred = true;
    f.shell.press();
    f.shell.press();
    expect(f.a.openDevTools).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(f.report).toHaveBeenCalledOnce();
    f.a.deferred = false;
    f.shell.press();
    expect(f.a.opened).toBe(true);
    f.a.closeDevTools.mockImplementation(() => {
      /* 模拟异步关闭尚未完成。 */
    });
    f.shell.press();
    f.shell.press();
    expect(f.a.openDevTools).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.a.emit('devtools-closed');
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers from a thrown open without stale listeners or timers', () => {
    vi.useFakeTimers();
    const f = setup();
    f.a.openDevTools.mockImplementationOnce(() => {
      throw new Error('secret URL');
    });
    f.shell.press();
    expect(f.report).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.a.listenerCount('devtools-opened')).toBe(0);
    f.shell.press();
    expect(f.a.opened).toBe(true);
  });
  it('reconciles manual close, reload, crash and target destruction', () => {
    const f = setup();
    f.shell.press();
    f.a.emit('did-navigate');
    expect(f.a.openDevTools).toHaveBeenCalledOnce();
    f.a.closeDevTools();
    f.shell.press();
    expect(f.a.openDevTools).toHaveBeenCalledTimes(2);
    f.a.emit('render-process-gone');
    expect(f.a.opened).toBe(false);
    f.shell.press();
    const tool = f.a.devToolsWebContents!;
    f.a.destroyed = true;
    f.a.emit('destroyed');
    expect(f.a.listenerCount('before-input-event')).toBe(0);
    expect(tool.listenerCount('before-input-event')).toBe(0);
  });
  it('installs new owners and tabs after startup and removes tab listeners on removal', () => {
    const f = setup();
    const owner = {
      id: 3,
      browserWindow: {
        webContents: new Contents(),
        isDestroyed: (): false => false,
        focus: vi.fn(),
      },
    };
    f.owners.push(owner);
    f.windows.emit('window-created', 3);
    const tab = { ...f.tabList[0]!, id: 31, windowId: 3, webContents: new Contents() };
    f.tabList.push(tab);
    f.tabs.emit('created', tab);
    tab.webContents.press();
    expect(tab.webContents.opened).toBe(true);
    f.tabs.emit('removed', tab);
    expect(tab.webContents.opened).toBe(false);
    expect(tab.webContents.listenerCount('before-input-event')).toBe(0);
  });
  it('returns listeners/timers to baseline after 20 switches and idempotent disposal', () => {
    vi.useFakeTimers();
    const f = setup();
    const counts = f.dispose.getDiagnostics();
    const baseline = f.a.eventNames().map((name) => [name, f.a.listenerCount(name)]);
    for (let i = 0; i < 20; i++) {
      f.shell.press();
      f.a.devToolsWebContents!.press();
    }
    vi.runAllTimers();
    expect(f.a.eventNames().map((name) => [name, f.a.listenerCount(name)])).toEqual(baseline);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.dispose.getDiagnostics()).toEqual(counts);
    f.shell.press();
    f.dispose();
    f.dispose();
    expect(f.a.opened).toBe(false);
    expect(f.dispose.getDiagnostics()).toEqual({
      sessions: 0,
      tabInputs: 0,
      windowInputs: 0,
      extraInputs: 0,
      timers: 0,
    });
    expect(f.a.eventNames()).toEqual([]);
    expect(f.shell.eventNames()).toEqual([]);
    expect(f.tabs.eventNames()).toEqual([]);
    expect(f.windows.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
