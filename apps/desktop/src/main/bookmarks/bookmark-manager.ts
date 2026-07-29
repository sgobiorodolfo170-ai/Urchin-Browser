/**
 * M5 Bookmarks · 核心类
 *
 * 依据：契约 B §3.1 bookmark.* 通道 / 04-模块全景 M5
 * 职责：
 * 1. 管理书签集合（Map<id, Bookmark>）
 * 2. create / list / search / delete / getCount 方法
 * 3. 文件夹级联删除（递归删除所有后代）
 * 4. 事件分发（created / deleted）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是书签状态的唯一权威源，渲染层 store 只是镜像
 * - 全部方法同步执行（内存操作），持久化由后续 wave 叠加
 * - id / type / createdAt 为 readonly，创建后不可变
 */
import { randomUUID } from 'node:crypto';
import type {
  Bookmark,
  BookmarkCreateOptions,
  BookmarkEvent,
  BookmarkEventListener,
  BookmarkType,
} from './types';

/** 默认搜索结果上限。 */
const DEFAULT_SEARCH_LIMIT = 10;

export class BookmarkManager {
  /** 书签集合：id → Bookmark */
  private readonly entries = new Map<string, Bookmark>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<BookmarkEvent, BookmarkEventListener[]>();

  /**
   * 创建书签 / 文件夹。
   *
   * - parentId 未提供时默认 null（根级）
   * - type 未提供时按 url 推导：有 url 为 'bookmark'，否则 'folder'
   * - position = 同 parentId 下的兄弟节点数（追加到末尾）
   * - 触发 'created' 事件
   *
   * @param opts 创建选项
   * @returns 新建的 Bookmark
   */
  create(opts: BookmarkCreateOptions): Bookmark {
    const parentId: string | null = opts.parentId ?? null;
    const type: BookmarkType = opts.type ?? (opts.url ? 'bookmark' : 'folder');
    const now = Date.now();
    const position = this.countSiblings(parentId);

    const bookmark: Bookmark = {
      id: randomUUID(),
      parentId,
      url: opts.url,
      title: opts.title,
      type,
      position,
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(bookmark.id, bookmark);
    this.emit('created', bookmark);
    return bookmark;
  }

  /**
   * 列出书签。
   *
   * - parentId 为 undefined：返回全部书签
   * - parentId 为 null：返回根级书签
   * - parentId 为 string：返回该父节点的直接子节点
   *
   * 结果按 position 升序排序。
   *
   * @param parentId 父节点 ID（可选）
   * @returns 排序后的 Bookmark 数组
   */
  list(parentId?: string | null): Bookmark[] {
    const all = Array.from(this.entries.values());
    const filtered = parentId === undefined ? all : all.filter((b) => b.parentId === parentId);
    return filtered.sort((a, b) => a.position - b.position);
  }

  /**
   * 搜索书签。
   *
   * 对 title 和 url 字段做大小写不敏感的子串匹配，仅搜索 type='bookmark' 节点。
   * 按 title 升序排序，返回前 limit 条。
   *
   * @param query 搜索关键词
   * @param limit 返回上限（默认 10）
   * @returns 匹配的 Bookmark 数组
   */
  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Bookmark[] {
    const q = query.toLowerCase();
    const matched: Bookmark[] = [];
    for (const bookmark of this.entries.values()) {
      if (bookmark.type !== 'bookmark') continue;
      const inTitle = bookmark.title.toLowerCase().includes(q);
      const inUrl = bookmark.url ? bookmark.url.toLowerCase().includes(q) : false;
      if (inTitle || inUrl) {
        matched.push(bookmark);
      }
    }
    matched.sort((a, b) => a.title.localeCompare(b.title));
    return matched.slice(0, limit);
  }

  /**
   * 删除指定书签 / 文件夹。
   *
   * 若为文件夹，递归删除所有后代节点。每个被删除的节点各触发一次 'deleted' 事件。
   *
   * @param id 要删除的节点 ID
   * @throws 若节点不存在
   */
  delete(id: string): void {
    const bookmark = this.entries.get(id);
    if (!bookmark) {
      throw new Error(`Bookmark not found: ${id}`);
    }
    this.deleteRecursive(id);
  }

  /** 获取节点总数。 */
  getCount(): number {
    return this.entries.size;
  }

  /** 注册事件监听。 */
  on(event: BookmarkEvent, listener: BookmarkEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: BookmarkEvent, listener: BookmarkEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  emit(event: BookmarkEvent, bookmark: Bookmark): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(bookmark);
    }
  }

  /**
   * 统计同 parentId 下的兄弟节点数（用于分配 position）。
   */
  private countSiblings(parentId: string | null): number {
    let count = 0;
    for (const bookmark of this.entries.values()) {
      if (bookmark.parentId === parentId) {
        count++;
      }
    }
    return count;
  }

  /**
   * 递归删除节点及其所有后代（后序：先删子节点，再删自身）。
   */
  private deleteRecursive(id: string): void {
    // 先递归删除所有直接子节点
    const children: Bookmark[] = [];
    for (const bookmark of this.entries.values()) {
      if (bookmark.parentId === id) {
        children.push(bookmark);
      }
    }
    for (const child of children) {
      this.deleteRecursive(child.id);
    }

    // 再删除自身
    const bookmark = this.entries.get(id);
    if (bookmark) {
      this.entries.delete(id);
      this.emit('deleted', bookmark);
    }
  }
}
