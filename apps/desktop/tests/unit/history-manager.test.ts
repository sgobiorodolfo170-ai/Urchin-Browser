/**
 * HistoryManager 单元测试。
 *
 * 验证：
 * 1. record：新建条目 id 单调递增、visitCount=1
 * 2. record：同 URL 递增 visitCount 并更新 visitedAt
 * 3. record：同 URL 更新 title（若提供）
 * 4. search：按 URL / title 匹配，大小写不敏感，尊重 limit，按 visitCount/visitedAt 排序
 * 5. list：按 visitedAt 降序，支持分页，返回正确 total
 * 6. delete：移除条目并触发事件，不存在则抛异常
 * 7. clear：清空所有条目并返回计数，触发 cleared 事件
 * 8. events：on/off 监听器注册与移除
 */
import { describe, it, expect, vi } from 'vitest';
import { HistoryManager } from '../../src/main/history';

describe('HistoryManager', () => {
  // ===== record 测试 =====

  it('record: new URL creates entry with id=1, visitCount=1', () => {
    const mgr = new HistoryManager();

    const entry = mgr.record('https://example.com');

    expect(entry.id).toBe(1);
    expect(entry.visitCount).toBe(1);
    expect(entry.url).toBe('https://example.com');
    expect(entry.title).toBe('');
    expect(entry.visitedAt).toBeGreaterThan(0);
  });

  it('record: same URL increments visitCount and updates visitedAt', () => {
    vi.useFakeTimers();
    const mgr = new HistoryManager();

    vi.setSystemTime(new Date(2024, 0, 1, 10, 0, 0));
    const e1 = mgr.record('https://example.com');
    const oldVisitedAt = e1.visitedAt;

    vi.setSystemTime(new Date(2024, 0, 1, 11, 0, 0));
    const e2 = mgr.record('https://example.com');

    expect(e2.id).toBe(1);
    expect(e2.visitCount).toBe(2);
    expect(e2.visitedAt).toBeGreaterThan(oldVisitedAt);
    expect(mgr.getCount()).toBe(1);

    vi.useRealTimers();
  });

  it('record: same URL updates title if provided', () => {
    const mgr = new HistoryManager();

    mgr.record('https://example.com', 'Old Title');
    const updated = mgr.record('https://example.com', 'New Title');

    expect(updated.title).toBe('New Title');
  });

  it('record: same URL preserves title when not provided', () => {
    const mgr = new HistoryManager();

    mgr.record('https://example.com', 'Original Title');
    const updated = mgr.record('https://example.com');

    expect(updated.title).toBe('Original Title');
  });

  it('record: multiple different URLs get incremental IDs', () => {
    const mgr = new HistoryManager();

    const e1 = mgr.record('https://a.com');
    const e2 = mgr.record('https://b.com');
    const e3 = mgr.record('https://c.com');

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e3.id).toBe(3);
    expect(mgr.getCount()).toBe(3);
  });

  it('record: emits recorded event', () => {
    const mgr = new HistoryManager();
    const listener = vi.fn();
    mgr.on('recorded', listener);

    const entry = mgr.record('https://example.com', 'Example');

    expect(listener).toHaveBeenCalledWith(entry);
  });

  // ===== search 测试 =====

  it('search: returns matching entries by URL', () => {
    const mgr = new HistoryManager();

    mgr.record('https://github.com', 'GitHub');
    mgr.record('https://example.com', 'Example');

    const results = mgr.search('github');

    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://github.com');
  });

  it('search: returns matching entries by title', () => {
    const mgr = new HistoryManager();

    mgr.record('https://a.com', 'GitHub');
    mgr.record('https://b.com', 'GitLab');

    const results = mgr.search('github');

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('GitHub');
  });

  it('search: case-insensitive matching', () => {
    const mgr = new HistoryManager();

    mgr.record('https://GitHub.com', 'GitHub');

    const results = mgr.search('GITHUB');

    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://GitHub.com');
  });

  it('search: respects limit', () => {
    const mgr = new HistoryManager();

    mgr.record('https://a-example.com', 'A');
    mgr.record('https://b-example.com', 'B');
    mgr.record('https://c-example.com', 'C');

    const results = mgr.search('example', 2);

    expect(results).toHaveLength(2);
  });

  it('search: sorts by visitCount desc then visitedAt desc', () => {
    vi.useFakeTimers();
    const mgr = new HistoryManager();

    // A: 09:00 记录（count=1）
    vi.setSystemTime(new Date(2024, 0, 1, 9, 0, 0));
    mgr.record('https://a.example.com', 'A');

    // B: 10:00 记录（count=1）
    vi.setSystemTime(new Date(2024, 0, 1, 10, 0, 0));
    mgr.record('https://b.example.com', 'B');

    // A: 11:00 再次记录（count=2, visitedAt=11:00）
    vi.setSystemTime(new Date(2024, 0, 1, 11, 0, 0));
    mgr.record('https://a.example.com', 'A');

    // C: 08:00 记录两次（count=2, visitedAt=08:00）
    vi.setSystemTime(new Date(2024, 0, 1, 8, 0, 0));
    mgr.record('https://c.example.com', 'C');
    mgr.record('https://c.example.com', 'C');

    const results = mgr.search('example');
    // A: count=2, visitedAt=11:00
    // C: count=2, visitedAt=08:00
    // B: count=1, visitedAt=10:00
    // 预期顺序：A（count=2，最新）→ C（count=2，较早）→ B（count=1）
    expect(results).toHaveLength(3);
    expect(results[0]!.url).toBe('https://a.example.com');
    expect(results[1]!.url).toBe('https://c.example.com');
    expect(results[2]!.url).toBe('https://b.example.com');

    vi.useRealTimers();
  });

  it('search: returns empty for no matches', () => {
    const mgr = new HistoryManager();

    mgr.record('https://example.com', 'Example');

    const results = mgr.search('nonexistent');

    expect(results).toHaveLength(0);
  });

  // ===== list 测试 =====

  it('list: returns entries sorted by visitedAt desc', () => {
    vi.useFakeTimers();
    const mgr = new HistoryManager();

    vi.setSystemTime(new Date(2024, 0, 1, 10, 0, 0));
    mgr.record('https://a.com', 'A');

    vi.setSystemTime(new Date(2024, 0, 1, 11, 0, 0));
    mgr.record('https://b.com', 'B');

    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));
    mgr.record('https://c.com', 'C');

    const { entries } = mgr.list();

    expect(entries).toHaveLength(3);
    expect(entries[0]!.url).toBe('https://c.com');
    expect(entries[1]!.url).toBe('https://b.com');
    expect(entries[2]!.url).toBe('https://a.com');

    vi.useRealTimers();
  });

  it('list: respects limit and offset', () => {
    vi.useFakeTimers();
    const mgr = new HistoryManager();

    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(2024, 0, 1, 10 + i, 0, 0));
      mgr.record(`https://${i}.com`);
    }

    // 按 visitedAt 降序：4(14:00) → 3(13:00) → 2(12:00) → 1(11:00) → 0(10:00)
    // offset=1, limit=2 → 索引 1 和 2 → 3, 2
    const { entries } = mgr.list(2, 1);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.url).toBe('https://3.com');
    expect(entries[1]!.url).toBe('https://2.com');

    vi.useRealTimers();
  });

  it('list: returns correct total count', () => {
    const mgr = new HistoryManager();

    mgr.record('https://a.com');
    mgr.record('https://b.com');
    mgr.record('https://c.com');

    const { total } = mgr.list(1, 0);

    expect(total).toBe(3);
  });

  // ===== delete 测试 =====

  it('delete: removes entry and emits event', () => {
    const mgr = new HistoryManager();
    const listener = vi.fn();
    mgr.on('deleted', listener);

    const entry = mgr.record('https://example.com');
    expect(mgr.getCount()).toBe(1);

    mgr.delete(entry.id);

    expect(mgr.getCount()).toBe(0);
    expect(listener).toHaveBeenCalledWith(entry);
  });

  it('delete: throws for non-existent id', () => {
    const mgr = new HistoryManager();

    expect(() => mgr.delete(999)).toThrow(/not found/i);
  });

  // ===== clear 测试 =====

  it('clear: removes all entries and returns count', () => {
    const mgr = new HistoryManager();

    mgr.record('https://a.com');
    mgr.record('https://b.com');
    mgr.record('https://c.com');

    const deleted = mgr.clear();

    expect(deleted).toBe(3);
    expect(mgr.getCount()).toBe(0);
  });

  it('clear: emits cleared event', () => {
    const mgr = new HistoryManager();
    const listener = vi.fn();
    mgr.on('cleared', listener);

    mgr.record('https://a.com');
    mgr.clear();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ===== events 测试 =====

  it('events: on/off listener registration', () => {
    const mgr = new HistoryManager();
    const listener = vi.fn();

    mgr.on('recorded', listener);

    mgr.record('https://a.com');
    expect(listener).toHaveBeenCalledTimes(1);

    mgr.off('recorded', listener);

    mgr.record('https://b.com');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
