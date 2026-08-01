/**
 * BrowserWindow 工厂（createBrowserWindow）单元测试
 *
 * 验证：
 * 1. 默认窗口尺寸（1280x800）与最小尺寸（800x600）
 * 2. 自定义尺寸生效
 * 3. M18 安全边界：sandbox / contextIsolation / preload / webSecurity
 * 4. 菜单栏隐藏：setMenuBarVisibility + 移除全局菜单
 * 5. 开发模式 loadURL / 生产模式 loadFile
 * 6. ready-to-show 后 show()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const electronMocks = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  setApplicationMenu: vi.fn(),
  isPackaged: false,
  getAppPath: vi.fn().mockReturnValue('C:\\app'),
  resourcesPath: 'C:\\resources',
}));

vi.mock('electron', () => ({
  BrowserWindow: electronMocks.BrowserWindow,
  Menu: { setApplicationMenu: electronMocks.setApplicationMenu },
  app: {
    get isPackaged() {
      return electronMocks.isPackaged;
    },
    getAppPath: electronMocks.getAppPath,
    get resourcesPath() {
      return electronMocks.resourcesPath;
    },
  },
}));

import { createBrowserWindow } from '../../src/main/windows/create-window';
import { app } from 'electron';

interface WinMock {
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  webContents: { openDevTools: ReturnType<typeof vi.fn> };
  id: number;
}

function makeWinMock(): WinMock {
  return {
    setMenuBarVisibility: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    webContents: { openDevTools: vi.fn() },
    id: 1,
  };
}

let winMock: WinMock;

beforeEach(() => {
  vi.clearAllMocks();
  winMock = makeWinMock();
  electronMocks.BrowserWindow.mockReturnValue(winMock);
  electronMocks.isPackaged = false;
  process.env.NODE_ENV = 'test';
  (process as unknown as { resourcesPath: string }).resourcesPath = 'C:\\resources';
});

afterEach(() => {
  delete (process as unknown as { resourcesPath?: string }).resourcesPath;
});

describe('createBrowserWindow', () => {
  function getWindowArgs(): unknown {
    return electronMocks.BrowserWindow.mock.calls[0]?.[0];
  }

  it('should create window with default size and M18 security', () => {
    createBrowserWindow({});

    const args = getWindowArgs() as {
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      autoHideMenuBar?: boolean;
      webPreferences?: {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        webSecurity?: boolean;
      };
    };

    expect(args).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      autoHideMenuBar: true,
    });
    expect(args?.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });

  it('should use custom size when provided', () => {
    createBrowserWindow({ width: 1024, height: 768 });

    expect(getWindowArgs()).toMatchObject({ width: 1024, height: 768 });
  });

  it('should hide menu bar and remove global menu', () => {
    createBrowserWindow({});

    expect(winMock.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(electronMocks.setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it('should load dev server and open devtools in dev mode', () => {
    createBrowserWindow({});

    expect(winMock.loadURL).toHaveBeenCalled();
    expect(winMock.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(winMock.loadFile).not.toHaveBeenCalled();
  });

  it('should load packaged file in production mode', () => {
    electronMocks.isPackaged = true;
    expect(app.isPackaged).toBe(true);
    createBrowserWindow({});

    expect(winMock.loadFile).toHaveBeenCalled();
    expect(winMock.loadURL).not.toHaveBeenCalled();
    expect(winMock.webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('should show window on ready-to-show', () => {
    createBrowserWindow({});

    const call = (winMock.once.mock.calls as unknown[]).find(
      (c) => (c as [string, unknown])[0] === 'ready-to-show',
    ) as [string, () => void] | undefined;
    call?.[1]();

    expect(winMock.show).toHaveBeenCalled();
  });

  it('should return the BrowserWindow instance', () => {
    const result = createBrowserWindow({});

    expect(result).toBe(winMock);
  });
});
