/**
 * Import 域 · 导入树写入 BookmarkManager
 *
 * 职责：把解析出的 ImportTreeNode 树写入 BookmarkManager，
 * 根目录建「导入自 <来源> (<YYYY-MM-DD>)」文件夹，完整保留原目录结构。
 *
 * 设计理由（AGENTS.md §七.2 + §六 Single Source of Truth）：
 * - 主进程是书签状态唯一权威源；导入直接调 BookmarkManager.create（持久化 + 广播）
 * - 独立文件夹保留结构（用户决策）：导入全部新建，不去重，可整夹删除回退
 * - 跳过空标题书签与非法 url（url 必须含协议），计入 skipped 计数
 * - 不去重：重复执行导入会生成新根文件夹（标题含日期，自然区分）
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

/** 当前日期 YYYY-MM-DD（本地时区，根文件夹标题用）。 */
function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 可变计数容器（递归写入期间累加）。 */
interface ImportCounters {
  folders: number;
  bookmarks: number;
  skipped: number;
}

/**
 * 把导入树写入 BookmarkManager。
 *
 * @param manager BookmarkManager 实例（注入便于测试）
 * @param parsed 解析器输出（来源名 + 树根）
 * @returns 导入摘要（folders/bookmarks/skipped + 根文件夹 id/标题）
 */
export function importTreeIntoBookmarks(
  manager: BookmarkManager,
  parsed: { sourceName: string; root: ImportTreeNode },
): ImportSummary {
  const rootTitle = `导入自 ${parsed.sourceName} (${todayDateString()})`;
  const rootFolder = manager.create({
    title: rootTitle,
    type: 'folder',
    parentId: null,
  });

  const counters: ImportCounters = { folders: 1, bookmarks: 0, skipped: 0 };

  for (const child of parsed.root.children ?? []) {
    walkNode(manager, child, rootFolder.id, counters);
  }

  return {
    folders: counters.folders,
    bookmarks: counters.bookmarks,
    skipped: counters.skipped,
    rootFolderId: rootFolder.id,
    rootFolderTitle: rootTitle,
  };
}

/** 递归写入单节点（书签 / 文件夹）。 */
function walkNode(
  manager: BookmarkManager,
  node: ImportTreeNode,
  parentId: string,
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
