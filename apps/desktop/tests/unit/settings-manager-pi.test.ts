/**
 * SettingsManager · pi 键路由单元测试（DD1 决策）
 *
 * 验证：
 * 1. isPiSettingKey 判定（ai.* / summary.* 归 pi，其余不归）
 * 2. pi 键 set/delete 写入 pi 库 + pi 密钥存储（非 pi 键走主库）
 * 3. 未注入 pi 存储时回退主存储（向后兼容）
 * 4. legacyPiKeysScan 迁移旧主库残留 pi 键到 pi 库
 */

import { describe, it, expect, vi } from 'vitest';
import { SettingsManager, isPiSettingKey } from '../../src/main/settings/settings-manager';
import type { SecretStore } from '../../src/main/storage/types';

function createStoreMock() {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

function createSecretMock(): SecretStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('isPiSettingKey', () => {
  it('should classify ai.* and summary.* as pi keys', () => {
    expect(isPiSettingKey('ai.model')).toBe(true);
    expect(isPiSettingKey('ai.apiKey')).toBe(true);
    expect(isPiSettingKey('summary.saveDirectory')).toBe(true);
    expect(isPiSettingKey('theme')).toBe(false);
    expect(isPiSettingKey('downloadsPath')).toBe(false);
    expect(isPiSettingKey('data.directory')).toBe(false);
  });
});

describe('SettingsManager pi routing', () => {
  it('should persist pi key to pi store and non-pi key to main store', () => {
    const main = createStoreMock();
    const pi = createStoreMock();
    const mgr = new SettingsManager(main, undefined, { piPersistence: pi });

    mgr.set('ai.model', 'gpt-4o');
    mgr.set('theme', 'dark');

    expect(pi.set).toHaveBeenCalledWith('settings:ai.model', 'gpt-4o');
    expect(main.set).toHaveBeenCalledWith('settings:theme', 'dark');
    // pi 键不落主库
    expect(main.set).not.toHaveBeenCalledWith('settings:ai.model', expect.anything());
  });

  it('should load pi keys from pi store during construction', () => {
    const main = createStoreMock();
    const pi = createStoreMock();
    pi.get.mockImplementation((key: string) => {
      if (key === 'settings:ai.model') return 'claude-3';
      return null;
    });
    const mgr = new SettingsManager(main, undefined, { piPersistence: pi });

    expect(mgr.get('ai.model')).toBe('claude-3');
    expect(pi.get).toHaveBeenCalledWith('settings:ai.model');
  });

  it('should write pi secret key to pi secret store when provided', async () => {
    const mainSecret = createSecretMock();
    const piSecret = createSecretMock();
    const mgr = new SettingsManager(createStoreMock(), mainSecret, { piSecretStore: piSecret });

    mgr.set('ai.apiKey', 'sk-pi');
    await vi.waitFor(() => expect(piSecret.set).toHaveBeenCalled());
    expect(piSecret.set).toHaveBeenCalledWith('settings/ai_apiKey', 'sk-pi');
    expect(mainSecret.set).not.toHaveBeenCalled();
  });

  it('should fall back to main store for pi keys when pi store not injected', () => {
    const main = createStoreMock();
    const mgr = new SettingsManager(main);

    mgr.set('summary.saveDirectory', 'D:\\sum');
    expect(main.set).toHaveBeenCalledWith('settings:summary.saveDirectory', 'D:\\sum');
  });

  it('should migrate legacy pi keys from main store to pi store via legacyPiKeysScan', () => {
    const main = createStoreMock();
    const pi = createStoreMock();
    const legacy = [{ key: 'settings:ai.model', value: 'gpt-4o-mini' }];
    const mgr = new SettingsManager(main, undefined, {
      piPersistence: pi,
      legacyPiKeysScan: () => legacy,
    });

    expect(pi.set).toHaveBeenCalledWith('settings:ai.model', 'gpt-4o-mini');
    expect(main.delete).toHaveBeenCalledWith('settings:ai.model');
    expect(mgr.get('ai.model')).toBe('gpt-4o-mini');
  });
});
