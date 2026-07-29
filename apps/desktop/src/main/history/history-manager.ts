/**
 * M6 History · 核心类
 *
 * 依据：契约 B §3.1 history.* 通道 / 04-模块全景 M6
 * 职责：
 * 1. 管理历史记录集合（Map<id, HistoryEntry>）
 * 2. URL 索引（Map<url, id>）实现 O(1) 查重
 * 3. record / search / list / delete / clear 方法
 * 4. 事件分发（recorded / deleted / cleared）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是历史状态的唯一权威源，渲染层 store 只是镜像
 * - 全部方法同步执行（内存操作），持久化由后续 wave 叠加
 * - visitedAt 为 readonly，更新访问时间通过创建新对象替换实现（不可变优先）
 */
import type { HistoryEntry, HistoryEvent, HistoryEventListener } from './types';

/** 默认搜索结果上限。 */
const DEFAULT_SEARCH_LIMIT = 10;

/** 默认列表结果上限。 */
const DEFAULT_LIST_LIMIT = 100;

/** 默认偏移量。 */
const DEFAULT_LIST_OFFSET = 0;

export class HistoryManager {
  /** 历史记录集合：id → HistoryEntry */
  private readonly entries = new Map<number, HistoryEntry>();

  /** URL 索引：url → id（O(1) 查重） */
  private readonly urlIndex = new Map<string, number>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<HistoryEvent, HistoryEventListener[]>();

  /** 下一个分配的 id（单调递增，从 1 开始） */
  private nextId = 1;

  /**
   * 记录一次 URL 访问。
   *
   * 若 URL 已存在，递增 visitCount、更新 visitedAt 与 title（若提供）；
   * 若为新 URL，创建条目，visitCount=1。触发 'recorded' 事件。
   *
   * @param url 访问的 URL
   * @param title 页面标题（可选）
   * @returns 记录后的 HistoryEntry
   */
  record(url: string, title?: string): HistoryEntry {
    const existingId = this.urlIndex.get(url);
    if (existingId !== undefined) {
      const existing = this.entries.get(existingId);
      if (existing) {
        // 创建新对象替换（visitedAt 为 readonly，不可就地修改）
        const updated: HistoryEntry = {
          id: existing.id,
          url: existing.url,
          title: title ?? existing.title,
          visitedAt: Date.now(),
          visitCount: existing.visitCount + 1,
        };
        this.entries.set(existingId, updated);
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
      visitedAt: Date.now(),
      visitCount: 1,
    };
    this.entries.set(id, entry);
    this.urlIndex.set(url, id);
    this.emit('recorded', entry);
    return entry;
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
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(`History entry not found: ${id}`);
    }
    this.entries.delete(id);
    this.urlIndex.delete(entry.url);
    this.emit('deleted', entry);
  }

  /**
   * 清空所有历史记录。
   *
   * @returns 被删除的记录数
   */
  clear(): number {
    const count = this.entries.size;
    this.entries.clear();
    this.urlIndex.clear();
    this.emit('cleared');
    return count;
  }

  /** 获取记录总数。 */
  getCount(): number {
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
