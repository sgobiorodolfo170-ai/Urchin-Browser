/**
 * M5 Bookmarks · 核心类
 *
 * 依据：契约 B §3.1 bookmark.* 通道 / 04-模块全景 M5
 * 职责：
 * 1. 管理书签集合（Map<id, Bookmark>）
 * 2. create / list / search / delete / getCount 方法
 * 3. 文件夹级联删除（递归删除所有后代）
 * 4. 事件分发（created / deleted）
 * 5. 持久化到 SQLite（bookmarks 表）
 *
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是书签状态的唯一权威源，渲染层 store 只是镜像
 * - 内存操作为主，变更时同步写入 SQLite 持久化
 * - id / type / createdAt 为 readonly，创建后不可变
 */
import { randomUUID } from 'node:crypto';
import type {
  Bookmark,
  BookmarkCreateOptions,
  BookmarkEvent,
  BookmarkEventListener,
  BookmarkType,
  BookmarkUpdatePatch,
} from './types';

/** 默认搜索结果上限。 */
const DEFAULT_SEARCH_LIMIT = 10;

/** 持久化存储接口（基于 SQLite bookmarks 表，便于测试 mock） */
export interface BookmarkPersistence {
  /** 加载所有书签（启动时调用） */
  loadAll(): Bookmark[];
  /** 插入或替换一条书签 */
  upsert(bookmark: Bookmark): void;
  /** 删除一条书签 */
  remove(id: string): void;
}

export class BookmarkManager {
  /** 书签集合：id → Bookmark */
  private readonly entries = new Map<string, Bookmark>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<BookmarkEvent, BookmarkEventListener[]>();

  /** 持久化存储（可选，注入后变更时自动写入 SQLite） */
  private readonly persistence?: BookmarkPersistence;

  /**
   * 惰性装载标记（启动优化 B4）：false 表示内存集合尚未从 persistence 装载。
   * 未注入 persistence 时天然为 true（无需装载）。
   */
  private loaded: boolean;

  /**
   * 构造时可选注入持久化存储。**不在构造器加载**——首次读取内存集合时
   * 经 ensureLoaded() 一次性装载（避免大表在启动关键路径上同步读盘）。
   *
   * @param persistence 可选的持久化存储（StorageLayer.mainStore 的 SQL facade）
   */
  constructor(persistence?: BookmarkPersistence) {
    this.persistence = persistence;
    this.loaded = !persistence;
  }

