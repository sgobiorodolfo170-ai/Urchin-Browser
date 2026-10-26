/**
 * Import 域 · 类型定义（D · dev.119）
 *
 * 依据：ipc-schema Import 域 / 04-模块全景（非编号能力登记）
 *
 * 设计理由（agents.md §七.2）：
 * - 导入树节点（ImportTreeNode）与 BookmarkManager.create 对齐：
 *   有 url → 书签；无 url → 文件夹（children 递归）
 * - 解析器输出纯数据树，不直接调 BookmarkManager；导入写入由 import-bookmarks.ts 收口
 *   （便于单测：解析器纯函数可独立验证，写入逻辑可注入 mock manager）
 */
import type { BrowserKind, ImportedBrowser, ImportSummary } from '@urchin/ipc-contract';

export type { BrowserKind, ImportedBrowser, ImportSummary };

/**
 * 导入树节点。
 * - 有 url：书签节点（无 children）
 * - 无 url：文件夹节点（children 递归）
 *
 * 与 BookmarkManager.create 的 BookmarkCreateOptions 字段对齐，便于递归写入。
 */
export interface ImportTreeNode {
  /** 节点标题（书签与文件夹共用） */
  readonly title: string;
  /** URL（仅书签节点有意义；undefined → 文件夹） */
  readonly url?: string;
  /** 子节点（仅文件夹节点有意义） */
  readonly children?: readonly ImportTreeNode[];
}

/** 解析器产出：根节点 + 来源名（用于根文件夹标题「导入自 <来源> (<日期>)」）。 */
export interface ParsedBookmarks {
  /** 来源显示名（如 "Google Chrome" / "书签文件"） */
  readonly sourceName: string;
  /** 解析后的树根（根节点本身是容器，其 children 为顶级书签/文件夹） */
  readonly root: ImportTreeNode;
}
