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
      webContents: {
        id: 1,
        send: vi.fn(),
        capturePage: vi.fn().mockResolvedValue({
          isEmpty: () => false,
          toDataURL: () => 'data:image/png;base64,shell',
        }),
      } as never,
    },
    isIncognito: false,
  };

  return {
    createWindow: vi.fn().mockReturnValue(managedWindow),
    closeWindow: vi.fn(),
    getWindow: vi.fn(),
    getWindowByWebContents: vi.fn(),
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

  it('should minimize the window resolved from IPC sender', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(mgr._managedWindow);
    registerWindowHandlers(ipcMain as never, mgr);

    const result = await ipcMain.invoke('window.minimize', {});

    expect(mgr.getWindowByWebContents).toHaveBeenCalledWith(null);
    expect(mgr._managedWindow.browserWindow.minimize).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it('should maximize the window and return the target state', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(mgr._managedWindow);
    registerWindowHandlers(ipcMain as never, mgr);

    const result = await ipcMain.invoke('window.toggleMaximize', {});

    expect(mgr._managedWindow.browserWindow.maximize).toHaveBeenCalled();
    expect(result).toEqual({ maximized: true });
  });

  it('should restore the window when already maximized', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(mgr._managedWindow);
    (mgr._managedWindow.browserWindow.isMaximized as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    registerWindowHandlers(ipcMain as never, mgr);

    const result = await ipcMain.invoke('window.toggleMaximize', {});

    expect(mgr._managedWindow.browserWindow.unmaximize).toHaveBeenCalled();
    expect(result).toEqual({ maximized: false });
  });

  it('should report maximized state for the current window', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(mgr._managedWindow);
    (mgr._managedWindow.browserWindow.isMaximized as ReturnType<typeof vi.fn>).mockReturnValue(
      true,
    );
    registerWindowHandlers(ipcMain as never, mgr);

    const result = await ipcMain.invoke('window.getState', {});

    expect(result).toEqual({ maximized: true });
  });

  it('should return false when no window matches the sender', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    registerWindowHandlers(ipcMain as never, mgr);

    const result = await ipcMain.invoke('window.getState', {});

    expect(result).toEqual({ maximized: false });
  });

  it('should return window UI dataUrl from window.captureUi', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindow as ReturnType<typeof vi.fn>).mockReturnValue(mgr._managedWindow);
    registerWindowHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('window.captureUi', { windowId: 1 })) as {
      dataUrl: string | null;
    };
    expect(result.dataUrl).toBe('data:image/png;base64,shell');
  });

  it('should return null when window.captureUi target window is missing', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockWindowManager();
    (mgr.getWindow as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (mgr.getWindowByWebContents as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    registerWindowHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('window.captureUi', { windowId: 9 })) as {
      dataUrl: string | null;
    };
    expect(result.dataUrl).toBeNull();
  });
});
