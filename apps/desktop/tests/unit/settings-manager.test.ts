/**
 * SettingsManager 单元测试。
 *
 * 验证：
 * 1. get：返回默认值 / 不存在的键返回 undefined
 * 2. set：存储新值 / 覆盖已有值 / 触发 'changed' 事件
 * 3. getAll：返回全部条目
 * 4. has：存在返回 true / 不存在返回 false
 * 5. delete：移除条目并触发事件（值为 undefined）
 * 6. 默认设置预填充（theme / searchEngine / homepage 等）
 * 7. events：on/off 监听器注册与移除
 */
import { describe, it, expect, vi } from 'vitest';
import { SettingsManager } from '../../src/main/settings';

describe('SettingsManager', () => {
  // ===== 默认设置预填充 =====

  it('default settings: theme is "light"', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('theme')).toBe('light');
  });

  it('default settings: searchEngine is "google"', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('searchEngine')).toBe('google');
  });

  it('default settings: homepage is "urchin://newtab"', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('homepage')).toBe('urchin://newtab');
  });

  it('default settings: downloadsPath is empty string', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('downloadsPath')).toBe('');
  });

  it('default settings: blockTrackers and doNotTrack are true', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('blockTrackers')).toBe(true);
    expect(mgr.get('doNotTrack')).toBe(true);
  });

  // ===== get 测试 =====

  it('get: returns default value for existing key', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('theme')).toBe('light');
  });

  it('get: returns undefined for non-existent key', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('nonExistentKey')).toBeUndefined();
  });

  // ===== set 测试 =====

  it('set: stores value', () => {
    const mgr = new SettingsManager();

    mgr.set('customKey', 'customValue');

    expect(mgr.get('customKey')).toBe('customValue');
  });

  it('set: overwrites existing value', () => {
    const mgr = new SettingsManager();

    mgr.set('theme', 'dark');

    expect(mgr.get('theme')).toBe('dark');
  });

  it('set: emits changed event with key and value', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();
    mgr.on('changed', listener);

    mgr.set('theme', 'dark');

    expect(listener).toHaveBeenCalledWith('theme', 'dark');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ===== getAll 测试 =====

  it('getAll: returns all entries including defaults', () => {
    const mgr = new SettingsManager();

    mgr.set('customKey', 'customValue');

    const entries = mgr.getAll();

    // 默认 6 项 + 自定义 1 项
    expect(entries).toHaveLength(7);

    const keys = entries.map((e) => e.key);
    expect(keys).toContain('theme');
    expect(keys).toContain('searchEngine');
    expect(keys).toContain('homepage');
    expect(keys).toContain('downloadsPath');
    expect(keys).toContain('blockTrackers');
    expect(keys).toContain('doNotTrack');
    expect(keys).toContain('customKey');
  });

  it('getAll: entries contain key and value fields', () => {
    const mgr = new SettingsManager();

    const entries = mgr.getAll();
    const themeEntry = entries.find((e) => e.key === 'theme');

    expect(themeEntry).toBeDefined();
    expect(themeEntry?.value).toBe('light');
  });

  // ===== has 测试 =====

  it('has: returns true for existing key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('theme')).toBe(true);
  });

  it('has: returns false for non-existent key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('nonExistentKey')).toBe(false);
  });

  // ===== delete 测试 =====

  it('delete: removes key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('theme')).toBe(true);

    const deleted = mgr.delete('theme');

    expect(deleted).toBe(true);
    expect(mgr.has('theme')).toBe(false);
    expect(mgr.get('theme')).toBeUndefined();
  });

  it('delete: returns false for non-existent key', () => {
    const mgr = new SettingsManager();

    const deleted = mgr.delete('nonExistentKey');

    expect(deleted).toBe(false);
  });

  it('delete: emits changed event with undefined value', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();
    mgr.on('changed', listener);

    mgr.delete('theme');

    expect(listener).toHaveBeenCalledWith('theme', undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('delete: does not emit event for non-existent key', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();
    mgr.on('changed', listener);

    mgr.delete('nonExistentKey');

    expect(listener).not.toHaveBeenCalled();
  });

  // ===== events 测试 =====

  it('events: on/off listener registration', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();

    mgr.on('changed', listener);

    mgr.set('theme', 'dark');
    expect(listener).toHaveBeenCalledTimes(1);

    mgr.off('changed', listener);

    mgr.set('theme', 'light');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('events: multiple listeners are all invoked', () => {
    const mgr = new SettingsManager();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    mgr.on('changed', listener1);
    mgr.on('changed', listener2);

    mgr.set('theme', 'dark');

    expect(listener1).toHaveBeenCalledWith('theme', 'dark');
    expect(listener2).toHaveBeenCalledWith('theme', 'dark');
  });

  it('events: set on new key also emits changed', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();
    mgr.on('changed', listener);

    mgr.set('newKey', { nested: 'object' });

    expect(listener).toHaveBeenCalledWith('newKey', { nested: 'object' });
  });
});
