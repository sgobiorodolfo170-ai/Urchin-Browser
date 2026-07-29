/**
 * M5 Bookmarks · 类型定义
 *
 * 依据：契约 B §3.1 bookmark.* 通道 / 04-模块全景 M5
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「可序列化 / Single Source of Truth」）：
 * - id / type / createdAt 设为 readonly，保证创建后不可变的核心字段稳定
 * - parentId / url / title / position 可变，支持后续重排与重命名
 * - BookmarkEvent / BookmarkEventListener 提供 EventEmitter 模式的类型化事件分发
 */

/**
 * 书签节点类型。
 * - 'bookmark'：具体书签（含 url）
 * - 'folder'：文件夹（可含子节点）
 */
export type BookmarkType = 'bookmark' | 'folder';

/**
 * 书签节点。
 *
 * 同一 parentId 下的兄弟节点按 position 升序排列。
 */
export interface Bookmark {
  /** 节点 ID（crypto.randomUUID 生成，全局唯一） */
  readonly id: string;
  /** 父节点 ID；null 表示根级 */
  parentId: string | null;
  /** URL（仅 type='bookmark' 时有意义） */
  url?: string;
  /** 节点标题 */
  title: string;
  /** 节点类型 */
  readonly type: BookmarkType;
  /** 在同级兄弟中的排序位置（0 起始，升序） */
  position: number;
  /** 创建时间戳（ms） */
  readonly createdAt: number;
  /** 最近更新时间戳（ms） */
  updatedAt: number;
}

/**
 * 创建书签的选项。
 */
export interface BookmarkCreateOptions {
  /** URL（仅书签有意义） */
  readonly url?: string;
  /** 节点标题 */
  readonly title: string;
  /** 父节点 ID；不传或 null 表示根级 */
  readonly parentId?: string | null;
  /** 节点类型；不传时按 url 是否存在推导 */
  readonly type?: BookmarkType;
}

/**
 * 搜索书签的选项。
 */
export interface BookmarkSearchOptions {
  /** 搜索关键词 */
  readonly query: string;
  /** 返回结果上限（默认 10） */
  readonly limit?: number;
}

/**
 * 书签事件类型。
 */
export type BookmarkEvent = 'created' | 'deleted';

/**
 * 书签事件监听器。
 * - 'created'：传入新建的节点
 * - 'deleted'：传入被删除的节点（文件夹级联删除时每个节点各触发一次）
 */
export type BookmarkEventListener = (bookmark: Bookmark) => void;
