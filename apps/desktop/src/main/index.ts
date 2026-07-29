/**
 * Urchin Browser · 主进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / §6 启动顺序
 * 职责（v0.1 W1-D1 最小骨架）：
 * 1. 创建 BrowserWindow（M18 sandbox + contextIsolation）
 * 2. 加载渲染进程入口
 * 3. 注册 IPC handlers（M17，W1-D1 暂用占位 handler 验证链路）
 *
 * 后续 wave 在此基础上叠加 M1/M2/M3/M5-M10/M17/M18/M23 完整实现。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';
import { registerHandler } from '@urchin/ipc-contract';

const log = createLogger('main');

// 单例锁：防止多实例打开（v0.1 简化策略）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * 创建主窗口。
 *
 * 设计理由（agents.md §七.2）：
 * BrowserWindow 的 webPreferences 是 M18 沙箱边界的关键配置。
 * v0.1 即开 sandbox + contextIsolation + preload，从第一天就建立安全基线，
 * 避免后续迁移成本（与 ADR-004「架构一次到位」理念一致）。
 */
function createMainWindow(): BrowserWindow {
  log.info('creating main window');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Urchin Browser',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // 开发模式加载 dev server，生产模式加载打包文件
  const isDev = !app.isPackaged;
  if (isDev) {
    const url = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
    void win.loadURL(url);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
    log.info('main window shown');
  });

  win.on('closed', () => {
    log.info('main window closed');
  });

  return win;
}

/**
 * 注册 IPC handlers（W1-D1 占位，验证链路通）。
 * 真正的 tab/window 业务 handler 在 D2-D4 实现。
 */
function registerIpcHandlers(): void {
  // 占位：返回一个最小 tab 快照证明 IPC 链路通
  registerHandler(ipcMain, 'tab.create', (req) => {
    log.info('ipc tab.create', { windowId: req.windowId, url: req.url });
    return {
      tab: {
        id: 1,
        windowId: req.windowId,
        url: req.url,
        title: 'Urchin',
        active: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        indexInWindow: 0,
      },
    };
  });

  registerHandler(ipcMain, 'tab.list', () => ({
    tabs: [],
  }));

  log.info('ipc handlers registered');
}

// 应用就绪
void app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    // macOS：点击 dock 图标时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// 所有窗口关闭时退出（Windows/Linux）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 全局错误兜底（02-架构设计 §5 错误传播策略）
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
});
