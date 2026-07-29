/**
 * DownloadManager 单元测试。
 *
 * 验证：
 * 1. create：默认 state=progressing / receivedBytes=0、事件、唯一 ID
 * 2. update：字段更新、updated 事件、completed/cancelled 状态转换与事件、不存在抛异常
 * 3. get：返回条目 / 不存在返回 undefined
 * 4. list：按 startTime 降序
 * 5. cancel：状态变更、endTime、事件、不存在抛异常
 * 6. pause / resume：状态切换与 updated 事件
 * 7. clear：按 id 删除 / 清理已结束项 / 保留 progressing / 返回计数
 * 8. events：on/off 监听器注册与移除
 */
import { describe, it, expect, vi } from 'vitest';
import { DownloadManager } from '../../src/main/downloads';

describe('DownloadManager', () => {
  // ===== create 测试 =====

  it('create: creates item with correct defaults (state=progressing, receivedBytes=0)', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    expect(dl.state).toBe('progressing');
    expect(dl.receivedBytes).toBe(0);
    expect(dl.filename).toBe('file.zip');
    expect(dl.url).toBe('https://example.com/file.zip');
    expect(dl.savePath).toBe('/downloads/file.zip');
    expect(dl.totalBytes).toBe(1024);
    expect(dl.startTime).toBeGreaterThan(0);
    expect(dl.endTime).toBeUndefined();
    expect(dl.id).toBeTruthy();
  });

  it('create: emits "created" event', () => {
    const mgr = new DownloadManager();
    const listener = vi.fn();
    mgr.on('created', listener);

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    expect(listener).toHaveBeenCalledWith(dl);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('create: generates unique IDs', () => {
    const mgr = new DownloadManager();

    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });

    expect(d1.id).not.toBe(d2.id);
    expect(d1.id.length).toBeGreaterThan(0);
    expect(d2.id.length).toBeGreaterThan(0);
  });

  // ===== update 测试 =====

  it('update: updates fields', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const updated = mgr.update(dl.id, { receivedBytes: 512, filename: 'renamed.zip' });

    expect(updated.receivedBytes).toBe(512);
    expect(updated.filename).toBe('renamed.zip');
    expect(updated.id).toBe(dl.id);
    expect(updated.startTime).toBe(dl.startTime);
  });

  it('update: emits "updated" event', () => {
    const mgr = new DownloadManager();
    const listener = vi.fn();
    mgr.on('updated', listener);

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const updated = mgr.update(dl.id, { receivedBytes: 256 });

    expect(listener).toHaveBeenCalledWith(updated);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('update: sets endTime and emits "completed" when state changes to completed', () => {
    const mgr = new DownloadManager();
    const completedListener = vi.fn();
    const updatedListener = vi.fn();
    mgr.on('completed', completedListener);
    mgr.on('updated', updatedListener);

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const updated = mgr.update(dl.id, { state: 'completed', receivedBytes: 1024 });

    expect(updated.state).toBe('completed');
    expect(updated.endTime).toBeGreaterThan(0);
    expect(completedListener).toHaveBeenCalledWith(updated);
    expect(completedListener).toHaveBeenCalledTimes(1);
    // updated 事件也应触发
    expect(updatedListener).toHaveBeenCalledTimes(1);
  });

  it('update: emits "cancelled" when state changes to cancelled', () => {
    const mgr = new DownloadManager();
    const cancelledListener = vi.fn();
    mgr.on('cancelled', cancelledListener);

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const updated = mgr.update(dl.id, { state: 'cancelled' });

    expect(updated.state).toBe('cancelled');
    expect(cancelledListener).toHaveBeenCalledWith(updated);
    expect(cancelledListener).toHaveBeenCalledTimes(1);
  });

  it('update: throws for non-existent id', () => {
    const mgr = new DownloadManager();

    expect(() => mgr.update('non-existent', { receivedBytes: 10 })).toThrow(/not found/i);
  });

  // ===== get 测试 =====

  it('get: returns item', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const found = mgr.get(dl.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(dl.id);
  });

  it('get: returns undefined for non-existent id', () => {
    const mgr = new DownloadManager();

    const found = mgr.get('non-existent');

    expect(found).toBeUndefined();
  });

  // ===== list 测试 =====

  it('list: returns items sorted by startTime desc', () => {
    vi.useFakeTimers();
    const mgr = new DownloadManager();

    vi.setSystemTime(new Date(2024, 0, 1, 10, 0, 0));
    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });

    vi.setSystemTime(new Date(2024, 0, 1, 11, 0, 0));
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });

    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0));
    const d3 = mgr.create({
      filename: 'c.zip',
      url: 'https://c.com/c.zip',
      savePath: '/downloads/c.zip',
      totalBytes: 300,
    });

    const list = mgr.list();

    expect(list).toHaveLength(3);
    expect(list[0]!.id).toBe(d3.id);
    expect(list[1]!.id).toBe(d2.id);
    expect(list[2]!.id).toBe(d1.id);

    vi.useRealTimers();
  });

  // ===== cancel 测试 =====

  it('cancel: sets state to cancelled and endTime', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 10, 0, 0));
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    vi.setSystemTime(new Date(2024, 0, 1, 11, 0, 0));
    const cancelled = mgr.cancel(dl.id);

    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.endTime).toBeGreaterThan(dl.startTime);

    vi.useRealTimers();
  });

  it('cancel: emits "cancelled" event', () => {
    const mgr = new DownloadManager();
    const listener = vi.fn();
    mgr.on('cancelled', listener);

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const cancelled = mgr.cancel(dl.id);

    expect(listener).toHaveBeenCalledWith(cancelled);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cancel: throws for non-existent id', () => {
    const mgr = new DownloadManager();

    expect(() => mgr.cancel('non-existent')).toThrow(/not found/i);
  });

  // ===== pause / resume 测试 =====

  it('pause: sets state to paused', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    const paused = mgr.pause(dl.id);

    expect(paused.state).toBe('paused');
  });

  it('resume: sets state back to progressing', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });

    mgr.pause(dl.id);
    const resumed = mgr.resume(dl.id);

    expect(resumed.state).toBe('progressing');
  });

  // ===== clear 测试 =====

  it('clear: removes specific download by id', () => {
    const mgr = new DownloadManager();

    const dl = mgr.create({
      filename: 'file.zip',
      url: 'https://example.com/file.zip',
      savePath: '/downloads/file.zip',
      totalBytes: 1024,
    });
    expect(mgr.getCount()).toBe(1);

    const deleted = mgr.clear(dl.id);

    expect(deleted).toBe(1);
    expect(mgr.getCount()).toBe(0);
    expect(mgr.get(dl.id)).toBeUndefined();
  });

  it('clear: removes all completed/cancelled/interrupted when no id', () => {
    const mgr = new DownloadManager();

    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });
    const d3 = mgr.create({
      filename: 'c.zip',
      url: 'https://c.com/c.zip',
      savePath: '/downloads/c.zip',
      totalBytes: 300,
    });
    const d4 = mgr.create({
      filename: 'd.zip',
      url: 'https://d.com/d.zip',
      savePath: '/downloads/d.zip',
      totalBytes: 400,
    });

    mgr.update(d1.id, { state: 'completed', receivedBytes: 100 });
    mgr.cancel(d2.id);
    mgr.update(d3.id, { state: 'interrupted' });
    // d4 仍为 progressing

    const deleted = mgr.clear();

    expect(deleted).toBe(3);
    expect(mgr.getCount()).toBe(1);
    expect(mgr.get(d1.id)).toBeUndefined();
    expect(mgr.get(d2.id)).toBeUndefined();
    expect(mgr.get(d3.id)).toBeUndefined();
    expect(mgr.get(d4.id)).toBeDefined();
  });

  it('clear: does not remove progressing downloads when no id', () => {
    const mgr = new DownloadManager();

    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });
    mgr.pause(d2.id);

    const deleted = mgr.clear();

    expect(deleted).toBe(0);
    expect(mgr.getCount()).toBe(2);
    expect(mgr.get(d1.id)).toBeDefined();
    expect(mgr.get(d2.id)).toBeDefined();
  });

  it('clear: returns count of deleted', () => {
    const mgr = new DownloadManager();

    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });
    const d3 = mgr.create({
      filename: 'c.zip',
      url: 'https://c.com/c.zip',
      savePath: '/downloads/c.zip',
      totalBytes: 300,
    });

    mgr.update(d1.id, { state: 'completed', receivedBytes: 100 });
    mgr.update(d2.id, { state: 'completed', receivedBytes: 200 });
    mgr.update(d3.id, { state: 'cancelled' });

    const deleted = mgr.clear();

    expect(deleted).toBe(3);
    expect(mgr.getCount()).toBe(0);
  });

  // ===== events 测试 =====

  it('events: on/off listener registration', () => {
    const mgr = new DownloadManager();
    const listener = vi.fn();

    mgr.on('created', listener);

    mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    mgr.off('created', listener);

    mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear: emits "removed" event for each deleted download', () => {
    const mgr = new DownloadManager();
    const listener = vi.fn();
    mgr.on('removed', listener);

    const d1 = mgr.create({
      filename: 'a.zip',
      url: 'https://a.com/a.zip',
      savePath: '/downloads/a.zip',
      totalBytes: 100,
    });
    const d2 = mgr.create({
      filename: 'b.zip',
      url: 'https://b.com/b.zip',
      savePath: '/downloads/b.zip',
      totalBytes: 200,
    });

    mgr.update(d1.id, { state: 'completed', receivedBytes: 100 });
    mgr.update(d2.id, { state: 'completed', receivedBytes: 200 });

    mgr.clear();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
