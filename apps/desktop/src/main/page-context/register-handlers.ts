/**
 * M14 Page Context Extractor · IPC Handler 注册
 *
 * 依据：契约 B §3.1 page.* 通道 / 契约 F §2 抽取流程
 * 职责：
 * 1. page.extract：从指定 tab 抽取页面正文，返回 ExtractedPageContext
 *
 * 设计理由：
 * - IPC handler 只做协议适配，抽取逻辑委托给 PageContextExtractor
 * - 通过 TabManager 拿到 tab.webContents，调用 extractor.extract
 * - 入参出参由 registerHandler 自动 zod 校验
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { TabManager } from '../tabs/tab-manager';
import { PageContextExtractor, DEFAULT_MAX_LENGTH } from './extractor';

const log = createLogger('page-context-ipc');

/**
 * 注册 M14 page 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param tabManager TabManager 实例（用于查找 tab.webContents）
 */
export function registerPageContextHandlers(ipcMain: IpcMain, tabManager: TabManager): void {
  const extractor = new PageContextExtractor();

  // page.extract：抽取指定 tab 的页面正文
  registerHandler(ipcMain, 'page.extract', async (req) => {
    log.info('page.extract', { tabId: req.tabId, maxLength: req.maxLength });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Tab not found: ${req.tabId}`, {
        channel: 'page.extract',
      });
    }

    const maxLength = req.maxLength ?? DEFAULT_MAX_LENGTH;
    const context = await extractor.extract(tab.webContents, maxLength);

    return { context };
  });

  log.info('page context ipc handlers registered');
}
