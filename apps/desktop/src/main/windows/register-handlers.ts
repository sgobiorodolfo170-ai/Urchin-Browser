/**
 * M1 Window Lifecycle · Window IPC Handler 注册
 *
 * 依据：契约 B §3.1 window.create / window.close 通道 / 04-模块全景 M1
 * 职责：
 * 注册 window.create / window.close IPC handler，通过 WindowManager 管理窗口生命周期。
 *
 * 设计理由（agents.md §七.2）：
 * IPC handler 只做协议适配，业务逻辑委托给 WindowManager。
 * 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑。
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { WindowManager } from './window-manager';

const log = createLogger('window-ipc');

/**
 * 注册 window 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param windowManager WindowManager 实例
 */
export function registerWindowHandlers(ipcMain: IpcMain, windowManager: WindowManager): void {
  // window.create：创建新窗口
  registerHandler(ipcMain, 'window.create', (req) => {
    log.info('window.create', { incognito: req.incognito, url: req.url });

    const managed = windowManager.createWindow({
      url: req.url,
      incognito: req.incognito,
    });

    return { windowId: managed.id };
  });

  // window.close：关闭指定窗口
  registerHandler(ipcMain, 'window.close', (req) => {
    log.info('window.close', { windowId: req.windowId });

    windowManager.closeWindow(req.windowId);

    return { ok: true as const };
  });

  log.info('window ipc handlers registered');
}
