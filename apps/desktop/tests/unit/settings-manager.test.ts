/**
 * SettingsManager 单元测试。
 *
 * 验证：
 * 1. get：返回默认值 / 不存在的键返回 undefined
 * 2. set：存储新值 / 覆盖已有值 / 触发 'changed' 事件
 * 3. getAll：返回全部条目
 * 4. has：存在返回 true / 不存在返回 false
 * 5. delete：移除条目并触发事件（值为 undefined）
 * 6. 默认设置预填充（searchEngine / language 等）
 * 7. events：on/off 监听器注册与移除
 */
import { describe, it, expect, vi } from 'vitest';
import { SettingsManager } from '../../src/main/settings';

describe('SettingsManager', () => {
  // ===== 默认设置预填充 =====

  it('default settings: searchEngine is "google"', () => {
    const mgr = new SettingsManager();

    expect(mgr.get('searchEngine')).toBe('google');
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

    expect(mgr.get('language')).toBe('zh-CN');
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

    mgr.set('language', 'en-US');

    expect(mgr.get('language')).toBe('en-US');
  });

  it('set: emits changed event with key and value', () => {
    const mgr = new SettingsManager();
    const listener = vi.fn();
    mgr.on('changed', listener);

    mgr.set('language', 'en-US');

    expect(listener).toHaveBeenCalledWith('language', 'en-US');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ===== getAll 测试 =====

  it('getAll: returns all entries including defaults', () => {
    const mgr = new SettingsManager();

    mgr.set('customKey', 'customValue');

    const entries = mgr.getAll();

    // 默认 18 项（language/searchEngine/downloadsPath/data.directory/blockTrackers/doNotTrack/blockAds/links.openInNewTab/
    //   ai.model/ai.apiKey/ai.providerId/ai.baseUrl/ai.providerProfiles/
    //   summary.model/summary.apiKey/summary.providerId/summary.baseUrl/
    //   debug.sidebarHoverDelay/ui.rightSidebarAutoExpand/home.frequentSites） + 自定义 1 项
    expect(entries).toHaveLength(21);

    const keys = entries.map((e) => e.key);
    expect(keys).toContain('language');
    expect(keys).toContain('searchEngine');
    expect(keys).toContain('downloadsPath');
    expect(keys).toContain('data.directory');
    expect(keys).toContain('blockTrackers');
    expect(keys).toContain('doNotTrack');
    expect(keys).toContain('blockAds');
    expect(keys).toContain('links.openInNewTab');
    expect(keys).toContain('ai.model');
    expect(keys).toContain('ai.apiKey');
    expect(keys).toContain('ai.providerId');
    expect(keys).toContain('ai.baseUrl');
    expect(keys).toContain('ai.providerProfiles');
    expect(keys).toContain('summary.model');
    expect(keys).toContain('summary.apiKey');
    expect(keys).toContain('summary.providerId');
    expect(keys).toContain('summary.baseUrl');
    expect(keys).toContain('customKey');
  });

  it('getAll: entries contain key and value fields', () => {
    const mgr = new SettingsManager();

    const entries = mgr.getAll();
    const langEntry = entries.find((e) => e.key === 'language');

    expect(langEntry).toBeDefined();
    expect(langEntry?.value).toBe('zh-CN');
  });

  // ===== has 测试 =====

  it('has: returns true for existing key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('language')).toBe(true);
  });

  it('has: returns false for non-existent key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('nonExistentKey')).toBe(false);
  });

  // ===== delete 测试 =====

  it('delete: removes key', () => {
    const mgr = new SettingsManager();

    expect(mgr.has('language')).toBe(true);

    const deleted = mgr.delete('language');

    expect(deleted).toBe(true);
    expect(mgr.has('language')).toBe(false);
    expect(mgr.get('language')).toBeUndefined();
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

    mgr.delete('language');

    expect(listener).toHaveBeenCalledWith('language', undefined);
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

  // ===== persistence 测试 =====

  it('set: persists via persistence when provided', () => {
    const persistSet = vi.fn();
    const mgr = new SettingsManager({ get: vi.fn().mockReturnValue(null), set: persistSet });

    mgr.set('theme', 'dark');

    expect(persistSet).toHaveBeenCalledWith('settings:theme', 'dark');
  });

  it('set: swallows persistence error gracefully', () => {
    const persistSet = vi.fn().mockImplementation(() => {
      throw new Error('disk full');
    });
    const mgr = new SettingsManager({ get: vi.fn().mockReturnValue(null), set: persistSet });

    expect(() => mgr.set('theme', 'dark')).not.toThrow();
    expect(mgr.get('theme')).toBe('dark');
  });

  it('delete: persists deletion when persistence has delete method', () => {
    const persistDelete = vi.fn();
    const mgr = new SettingsManager({
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: persistDelete,
    });

    mgr.delete('language');

    expect(persistDelete).toHaveBeenCalledWith('settings:language');
  });

  it('delete: swallows persistence delete error gracefully', () => {
    const persistDelete = vi.fn().mockImplementation(() => {
      throw new Error('disk full');
    });
    const mgr = new SettingsManager({
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: persistDelete,
    });

    expect(() => mgr.delete('theme')).not.toThrow();
    expect(mgr.has('theme')).toBe(false);
  });

  it('delete: does not call persistence.delete when method absent', () => {
    const persistSet = vi.fn();
    const mgr = new SettingsManager({ get: vi.fn().mockReturnValue(null), set: persistSet });

    expect(() => mgr.delete('theme')).not.toThrow();
  });

  // ===== secretStore（safeStorage 加密）测试 =====
  // 回归：2026-08-14 修复——settings key 含点号（ai.apiKey）不合法 ST6 白名单，
  // secret name 需做 `settings/<点转下划线>` 映射，否则读写抛 Invalid secret name 导致 apiKey 无法落盘。

  function createSecretStoreMock() {
    return {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('secret: set writes apiKey to secretStore with dot-free mapped name', async () => {
    const secretStore = createSecretStoreMock();
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    mgr.set('ai.apiKey', 'sk-test-123');
    // 等 fire-and-forget 的异步 set 完成
    await vi.waitFor(() => expect(secretStore.set).toHaveBeenCalled());

    expect(secretStore.set).toHaveBeenCalledWith('settings/ai_apiKey', 'sk-test-123');
  });

  it('secret: set with dot-free name must not throw (ST6 白名单校验)', () => {
    const secretStore = createSecretStoreMock();
    secretStore.set.mockRejectedValue(new Error('boom'));
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    // 失败仅记日志不抛（fire-and-forget .catch）
    expect(() => mgr.set('ai.apiKey', 'x')).not.toThrow();
  });

  it('secret: delete removes mapped name from secretStore', async () => {
    const secretStore = createSecretStoreMock();
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    mgr.delete('ai.apiKey');
    await vi.waitFor(() => expect(secretStore.delete).toHaveBeenCalled());
    expect(secretStore.delete).toHaveBeenCalledWith('settings/ai_apiKey');
  });

  it('secret: preload loads apiKey from mapped name', async () => {
    const secretStore = createSecretStoreMock();
    secretStore.get.mockResolvedValue('sk-preloaded');
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    await mgr.ensureSecretsLoaded();
    expect(secretStore.get).toHaveBeenCalledWith('settings/ai_apiKey');
    expect(secretStore.get).toHaveBeenCalledWith('settings/summary_apiKey');
    expect(secretStore.get).toHaveBeenCalledWith('settings/ai_providerProfiles');
    expect(mgr.get('ai.apiKey')).toBe('sk-preloaded');
  });

  // ===== 命名提供商配置（ai.providerProfiles，整体加密落盘）测试 =====

  it('secret: providerProfiles set writes JSON to secretStore, not plaintext SQLite', async () => {
    const secretStore = createSecretStoreMock();
    const persistSet = vi.fn();
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: persistSet },
      secretStore,
    );

    const profiles = [
      {
        id: 'p1',
        name: '公司 OpenAI',
        model: 'gpt-4o',
        apiKey: 'sk-secret',
        baseUrl: 'https://api.openai.com/v1',
      },
    ];
    mgr.set('ai.providerProfiles', profiles);
    await vi.waitFor(() => expect(secretStore.set).toHaveBeenCalled());

    expect(secretStore.set).toHaveBeenCalledWith(
      'settings/ai_providerProfiles',
      JSON.stringify(profiles),
    );
    // 敏感键不落明文 SQLite（persistSet 永不被调用）
    expect(persistSet).not.toHaveBeenCalledWith('settings:ai.providerProfiles', expect.anything());
    expect(mgr.get('ai.providerProfiles')).toEqual(profiles);
  });

  it('secret: providerProfiles preload parses JSON back into array', () => {
    const secretStore = createSecretStoreMock();
    const profiles = [
      {
        id: 'p1',
        name: '公司 OpenAI',
        model: 'gpt-4o',
        apiKey: 'sk-secret',
        baseUrl: 'https://api.openai.com/v1',
      },
    ];
    secretStore.get.mockImplementation((name: string) =>
      Promise.resolve(name === 'settings/ai_providerProfiles' ? JSON.stringify(profiles) : null),
    );
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    return mgr.ensureSecretsLoaded().then(() => {
      expect(mgr.get('ai.providerProfiles')).toEqual(profiles);
    });
  });

  it('secret: providerProfiles delete removes mapped name from secretStore', async () => {
    const secretStore = createSecretStoreMock();
    const mgr = new SettingsManager(
      { get: vi.fn().mockReturnValue(null), set: vi.fn() },
      secretStore,
    );

    mgr.delete('ai.providerProfiles');
    await vi.waitFor(() => expect(secretStore.delete).toHaveBeenCalled());
    expect(secretStore.delete).toHaveBeenCalledWith('settings/ai_providerProfiles');
  });
});