  /**
   * 惰性装载已有书签（仅一次）。
   *
   * 设计理由（启动优化 B4）：构造器同步 loadAll 会把「书签表规模 × 磁盘延迟」
   * 计入窗口创建前的关键路径；改为首次访问内存集合时装载，行为对调用方透明。
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const rows = this.persistence?.loadAll() ?? [];
    for (const bookmark of rows) {
      this.entries.set(bookmark.id, bookmark);
    }
  }

  /**
   * 创建书签 / 文件夹。
   *
   * - parentId 未提供时默认 null（根级）
   * - type 未提供时按 url 推导：有 url 为 'bookmark'，否则 'folder'
   * - position = 同 parentId 下的兄弟节点数（追加到末尾）
   * - 触发 'created' 事件
   * - 持久化到 SQLite（若注入了 persistence）
   *
   * @param opts 创建选项
   * @returns 新建的 Bookmark
   */
  create(opts: BookmarkCreateOptions): Bookmark {
    this.ensureLoaded();
    const parentId: string | null = opts.parentId ?? null;
    const type: BookmarkType = opts.type ?? (opts.url ? 'bookmark' : 'folder');
    const now = Date.now();
    const position = this.countSiblings(parentId);

    const bookmark: Bookmark = {
      id: randomUUID(),
      parentId,
      url: opts.url,
      title: opts.title,
      ...(type === 'bookmark' && opts.favicon ? { favicon: opts.favicon } : {}),
      type,
      position,
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(bookmark.id, bookmark);
    this.persistence?.upsert(bookmark);
    this.emit('created', bookmark);
    return bookmark;
  }

  /**
   * 更新书签节点（重命名 / 改 URL）。
   *
   * 设计理由（收藏夹面板文件夹管理）：
   * - 仅允许修改 title / url；id / type / parentId / position / createdAt 不可变，
   *   保证树结构与排序不被 update 破坏
   * - url 仅对 type='bookmark' 有意义：对文件夹传 url 视为校验错误抛出
   * - patch 为空对象时直接返回原节点（幂等，不触发事件）
   * - 触发 'updated' 事件（主进程订阅后广播 bookmark:changed，面板/星标同步）
   *
   * @param id 节点 ID
   * @param patch 待更新字段（title / url，均可选但至少语义上允许空 patch）
   * @returns 更新后的 Bookmark
   * @throws 若节点不存在，或对文件夹传 url
   */
  update(id: string, patch: BookmarkUpdatePatch): Bookmark {
    this.ensureLoaded();
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Bookmark not found: ${id}`);
    }
    if (existing.type === 'folder' && patch.url !== undefined) {
      throw new Error('Cannot set url on a folder bookmark');
    }
    if (patch.title === undefined && patch.url === undefined) {
      return existing;
    }

    const updated: Bookmark = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      updatedAt: Date.now(),
    };
    this.entries.set(id, updated);
    this.persistence?.upsert(updated);
    this.emit('updated', updated);
    return updated;
  }

  /**
   * 移动书签 / 文件夹到目标文件夹（收藏夹面板「移动到…」入口）。
   *
   * 设计理由（树结构变更与 update 的重命名语义分离，同 ADR 契约层拆通道思路）：
   * - parentId 移动后追加到目标层末尾（position = 目标层兄弟节点数），不动其他兄弟的排序
   * - 目标 parentId=null 表示根级；非 null 时必须存在且为文件夹
   * - 文件夹不可移入自身或其后代（沿目标向上回溯父链做环检测）——否则目标子树
   *   将从整棵树脱离成孤儿，且 list 永远无法再触达这些节点
   * - 目标与当前父级相同视为无操作（幂等返回原节点，不刷 position / 不触发事件）
   * - 成功触发 'updated' 事件（主进程订阅后广播 bookmark:changed，面板/星标同步）
   *
   * @param id 要移动的节点 ID
   * @param parentId 目标父节点 ID（null = 根级）
   * @returns 移动后的 Bookmark（无操作时为原节点）
   * @throws 若节点不存在、目标不存在、目标非文件夹、或文件夹移入自身子树
   */
  move(id: string, parentId: string | null): Bookmark {
    this.ensureLoaded();
    const existing = this.entries.get(id);
    if (!existing) {
      throw new Error(`Bookmark not found: ${id}`);
    }
    if (parentId === existing.parentId) {
      return existing;
    }
    if (parentId !== null) {
      const target = this.entries.get(parentId);
      if (!target) {
        throw new Error(`Bookmark target not found: ${parentId}`);
      }
      if (target.type !== 'folder') {
        throw new Error(`Cannot move into a non-folder bookmark: ${parentId}`);
      }
      // 环检测：从目标沿父链向上回溯，命中被移动节点即为其后代（或自身）
      let cursor: string | null = parentId;
      while (cursor !== null) {
        if (cursor === id) {
          throw new Error('Cannot move a folder into itself or its descendants');
        }
        cursor = this.entries.get(cursor)?.parentId ?? null;
      }
    }

    const updated: Bookmark = {
      ...existing,
      parentId,
      position: this.countSiblings(parentId),
      updatedAt: Date.now(),
    };
    this.entries.set(id, updated);
    this.persistence?.upsert(updated);
    this.emit('updated', updated);
    return updated;
  }

  /**
   * 按 URL 回填已缓存图标（书签先创建、favicon 后到达时使用）。
   *
   * 不改变 position / createdAt，仅更新 favicon 与 updatedAt。返回更新条数，
   * 调用方据此决定是否广播 bookmark:changed。
   *
   * @param url 书签 URL（精确匹配）
   * @param favicon 已缓存的 urchin://favicon/<hash>
   * @returns 实际更新的书签数量
   */
  updateFaviconByUrl(url: string, favicon: string): number {
    this.ensureLoaded();
    let changed = 0;
    for (const bookmark of Array.from(this.entries.values())) {
      if (bookmark.type !== 'bookmark' || bookmark.url !== url) continue;
      if (bookmark.favicon === favicon) continue;
      const updated: Bookmark = {
        ...bookmark,
        favicon,
        updatedAt: Date.now(),
      };
      this.entries.set(bookmark.id, updated);
      this.persistence?.upsert(updated);
      changed += 1;
    }
    return changed;
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
    this.ensureLoaded();
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
    this.ensureLoaded();
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
    this.ensureLoaded();
    const bookmark = this.entries.get(id);
    if (!bookmark) {
      throw new Error(`Bookmark not found: ${id}`);
    }
    this.deleteRecursive(id);
  }

  /** 获取节点总数。 */
  getCount(): number {
    this.ensureLoaded();
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
      this.persistence?.remove(id);
      this.emit('deleted', bookmark);
    }
  }
}
