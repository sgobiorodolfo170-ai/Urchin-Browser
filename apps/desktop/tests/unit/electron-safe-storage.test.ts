/**
 * Electron safeStorage 适配器单元测试
 *
 * 验证：
 * 1. isEncryptionAvailable 委托 Electron safeStorage
 * 2. encryptString/decryptString 委托 Electron safeStorage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
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

  it('should delegate isEncryptionAvailable to electron', () => {
    (safeStorage.isEncryptionAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(storage.isEncryptionAvailable()).toBe(true);
    expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
  });

  it('should delegate encryptString to electron', () => {
    const buf = Buffer.from('encrypted');
    (safeStorage.encryptString as ReturnType<typeof vi.fn>).mockReturnValue(buf);

    const result = storage.encryptString('hello');

    expect(result).toBe(buf);
    expect(safeStorage.encryptString).toHaveBeenCalledWith('hello');
  });

  it('should delegate decryptString to electron', () => {
    const buf = Buffer.from('encrypted');
    (safeStorage.decryptString as ReturnType<typeof vi.fn>).mockReturnValue('hello');

    const result = storage.decryptString(buf);

    expect(result).toBe('hello');
    expect(safeStorage.decryptString).toHaveBeenCalledWith(buf);
  });
});
