/**
 * M6 History · 核心类
 *
 * 依据：契约 B §3.1 history.* 通道 / 04-模块全景 M6
 * 职责：
 * 1. 管理历史记录集合（Map<id, HistoryEntry>）
 * 2. URL 索引（Map<url, id>）实现 O(1) 查重
 * 3. record / search / list / delete / clear 方法
 * 4. 事件分发（recorded / deleted / cleared）
 * 5. 持久化到 SQLite（history 表）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是历史状态的唯一权威源，渲染层 store 只是镜像
 * - 内存操作为主，变更时同步写入 SQLite 持久化
 * - visitedAt 为 readonly，更新访问时间通过创建新对象替换实现（不可变优先）
 */
import type { HistoryEntry, HistoryEvent, HistoryEventListener } from './types';

/** 默认搜索结果上限。 */
const DEFAULT_SEARCH_LIMIT = 10;

/** 默认列表结果上限。 */
const DEFAULT_LIST_LIMIT = 100;

/** 默认偏移量。 */
const DEFAULT_LIST_OFFSET = 0;

/** 持久化存储接口（基于 SQLite history 表，便于测试 mock） */
export interface HistoryPersistence {
  /** 加载所有历史记录（启动时调用） */
  loadAll(): HistoryEntry[];
  /** 插入或替换一条历史记录 */
  upsert(entry: HistoryEntry): void;
  /** 删除一条历史记录 */
  remove(id: number): void;
  /** 清空所有历史记录 */
  clearAll(): void;
}

export class HistoryManager {
  /** 历史记录集合：id → HistoryEntry */
  private readonly entries = new Map<number, HistoryEntry>();

  /** URL 索引：url → id（O(1) 查重） */
  private readonly urlIndex = new Map<string, number>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<HistoryEvent, HistoryEventListener[]>();

  /** 下一个分配的 id（单调递增，从 1 开始） */
  private nextId = 1;

  /** 持久化存储（可选，注入后变更时自动写入 SQLite） */
  private readonly persistence?: HistoryPersistence;

  /**
   * 惰性装载标记（启动优化 B4）：false 表示内存集合尚未从 persistence 装载。
   * 未注入 persistence 时天然为 true（无需装载）。
   */
  private loaded: boolean;

  /**
   * 构造时可选注入持久化存储。**不在构造器加载**——首次读取内存集合时
   * 经 ensureLoaded() 一次性装载（含 nextId 恢复；避免大表在启动关键路径上
   * 同步读盘）。
   *
   * @param persistence 可选的持久化存储（StorageLayer.mainStore 的 SQL facade）
   */
  constructor(persistence?: HistoryPersistence) {
    this.persistence = persistence;
    this.loaded = !persistence;
  }

