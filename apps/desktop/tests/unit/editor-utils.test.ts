/**
 * 编辑草稿键（draft-key）与防抖自动保存器（auto-saver）单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { draftKey } from '../../src/renderer/files/editor/draft-key';
import { createAutoSaver } from '../../src/renderer/files/editor/auto-saver';

describe('draftKey', () => {
  it('should produce schema-conformant key (letters/digits/hyphen only)', () => {
    for (const p of [
      'C:\\docs\\notes.md',
      'C:\\docs\\笔记.md',
      'D:\\a.b.c\\archive.tar.gz',
      '/home/user/readme.markdown',
      'C:\\',
    ]) {
      expect(draftKey(p)).toMatch(/^[A-Za-z0-9-]{1,80}$/);
    }
  });

  it('should be stable for the same path and differ across paths', () => {
    expect(draftKey('C:\\docs\\a.md')).toBe(draftKey('C:\\docs\\a.md'));
    expect(draftKey('C:\\docs\\a.md')).not.toBe(draftKey('C:\\docs\\b.md'));
    // 同名不同目录也不同（哈希覆盖完整路径）
    expect(draftKey('C:\\docs\\a.md')).not.toBe(draftKey('D:\\docs\\a.md'));
  });

  it('should keep readable basename prefix and length cap', () => {
    expect(draftKey('C:\\docs\\notes.md').startsWith('notes-md-')).toBe(true);
    const long = 'C:\\' + '很'.repeat(200) + '.md';
    expect(draftKey(long).length).toBeLessThanOrEqual(80);
  });
});

describe('createAutoSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should fire flush once after delay', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const saver = createAutoSaver(2000, flush);

    saver.schedule();
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('should debounce repeated schedules into one flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const saver = createAutoSaver(2000, flush);

    saver.schedule();
    await vi.advanceTimersByTimeAsync(1500);
    saver.schedule();
    await vi.advanceTimersByTimeAsync(1500);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('should not fire after cancel', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const saver = createAutoSaver(2000, flush);

    saver.schedule();
    saver.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushNow runs immediately and clears pending timer', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const saver = createAutoSaver(2000, flush);

    saver.schedule();
    expect(saver.hasPending()).toBe(true);
    await saver.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(saver.hasPending()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
