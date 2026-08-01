/**
 * Summary IPC Handler 注册
 *
 * 职责：
 * 1. summary.listTree：列出保存目录下的文档目录树（供左侧边栏展示）
 * 2. summary.run：一键提取网页内容并保存到本地（提取→清洗→格式化→保存）
 * 3. summary.open：在浏览器新标签页中打开已保存的摘要文档
 * 4. summary.delete：删除已保存的摘要文档
 *
 * 与 pi 模块隔离声明：
 * - summary.run 不调用 pi Agent / Orchestrator / Provider 子进程
 * - summary.run 是纯本地操作：在 BrowserView 页面上下文执行提取脚本，
 *   格式化为自包含 HTML，保存到用户配置的本地目录，不依赖任何 LLM 模型
 * - 参考 web-extractor (Python) 的提取→清洗→格式化流程
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { extractPageContent, formatDocument } from '@urchin/summary-agent';
import type { TabManager } from '../tabs/tab-manager';
import type { WindowManager } from '../windows/window-manager';
import type { SummaryManager } from './summary-manager';

const log = createLogger('summary-ipc');

export interface SummaryHandlerDeps {
  readonly ipcMain: IpcMain;
  readonly summaryManager: SummaryManager;
  readonly tabManager: TabManager;
  readonly windowManager: WindowManager;
}

/**
 * 注册 summary 域 IPC handler。
 */
export function registerSummaryHandlers(deps: SummaryHandlerDeps): void {
  const { ipcMain, summaryManager, tabManager, windowManager } = deps;

  // summary.listTree：列出文档目录树
  registerHandler(ipcMain, 'summary.listTree', async () => {
    const result = await summaryManager.listTree();
    return result;
  });

  // summary.run：一键提取网页内容并保存到本地
  // 流程：提取页面正文 → 清洗 HTML → 格式化为自包含 HTML 文档 → 保存到本地目录
  // 纯本地操作，不依赖 LLM 模型，与 pi 模块完全隔离
  registerHandler(ipcMain, 'summary.run', async (req) => {
    log.info('summary.run', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Tab not found: ${req.tabId}`, {
        channel: 'summary.run',
      });
    }

    const url = tab.webContents.getURL();
    if (!/^https?:\/\//i.test(url)) {
      throw new IpcError(IpcErrorCode.STATE, `Cannot extract non-http(s) page: ${url}`, {
        channel: 'summary.run',
      });
    }

    // 1. 在页面上下文执行提取脚本（提取→清洗→规范化）
    const extraction = await extractPageContent(async (script) => {
      return tab.webContents.executeJavaScript<unknown>(script, true);
    });

    if (!extraction.extracted || !extraction.contentHtml) {
      throw new IpcError(
        IpcErrorCode.INTERNAL,
        `Failed to extract page content (empty result): ${extraction.title || url}`,
        { channel: 'summary.run' },
      );
    }

    log.info('page extracted', {
      tabId: req.tabId,
      title: extraction.title,
      contentLength: extraction.contentText.length,
    });

    // 2. 格式化为自包含 HTML 文档（含元信息与阅读样式）
    const html = formatDocument(extraction);

    // 3. 保存到本地目录（按年月分目录）
    const documentTitle = extraction.title || '无标题';
    const result = await summaryManager.saveDocument(html, documentTitle);

    log.info('summary saved', {
      tabId: req.tabId,
      filePath: result.filePath,
      documentTitle,
    });

    return {
      filePath: result.filePath,
      relativePath: result.relativePath,
      documentTitle: result.documentTitle,
    };
  });

  // summary.open：在浏览器中打开已保存的文档
  registerHandler(ipcMain, 'summary.open', (req) => {
    log.info('summary.open', { absolutePath: req.absolutePath });

    const windows = windowManager.getAllWindows();
    const windowEntry = windows[0];
    if (!windowEntry) {
      throw new IpcError(IpcErrorCode.INTERNAL, 'No browser window available', {
        channel: 'summary.open',
      });
    }

    // 以 file:// 协议在新标签页中打开 HTML 文件
    const fileUrl = `file:///${req.absolutePath.replace(/\\/g, '/')}`;
    const tab = tabManager.create({
      windowId: windowEntry.id,
      url: fileUrl,
      active: true,
    });

    return { ok: true as const, tabId: tab.id };
  });

  // summary.delete：删除已保存的文档
  registerHandler(ipcMain, 'summary.delete', async (req) => {
    log.info('summary.delete', { absolutePath: req.absolutePath });
    await summaryManager.deleteDocument(req.absolutePath);
    return { ok: true as const, absolutePath: req.absolutePath };
  });

  log.info('summary ipc handlers registered');
}
