/**
 * M8 Storage Layer · SecretStore 单元测试
 *
 * 验证敏感数据加密存储、路径校验、CRUD 操作。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStoreImpl } from '../../src/main/storage/secret-store';
import type { ISafeStorage } from '../../src/main/storage/types';

/** Mock safeStorage：用 UTF-8 Buffer 模拟加密（仅测试用，保证 round-trip） */
class MockSafeStorage implements ISafeStorage {
  isEncryptionAvailable(): boolean {
    return true;
  }
  encryptString(plainText: string): Buffer {
    return Buffer.from(plainText, 'utf-8');
  }
  decryptString(encrypted: Buffer): string {
    return encrypted.toString('utf-8');
  }
}

/** 不可用加密的 Mock */
class UnavailableSafeStorage implements ISafeStorage {
  isEncryptionAvailable(): boolean {
    return false;
  }
  encryptString(): Buffer {
    throw new Error('not available');
  }
  decryptString(): string {
    throw new Error('not available');
  }
}

describe('SecretStoreImpl', () => {
  let dataDir: string;
  let safeStorage: MockSafeStorage;
  let store: SecretStoreImpl;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-secret-test-'));
    safeStorage = new MockSafeStorage();
    store = new SecretStoreImpl(dataDir, safeStorage);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should return null for non-existent secret', async () => {
    const result = await store.get('provider1/api_key');
    expect(result).toBeNull();
  });

  it('should set and get a secret', async () => {
    await store.set('provider1/api_key', 'sk-test-12345');
    const result = await store.get('provider1/api_key');
    expect(result).toBe('sk-test-12345');
  });

  it('should overwrite existing secret', async () => {
    await store.set('provider1/api_key', 'old-key');
    await store.set('provider1/api_key', 'new-key');
    const result = await store.get('provider1/api_key');
    expect(result).toBe('new-key');
  });

  it('should delete a secret', async () => {
    await store.set('provider1/api_key', 'sk-test');
    await store.delete('provider1/api_key');
    const result = await store.get('provider1/api_key');
    expect(result).toBeNull();
  });

  it('should not throw when deleting non-existent secret', async () => {
    await expect(store.delete('provider1/nonexistent')).resolves.toBeUndefined();
  });

  it('should store secrets for different providers separately', async () => {
    await store.set('provider1/api_key', 'key1');
    await store.set('provider2/api_key', 'key2');
    expect(await store.get('provider1/api_key')).toBe('key1');
    expect(await store.get('provider2/api_key')).toBe('key2');
  });

  it('should reject invalid secret name with path traversal', async () => {
    await expect(store.set('../etc/passwd', 'evil')).rejects.toThrow(/Invalid secret name/);
  });

  it('should reject secret name with special characters', async () => {
    await expect(store.set('provider1/api;key', 'value')).rejects.toThrow(/Invalid secret name/);
  });

  it('should reject secret name with spaces', async () => {
    await expect(store.set('provider 1/key', 'value')).rejects.toThrow(/Invalid secret name/);
  });

  it('should accept secret name with hyphens and underscores', async () => {
    await store.set('my-provider/api_key_v2', 'value');
    expect(await store.get('my-provider/api_key_v2')).toBe('value');
  });

  it('should throw when safeStorage is not available on set', async () => {
    const unavailableStore = new SecretStoreImpl(dataDir, new UnavailableSafeStorage());
    await expect(unavailableStore.set('provider1/key', 'value')).rejects.toThrow(
      /safeStorage not available/,
    );
  });

  it('should throw when safeStorage is not available on get', async () => {
    // 先用可用 storage 写入
    await store.set('provider1/api_key', 'sk-test');
    // 切换为不可用 storage 读取
    const unavailableStore = new SecretStoreImpl(dataDir, new UnavailableSafeStorage());
    await expect(unavailableStore.get('provider1/api_key')).rejects.toThrow(
      /safeStorage not available/,
    );
  });
});
