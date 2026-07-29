/**
 * Urchin Browser · 主进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / §6 启动顺序 / 04-模块全景 M1/M2/M17/M18
 * 职责（v0.1 W1-D3）：
 * 1. 初始化 WindowManager（M1 Window Lifecycle）
 * 2. 初始化 TabManager（M2 Tab Manager）
 * 3. 创建主窗口（M18 sandbox + contextIsolation + preload）
 * 4. 注册 IPC handlers（M17 tab + window 域）
 * 5. 应用生命周期事件（单实例锁 / activate / window-all-closed）
 *
 * 后续 wave 在此基础上叠加 M3/M5-M10/M23 完整实现。
 */
import { app, ipcMain } from 'electron';
import { createLogger } from '@urchin/logger';
import { WindowManager, createBrowserWindow, registerWindowHandlers } from './windows';
import { TabManager, createBrowserView, registerTabHandlers } from './tabs';
import { HistoryManager, registerHistoryHandlers } from './history';
import { BookmarkManager, registerBookmarkHandlers } from './bookmarks';

const log = createLogger('main');

// 单例锁：防止多实例打开（02-架构设计 §1.2）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * 全局 WindowManager 实例（M1）。
 *
 * 设计理由（agents.md §七.2）：
 * 单例管理所有窗口，保证 windowId 分配的全局唯一性。
 * 通过工厂函数注入，使核心逻辑可测试。
 */
const windowManager = new WindowManager(createBrowserWindow);

/**
 * 全局 TabManager 实例（M2）。
 *
 * 设计理由（契约 D §2 / agents.md §七.2）：
 * 单例管理所有 tab，保证 tabId 分配的全局唯一性。
 * 主进程是 Single Source of Truth，渲染层 store 只是镜像。
 * 通过工厂函数注入，使核心逻辑可测试。
 */
const tabManager = new TabManager(createBrowserView);

/**
 * 全局 HistoryManager 实例（M6）。
 * v0.1 W2 使用内存存储，W3 迁移到 SQLite（M8 Storage Layer）。
 */
const historyManager = new HistoryManager();

/**
 * 全局 BookmarkManager 实例（M5）。
 * v0.1 W2 使用内存存储，W3 迁移到 SQLite（M8 Storage Layer）。
 */
const bookmarkManager = new BookmarkManager();

/**
 * 注册 IPC handlers。
 * W1-D3：tab 域完整实现 + window 域完整实现。
 */
function registerIpcHandlers(): void {
  // M1 window 域 handler
  registerWindowHandlers(ipcMain, windowManager);

  // M2 tab 域 handler
  registerTabHandlers(ipcMain, tabManager);

  // M6 history 域 handler
  registerHistoryHandlers(ipcMain, historyManager);

  // M5 bookmark 域 handler
  registerBookmarkHandlers(ipcMain, bookmarkManager);

  log.info('ipc handlers registered');
}

// 应用就绪
void app.whenReady().then(() => {
  registerIpcHandlers();

  // 创建主窗口
  const mainWindow = windowManager.createWindow({});

  // 为主窗口创建初始 tab
  tabManager.create({ windowId: mainWindow.id });

  // macOS：点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (windowManager.getCount() === 0) {
      const win = windowManager.createWindow({});
      tabManager.create({ windowId: win.id });
    }
  });
});

// 所有窗口关闭时退出（Windows/Linux）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 第二实例聚焦已有窗口（单实例锁配合）
app.on('second-instance', () => {
  const windows = windowManager.getAllWindows();
  if (windows.length > 0) {
    const win = windows[0]!;
    win.browserWindow.show();
    win.browserWindow.restore();
  }
});

// 全局错误兜底（02-架构设计 §5 错误传播策略）
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
});
