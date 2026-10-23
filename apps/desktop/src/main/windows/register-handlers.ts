/**
 * M1 Window Lifecycle · Window IPC Handler 注册
 *
 * 依据：契约 B §3.1 window.create / window.close 通道 / 04-模块全景 M1
 * 职责：
 * 注册窗口生命周期与自绘标题栏控制 IPC handler，通过 WindowManager 管理窗口。
 *
 * 设计理由（agents.md §七.2）：
 * IPC handler 只做协议适配，业务逻辑委托给 WindowManager。
 * 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑。
 */
import type { IpcMain, WebContents } from 'electron';
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

  // 自绘标题栏窗口控制（Windows frameless 窗口）：
  // 以 event.sender 反查当前窗口，避免渲染层传错 windowId（多窗口场景）。
  registerHandler(ipcMain, 'window.minimize', (_req, ctx) => {
    const win = windowManager.getWindowByWebContents(ctx.event.sender)?.browserWindow;
    if (win) {
      win.minimize();
    }
    return { ok: true as const };
  });

  registerHandler(ipcMain, 'window.toggleMaximize', (_req, ctx) => {
    const win = windowManager.getWindowByWebContents(ctx.event.sender)?.browserWindow;
    if (!win) {
      return { maximized: false };
    }
    const wasMaximized = win.isMaximized();
    if (wasMaximized) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    // 直接返回目标状态而非再次 isMaximized()：部分平台在事件循环下一拍才
    // 更新窗口状态，立即查询可能读回旧值，导致标题栏图标与实际窗口不一致。
    return { maximized: !wasMaximized };
  });

  registerHandler(ipcMain, 'window.getState', (_req, ctx) => {
    const win = windowManager.getWindowByWebContents(ctx.event.sender)?.browserWindow;
    return { maximized: win?.isMaximized() ?? false };
  });

  // window.captureUi：抓取窗口渲染层（React UI）截图，供工作区总览页
  // 与标签网页截图合成为「整个浏览器窗口」快照。
  // 说明：BrowserView 属独立视图层，窗口 webContents.capturePage 不含其内容，
  // 调用方需按内容区矩形叠加 tab.captureThumbnail（内部页由 React 渲染则无需叠加）。
  registerHandler(ipcMain, 'window.captureUi', async (req, ctx) => {
    const managed =
      windowManager.getWindow(req.windowId) ??
      windowManager.getWindowByWebContents(ctx.event.sender);
    if (!managed) {
      return { dataUrl: null };
    }
    try {
      // WebContentsLike 是结构化接口（不含 capturePage），运行时即 Electron WebContents
      const wc = managed.browserWindow.webContents as unknown as WebContents;
      const image = await wc.capturePage();
      if (image.isEmpty()) {
        return { dataUrl: null };
      }
      return { dataUrl: image.toDataURL() };
    } catch (err) {
      log.warn('window.captureUi failed', { windowId: req.windowId, error: String(err) });
      return { dataUrl: null };
    }
  });

  log.info('window ipc handlers registered');
}
