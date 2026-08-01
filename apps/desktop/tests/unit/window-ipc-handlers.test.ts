/**
 * window IPC handler 注册单元测试。
 *
 * 验证：
 * 1. window.create handler 正确调用 WindowManager.createWindow
 * 2. window.close handler 正确调用 WindowManager.closeWindow
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcMainInvokeEvent } from '@urchin/ipc-contract';
import { registerWindowHandlers } from '../../src/main/windows/register-handlers';
import type { WindowManager } from '../../src/main/windows/window-manager';
import type { ManagedWindow } from '../../src/main/windows/types';

/** 创建 mock WindowManager。 */
function createMockWindowManager(): WindowManager & {
  _managedWindow: ManagedWindow;
} {
  const managedWindow: ManagedWindow = {
    id: 1,
    browserWindow: {
      show: vi.fn(),
      hide: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      isMaximized: vi.fn().mockReturnValue(false),
      setFullScreen: vi.fn(),
      isFullScreen: vi.fn().mockReturnValue(false),
      restore: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
      getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 770 }),
      setBrowserView: vi.fn(),
      webContents: { id: 1, send: vi.fn() },
    },
    isIncognito: false,
  };

  return {
    createWindow: vi.fn().mockReturnValue(managedWindow),
    closeWindow: vi.fn(),
    getWindow: vi.fn(),
    getAllWindows: vi.fn().mockReturnValue([managedWindow]),
    getCount: vi.fn().mockReturnValue(1),
    on: vi.fn(),
    off: vi.fn(),
    _managedWindow: managedWindow,
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

describe('registerWindowHandlers', () => {
  it('should register window.create handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    registerWindowHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('window.create', { incognito: false })) as {
      windowId: number;
    };
    expect(mgr.createWindow).toHaveBeenCalledWith({ url: undefined, incognito: false });
    expect(result.windowId).toBe(1);
  });

  it('should register window.close handler', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    registerWindowHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('window.close', { windowId: 1 })) as {
      ok: true;
    };
    expect(mgr.closeWindow).toHaveBeenCalledWith(1);
    expect(result.ok).toBe(true);
  });
});
