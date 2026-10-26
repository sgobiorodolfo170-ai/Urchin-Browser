/**
 * Import 域入口（D · dev.119）
 *
 * 从其他浏览器导入收藏夹：Netscape HTML 文件 + Chrome/Edge/Firefox profile 自动检测。
 */
export { registerImportHandlers, type ImportHandlerDeps } from './register-handlers';
export { parseNetscapeBookmarksHtml } from './parse-bookmarks-html';
export {
  detectChromiumBrowsers,
  parseChromiumBookmarksJson,
  parseChromiumBookmarksFromProfile,
} from './chromium-profiles';
export {
  detectFirefoxBrowsers,
  buildFirefoxTreeFromRows,
  parseFirefoxPlacesFromProfile,
} from './firefox-profiles';
export { importTreeIntoBookmarks } from './import-bookmarks';
export type { ImportTreeNode, ParsedBookmarks } from './types';
