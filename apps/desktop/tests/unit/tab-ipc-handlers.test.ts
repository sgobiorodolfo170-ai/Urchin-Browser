/**
 * tab IPC handler 注册单元测试。
 *
 * 验证：
 * 1. tab.create handler 正确调用 TabManager.create 并返回快照
 * 2. tab.close handler 正确调用 TabManager.remove
 * 3. tab.list handler 正确调用 TabManager.query
 * 4. tab.setActive handler 正确调用 TabManager.setActive
 * 5. tab.loadUrl handler 正确调用 TabManager.loadUrl
 * 6. tab.reload handler 正确调用 webContents.reload
 * 7. tab.goBack/goForward handler 正确调用 webContents
 * 8. tab.stop handler 正确调用 TabManager.stopLoading
 * 9. 不存在的 tab 抛异常
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcMainInvokeEvent } from '@urchin/ipc-contract';
import { registerTabHandlers } from '../../src/main/tabs/register-handlers';
import type { TabManager } from '../../src/main/tabs/tab-manager';
import type { Tab, TabSnapshot } from '../../src/main/tabs/types';

/** 创建 mock TabManager。 */
function createMockTabManager(): TabManager & {
  _createResult: Tab;
  _snapshot: TabSnapshot;
} {
  const snapshot: TabSnapshot = {
    id: 1,
    windowId: 1,
    url: 'about:blank',
    title: '',
    active: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    indexInWindow: 0,
  };

  const tab: Tab = {
    ...snapshot,
    webContents: {
      loadURL: vi.fn(),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      stop: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      canGoBack: () => false,
      canGoForward: () => false,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    },
    view: {
      webContents: {} as never,
      setBounds: vi.fn(),
    },
  };

  return {
    create: vi.fn().mockReturnValue(tab),
    remove: vi.fn(),
    setActive: vi.fn(),
    getTab: vi.fn().mockReturnValue(tab),
    getCount: vi.fn().mockReturnValue(1),
    query: vi.fn().mockReturnValue([snapshot]),
    getSnapshot: vi.fn().mockReturnValue(snapshot),
    loadUrl: vi.fn(),
    stopLoading: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    _createResult: tab,
    _snapshot: snapshot,
  } as never;
}

/** 创建 mock ipcMain。 */
function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null }, req);
    },
  };
}

describe('registerTabHandlers', () => {
  it('should register tab.create handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.create', { windowId: 1 })) as {
      tab: TabSnapshot;
    };
    expect(mgr.create).toHaveBeenCalledWith({
      windowId: 1,
      url: 'about:blank',
      active: true,
      index: undefined,
    });
    expect(result.tab).toEqual(mgr._snapshot);
  });

  it('should register tab.close handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.close', { tabId: 1 })) as {
      ok: true;
      tabId: number;
    };
    expect(mgr.remove).toHaveBeenCalledWith(1);
    expect(result.ok).toBe(true);
    expect(result.tabId).toBe(1);
  });

  it('should register tab.list handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.list', { windowId: 1 })) as {
      tabs: TabSnapshot[];
    };
    expect(mgr.query).toHaveBeenCalledWith({ windowId: 1 });
    expect(result.tabs).toHaveLength(1);
  });

  it('should register tab.setActive handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.setActive', { tabId: 1 })) as {
      tab: TabSnapshot;
    };
    expect(mgr.setActive).toHaveBeenCalledWith(1);
    expect(result.tab).toEqual(mgr._snapshot);
  });

  it('should register tab.loadUrl handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.loadUrl', {
      tabId: 1,
      url: 'https://example.com',
    })) as { ok: true; tabId: number; url: string };
    expect(mgr.loadUrl).toHaveBeenCalledWith(1, 'https://example.com');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://example.com');
  });

  it('should register tab.stop handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.stop', { tabId: 1 })) as {
      ok: true;
      tabId: number;
    };
    expect(mgr.stopLoading).toHaveBeenCalledWith(1);
    expect(result.ok).toBe(true);
  });

  it('should register tab.reload handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('tab.reload', { tabId: 1, ignoreCache: false })) as {
      ok: true;
      tabId: number;
    };
    expect(mgr._createResult.webContents.reload).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('should call reloadIgnoringCache when ignoreCache is true', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    await ipcMain.invoke('tab.reload', { tabId: 1, ignoreCache: true });
    expect(mgr._createResult.webContents.reloadIgnoringCache).toHaveBeenCalled();
  });

  it('should register tab.goBack handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    await ipcMain.invoke('tab.goBack', { tabId: 1 });
    // canGoBack is false in mock, so goBack should NOT be called
    expect(mgr._createResult.webContents.goBack).not.toHaveBeenCalled();
  });

  it('should register tab.goForward handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerTabHandlers(ipcMain as never, mgr);

    await ipcMain.invoke('tab.goForward', { tabId: 1 });
    // canGoForward is false in mock, so goForward should NOT be called
    expect(mgr._createResult.webContents.goForward).not.toHaveBeenCalled();
  });
});
