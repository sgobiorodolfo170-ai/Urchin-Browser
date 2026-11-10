/**
 * Import 域 · 导入树写入 BookmarkManager
 *
 * 职责：把解析出的 ImportTreeNode 树写入 BookmarkManager。
 *
 * 2026-11-10 用户修订（IM1 变更）：不再新建「导入自 <来源> (日期)」根文件夹，
 * 解析树的顶层节点直接放入收藏夹根目录，完整保留源目录层级（如 Chrome 的
 * 「书签栏 / 其他书签」、Firefox 的「书签工具栏 / 书签菜单」）。
 *
 * 设计理由（AGENTS.md §七.2 + §六 Single Source of Truth）：
 * - 主进程是书签状态唯一权威源；导入直接调 BookmarkManager.create（持久化 + 广播）
 * - 不去重：与用户现有收藏夹同级共存；重复导入会产生同名目录（由用户自行整理）
 * - 跳过空标题书签与非法 url（url 必须含协议），计入 skipped 计数
 */
import type { BookmarkManager } from '../bookmarks';
import type { ImportSummary } from '@urchin/ipc-contract';
import type { ImportTreeNode } from './types';

/** 简单 url 合法化：必须含 scheme（http/https/ftp/file/urchin 等），拒绝 javascript:/data: 等危险协议。 */
const DANGEROUS_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:']);

function isValidBookmarkUrl(url: string | undefined): url is string {
  if (!url || url.length === 0 || url.length > 8192) return false;
  const colon = url.indexOf(':');
  if (colon <= 0) return false;
  const scheme = url.slice(0, colon + 1).toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) return false;
  return true;
}

/** 可变计数容器（递归写入期间累加）。 */
interface ImportCounters {
  folders: number;
  bookmarks: number;
  skipped: number;
}

/**
 * 把导入树写入 BookmarkManager（顶层节点直接挂根目录）。
 *
 * @param manager BookmarkManager 实例（注入便于测试）
 * @param parsed 解析器输出（树根；root.children 为源浏览器的顶层目录/书签）
 * @returns 导入摘要（folders/bookmarks/skipped）
 */
export function importTreeIntoBookmarks(
  manager: BookmarkManager,
  parsed: { root: ImportTreeNode },
): ImportSummary {
  const counters: ImportCounters = { folders: 0, bookmarks: 0, skipped: 0 };

  for (const child of parsed.root.children ?? []) {
    walkNode(manager, child, null, counters);
  }

  return {
    folders: counters.folders,
    bookmarks: counters.bookmarks,
    skipped: counters.skipped,
  };
}

/** 递归写入单节点（书签 / 文件夹）；parentId=null 表示收藏夹根目录。 */
function walkNode(
  manager: BookmarkManager,
  node: ImportTreeNode,
  parentId: string | null,
  counters: ImportCounters,
): void {
  if (node.url !== undefined) {
    // 书签：空标题或非法 url 跳过
    if (!node.title || !isValidBookmarkUrl(node.url)) {
      counters.skipped += 1;
      return;
    }
    manager.create({ title: node.title, url: node.url, parentId });
    counters.bookmarks += 1;
    return;
  }

  // 文件夹
  const folder = manager.create({
    title: node.title || '未命名文件夹',
    type: 'folder',
    parentId,
  });
  counters.folders += 1;
  for (const child of node.children ?? []) {
    walkNode(manager, child, folder.id, counters);
  }
}
