/**
 * Import 域 · IPC Handler 注册（D · dev.119）
 *
 * 职责：
 * 注册 import.detectBrowsers / import.bookmarksFromFile /
 *      import.bookmarksFromBrowser IPC handler。
 *
 * 设计理由（AGENTS.md §七.2 + §六 可测试性）：
 * - IPC handler 只做协议适配，业务逻辑委托给解析器/导入器
 * - 入参出参由 registerHandler 自动 zod 校验
 * - 全部 I/O 经依赖注入（fs / dialog / better-sqlite3 工厂）便于单测 mock：
 *   detectBrowsers / parseBookmarksHtml / parseChromiumBookmarks / parseFirefoxPlaces /
 *   showOpenDialog / readFileText / getWindowFromSender 均可替换
 * - 隐私：导入路径仅记 basename + 计数，不记 URL 内容（与 files 域隐私约定一致）
 */
import type { IpcMain, BrowserWindow, WebContents } from 'electron';
import { dialog, BrowserWindow as ElectronBrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import type { ImportedBrowser } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { BookmarkManager } from '../bookmarks';
import type { ImportTreeNode } from './types';
import { parseNetscapeBookmarksHtml } from './parse-bookmarks-html';
import { detectChromiumBrowsers, parseChromiumBookmarksFromProfile } from './chromium-profiles';
import { detectFirefoxBrowsers, parseFirefoxPlacesFromProfile } from './firefox-profiles';
import { importTreeIntoBookmarks } from './import-bookmarks';

const log = createLogger('import-ipc');

/** showOpenDialog 返回的简化形状（与 electron dialog 一致，便于 mock）。 */
interface OpenDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

/** 依赖注入接口（生产用 node:fs + electron dialog；单测注入 mock）。 */
export interface ImportHandlerDeps {
  readonly ipcMain: IpcMain;
  readonly bookmarkManager: BookmarkManager;
  /** 弹出文件选择器（默认 electron dialog.showOpenDialog）。 */
  readonly showOpenDialog?: (opts: Electron.OpenDialogOptions) => Promise<OpenDialogResult>;
  /** 读取文本文件（默认 node:fs/promises.readFile）。 */
  readonly readFileText?: (path: string) => Promise<string>;
  /** 检测本机浏览器 profile（默认 chromium + firefox 组合）。 */
  readonly detectBrowsers?: () => ImportedBrowser[];
  /** 解析 Netscape 书签 HTML（默认 parseNetscapeBookmarksHtml，纯函数）。 */
  readonly parseBookmarksHtml?: (html: string) => ImportTreeNode;
  /** 解析 Chromium profile 收藏夹（默认读 Bookmarks JSON）。 */
  readonly parseChromiumBookmarks?: (profileDir: string) => ImportTreeNode;
  /** 解析 Firefox profile places.sqlite（默认复制临时文件只读打开）。 */
  readonly parseFirefoxPlaces?: (profileDir: string) => ImportTreeNode;
  /** 从 IPC sender 反查宿主窗口（默认 BrowserWindow.fromWebContents）。 */
  readonly getWindowFromSender?: (sender: unknown) => BrowserWindow | undefined;
}

/** 默认 detectBrowsers：合并 chromium + firefox 检测结果。 */
function defaultDetectBrowsers(): ImportedBrowser[] {
  return [...detectChromiumBrowsers(), ...detectFirefoxBrowsers()];
}

/**
 * 注册 import 域 IPC handler。
 */
export function registerImportHandlers(deps: ImportHandlerDeps): void {
  const { ipcMain, bookmarkManager } = deps;
  const detect = deps.detectBrowsers ?? defaultDetectBrowsers;
  const parseHtml = deps.parseBookmarksHtml ?? parseNetscapeBookmarksHtml;
  const parseChromium =
    deps.parseChromiumBookmarks ?? ((dir) => parseChromiumBookmarksFromProfile(dir));
  const parseFirefox = deps.parseFirefoxPlaces ?? ((dir) => parseFirefoxPlacesFromProfile(dir));
  const showOpen = deps.showOpenDialog ?? ((opts) => dialog.showOpenDialog(opts));
  const readFileText = deps.readFileText ?? ((p) => readFile(p, 'utf-8'));
  const getWindow =
    deps.getWindowFromSender ??
    ((sender) => ElectronBrowserWindow.fromWebContents(sender as WebContents) ?? undefined);

  // import.detectBrowsers：扫描本机 Chrome/Edge/Firefox，返回可导入 profile 列表
  registerHandler(ipcMain, 'import.detectBrowsers', () => {
    log.info('import.detectBrowsers');
    const browsers = detect();
    return { browsers };
  });

  // import.bookmarksFromFile：弹出文件选择器（html/htm）→ 解析 → 导入
  registerHandler(ipcMain, 'import.bookmarksFromFile', async (_req, ctx) => {
    log.info('import.bookmarksFromFile');
    const win = getWindow(ctx.event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: '选择书签文件',
      filters: [{ name: '书签 HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await showOpen(opts);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const, summary: null };
    }
    const filePath = result.filePaths[0]!;
    log.info('import.bookmarksFromFile selected', { name: basename(filePath) });
    try {
      const html = await readFileText(filePath);
      const tree = parseHtml(html);
      const summary = importTreeIntoBookmarks(bookmarkManager, {
        sourceName: '书签文件',
        root: tree,
      });
      log.info('import.bookmarksFromFile done', {
        folders: summary.folders,
        bookmarks: summary.bookmarks,
        skipped: summary.skipped,
      });
      return { canceled: false as const, summary };
    } catch (e) {
      throw new IpcError(IpcErrorCode.INTERNAL, `导入书签失败: ${String(e)}`, {
        channel: 'import.bookmarksFromFile',
      });
    }
  });

  // import.bookmarksFromBrowser：按 detect 返回的 id 导入指定浏览器 profile
  registerHandler(ipcMain, 'import.bookmarksFromBrowser', (req) => {
    log.info('import.bookmarksFromBrowser', { id: req.id });
    const browsers = detect();
    const target = browsers.find((b) => b.id === req.id);
    if (!target) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `未找到浏览器 profile: ${req.id}`, {
        channel: 'import.bookmarksFromBrowser',
      });
    }
    try {
      const tree =
        target.bookmarksSource === 'chromium-json'
          ? parseChromium(target.profileDir)
          : parseFirefox(target.profileDir);
      const summary = importTreeIntoBookmarks(bookmarkManager, {
        sourceName: target.displayName,
        root: tree,
      });
      log.info('import.bookmarksFromBrowser done', {
        browser: target.displayName,
        profile: target.profileName,
        folders: summary.folders,
        bookmarks: summary.bookmarks,
        skipped: summary.skipped,
      });
      return { canceled: false as const, summary };
    } catch (e) {
      throw new IpcError(IpcErrorCode.INTERNAL, `导入书签失败: ${String(e)}`, {
        channel: 'import.bookmarksFromBrowser',
      });
    }
  });

  log.info('import ipc handlers registered');
}