  /**
   * 惰性装载已有历史记录（仅一次）：填充 entries / urlIndex 并恢复 nextId。
   *
   * 设计理由（启动优化 B4）：构造器同步 loadAll 会把「历史表规模 × 磁盘延迟」
   * 计入窗口创建前的关键路径；改为首次访问内存集合时装载，行为对调用方透明。
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const rows = this.persistence?.loadAll() ?? [];
    for (const entry of rows) {
      this.entries.set(entry.id, entry);
      this.urlIndex.set(entry.url, entry.id);
      if (entry.id >= this.nextId) {
        this.nextId = entry.id + 1;
      }
    }
  }

  /**
   * 记录一次 URL 访问。
   *
   * 若 URL 已存在，递增 visitCount、更新 visitedAt 与 title（若提供）；
   * 若为新 URL，创建条目，visitCount=1。触发 'recorded' 事件。
   * 持久化到 SQLite（若注入了 persistence）。
   *
   * @param url 访问的 URL
   * @param title 页面标题（可选）
   * @param favicon 已缓存图标（可选；未到达时后续 setFavicon 补齐）
   * @returns 记录后的 HistoryEntry
   */
  record(url: string, title?: string, favicon?: string): HistoryEntry {
    this.ensureLoaded();
    const existingId = this.urlIndex.get(url);
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId);
      if (existing) {
        // 创建新对象替换（visitedAt 为 readonly，不可就地修改）
        const updated: HistoryEntry = {
          id: existing.id,
          url: existing.url,
          title: title ?? existing.title,
          ...((favicon ?? existing.favicon) ? { favicon: favicon ?? existing.favicon } : {}),
          visitedAt: Date.now(),
          visitCount: existing.visitCount + 1,
        };
        this.entries.set(existingId, updated);
        this.persistence?.upsert(updated);
        this.emit('recorded', updated);
        return updated;
      }
    }

    // 新建条目
    const id = this.nextId++;
    const entry: HistoryEntry = {
      id,
      url,
      title: title ?? '',
      ...(favicon ? { favicon } : {}),
      visitedAt: Date.now(),
      visitCount: 1,
    };
    this.entries.set(id, entry);
    this.urlIndex.set(url, id);
    this.persistence?.upsert(entry);
    this.emit('recorded', entry);
    return entry;
  }

  /**
   * 为已存在的历史记录补齐图标。
   *
   * 图标通常在页面加载完成后才上报，此时 record() 已经写入了条目；
   * 此方法只更新 favicon，不改 visitedAt / visitCount，避免回填图标被误计为一次访问。
   *
   * @param url 历史记录 URL（精确匹配）
   * @param favicon 已缓存图标
   * @returns 是否实际更新
   */
  setFavicon(url: string, favicon: string): boolean {
    this.ensureLoaded();
    const id = this.urlIndex.get(url);
    if (id === undefined) return false;
    const existing = this.entries.get(id);
    if (!existing || existing.favicon === favicon) return false;

    const updated: HistoryEntry = { ...existing, favicon };
    this.entries.set(id, updated);
    this.persistence?.upsert(updated);
    return true;
  }

  /**
   * 搜索历史记录。
   *
   * 对 url 和 title 字段做大小写不敏感的子串匹配。
   * 按 visitCount 降序，再按 visitedAt 降序排序，返回前 limit 条。
   *
   * @param query 搜索关键词
   * @param limit 返回上限（默认 10）
   * @returns 匹配的 HistoryEntry 数组
   */
  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): HistoryEntry[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const matched: HistoryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.url.toLowerCase().includes(q) || entry.title.toLowerCase().includes(q)) {
        matched.push(entry);
      }
    }
    matched.sort((a, b) => {
      if (b.visitCount !== a.visitCount) {
        return b.visitCount - a.visitCount;
      }
      return b.visitedAt - a.visitedAt;
    });
    return matched.slice(0, limit);
  }

  /**
   * 列出历史记录。
   *
   * 按 visitedAt 降序排序，支持分页。返回 { entries, total }。
   *
   * @param limit 返回上限（默认 100）
   * @param offset 偏移量（默认 0）
   * @returns 分页结果与总数
   */
  list(
    limit: number = DEFAULT_LIST_LIMIT,
    offset: number = DEFAULT_LIST_OFFSET,
  ): { entries: HistoryEntry[]; total: number } {
    this.ensureLoaded();
    const all = Array.from(this.entries.values());
    all.sort((a, b) => b.visitedAt - a.visitedAt);
    return {
      entries: all.slice(offset, offset + limit),
      total: all.length,
    };
  }

  /**
   * 删除指定历史记录。
   *
   * @param id 要删除的记录 ID
   * @throws 若记录不存在
   */
  delete(id: number): void {
    this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`History entry not found: ${id}`);
    }
    this.entries.delete(id);
    this.urlIndex.delete(entry.url);
    this.persistence?.remove(id);
    this.emit('deleted', entry);
  }

  /**
   * 清空所有历史记录。
   *
   * @returns 被删除的记录数
   */
  clear(): number {
    this.ensureLoaded();
    const count = this.entries.size;
    this.entries.clear();
    this.urlIndex.clear();
    this.persistence?.clearAll();
    this.emit('cleared');
    return count;
  }

  /** 获取记录总数。 */
  getCount(): number {
    this.ensureLoaded();
    return this.entries.size;
  }

  /** 注册事件监听。 */
  on(event: HistoryEvent, listener: HistoryEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: HistoryEvent, listener: HistoryEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /** 分发事件。 */
  private emit(event: HistoryEvent, entry?: HistoryEntry): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(entry);
    }
  }
}
