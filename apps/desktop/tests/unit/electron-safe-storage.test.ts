/**
 * Electron safeStorage 适配器单元测试
 *
 * 验证：
 * 1. isEncryptionAvailable 委托 Electron 异步 safeStorage API
 * 2. encryptString 委托 encryptStringAsync
 * 3. decryptString 解包 decryptStringAsync 的 { result, shouldReEncrypt }
 *
 * 2026-11-09 起接口为 async（Electron 45 弃用同步 API、46 移除，见 types.ts 注释）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

import { ElectronSafeStorage } from '../../src/main/storage/electron-safe-storage';
import { safeStorage } from 'electron';

describe('ElectronSafeStorage', () => {
  let storage: ElectronSafeStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new ElectronSafeStorage();
  });

  it('should delegate isEncryptionAvailable to electron async API', async () => {
    (safeStorage.isAsyncEncryptionAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await expect(storage.isEncryptionAvailable()).resolves.toBe(true);
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
  });

  it('should delegate encryptString to encryptStringAsync', async () => {
    const buf = Buffer.from('encrypted');
    (safeStorage.encryptStringAsync as ReturnType<typeof vi.fn>).mockResolvedValue(buf);

    await expect(storage.encryptString('hello')).resolves.toBe(buf);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('hello');
  });

  it('should unwrap decryptStringAsync result', async () => {
    const buf = Buffer.from('encrypted');
    (safeStorage.decryptStringAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: 'hello',
      shouldReEncrypt: false,
    });

    await expect(storage.decryptString(buf)).resolves.toBe('hello');
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledWith(buf);
  });
});
