/**
 * M2 Tab Manager · Tab IPC Handler 注册
 *
 * 依据：契约 B §3.1 tab.* 通道 / 契约 D §2 / 04-模块全景 M2/M17
 * 职责：
 * 注册 tab.create / tab.close / tab.list / tab.setActive /
 *      tab.reload / tab.goBack / tab.goForward IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 TabManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 * - reload/goBack/goForward 直接调用 webContents，M3 Navigation Stack 将增加事件与状态同步
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { TabManager } from './tab-manager';

const log = createLogger('tab-ipc');

/**
 * 注册 tab 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param tabManager TabManager 实例
 */
export function registerTabHandlers(ipcMain: IpcMain, tabManager: TabManager): void {
  // tab.create：创建新标签
  registerHandler(ipcMain, 'tab.create', (req) => {
    log.info('tab.create', { windowId: req.windowId, url: req.url });

    const tab = tabManager.create({
      windowId: req.windowId,
      url: req.url,
      active: req.active,
      index: req.index,
    });

    const snapshot = tabManager.getSnapshot(tab.id);
    if (!snapshot) {
      throw new Error(`Failed to snapshot newly created tab ${tab.id}`);
    }

    return { tab: snapshot };
  });

  // tab.close：关闭指定标签
  registerHandler(ipcMain, 'tab.close', (req) => {
    log.info('tab.close', { tabId: req.tabId });

    tabManager.remove(req.tabId);

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.list：查询标签列表
  registerHandler(ipcMain, 'tab.list', (req) => {
    log.info('tab.list', { windowId: req.windowId });

    const tabs = tabManager.query({ windowId: req.windowId });

    return { tabs };
  });

  // tab.setActive：激活指定标签
  registerHandler(ipcMain, 'tab.setActive', (req) => {
    log.info('tab.setActive', { tabId: req.tabId });

    tabManager.setActive(req.tabId);

    const snapshot = tabManager.getSnapshot(req.tabId);
    if (!snapshot) {
      throw new Error(`Tab not found after setActive: ${req.tabId}`);
    }

    return { tab: snapshot };
  });

  // tab.reload：重新加载标签
  registerHandler(ipcMain, 'tab.reload', (req) => {
    log.info('tab.reload', { tabId: req.tabId, ignoreCache: req.ignoreCache });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (req.ignoreCache) {
      tab.webContents.reloadIgnoringCache();
    } else {
      tab.webContents.reload();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.goBack：后退
  registerHandler(ipcMain, 'tab.goBack', (req) => {
    log.info('tab.goBack', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (tab.canGoBack) {
      tab.webContents.goBack();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.goForward：前进
  registerHandler(ipcMain, 'tab.goForward', (req) => {
    log.info('tab.goForward', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (tab.canGoForward) {
      tab.webContents.goForward();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  log.info('tab ipc handlers registered');
}
