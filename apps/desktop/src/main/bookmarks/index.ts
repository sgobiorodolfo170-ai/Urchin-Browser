/**
 * M5 Bookmarks · 模块入口
 *
 * 依据：04-模块全景 M5 / 契约 B §3.1 bookmark.* 通道
 */
export { BookmarkManager } from './bookmark-manager';
export { registerBookmarkHandlers } from './register-handlers';
export type {
  Bookmark,
  BookmarkType,
  BookmarkCreateOptions,
  BookmarkSearchOptions,
  BookmarkEvent,
  BookmarkEventListener,
} from './types';
