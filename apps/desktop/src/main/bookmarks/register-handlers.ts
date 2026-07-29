/**
 * M5 Bookmarks · Bookmark IPC Handler 注册
 *
 * 依据：契约 B §3.1 bookmark.* 通道 / 04-模块全景 M5/M17
 * 职责：
 * 注册 bookmark.create / bookmark.list / bookmark.search /
 *      bookmark.delete IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 BookmarkManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { BookmarkManager } from './bookmark-manager';

const log = createLogger('bookmark-ipc');

/**
 * 注册 bookmark 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param bookmarkManager BookmarkManager 实例
 */
export function registerBookmarkHandlers(ipcMain: IpcMain, bookmarkManager: BookmarkManager): void {
  // bookmark.create：创建书签 / 文件夹
  registerHandler(ipcMain, 'bookmark.create', (req) => {
    log.info('bookmark.create', { title: req.title, type: req.type });

    const bookmark = bookmarkManager.create({
      url: req.url,
      title: req.title,
      parentId: req.parentId,
      type: req.type,
    });

    return { bookmark };
  });

  // bookmark.list：列出书签
  registerHandler(ipcMain, 'bookmark.list', (req) => {
    log.info('bookmark.list', { parentId: req.parentId });

    const bookmarks = bookmarkManager.list(req.parentId);

    return { bookmarks };
  });

  // bookmark.search：搜索书签
  registerHandler(ipcMain, 'bookmark.search', (req) => {
    log.info('bookmark.search', { query: req.query, limit: req.limit });

    const bookmarks = bookmarkManager.search(req.query, req.limit);

    return { bookmarks };
  });

  // bookmark.delete：删除书签 / 文件夹（级联）
  registerHandler(ipcMain, 'bookmark.delete', (req) => {
    log.info('bookmark.delete', { id: req.id });

    bookmarkManager.delete(req.id);

    return { ok: true as const, id: req.id };
  });

  log.info('bookmark ipc handlers registered');
}
