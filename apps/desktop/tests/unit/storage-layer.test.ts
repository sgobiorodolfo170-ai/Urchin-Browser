/**
 * M8 Storage Layer · StorageLayer 单元测试
 *
 * 验证主库/AI库 KV 存储、命名空间存储、LRU 连接池、迁移机制。
 * 使用 MockDatabase 替代 better-sqlite3 原生模块。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageLayer } from '../../src/main/storage/storage-layer';
import { createMockDatabaseFactory } from '../helpers/mock-database';
import type { ISafeStorage } from '../../src/main/storage/types';

/** Mock safeStorage：用 UTF-8 Buffer 模拟加密（保证 round-trip） */
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

describe('StorageLayer', () => {
  let dataDir: string;
  let storage: StorageLayer;
  let mockFactory: ReturnType<typeof createMockDatabaseFactory>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'urchin-storage-test-'));
    mockFactory = createMockDatabaseFactory();
    storage = new StorageLayer(dataDir, new MockSafeStorage(), mockFactory.factory);
  });

  afterEach(() => {
    storage.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('mainStore', () => {
    it('should return null for non-existent key', () => {
      expect(storage.mainStore.get('nonexistent')).toBeNull();
    });

    it('should set and get a value', () => {
      storage.mainStore.set('theme', 'dark');
      expect(storage.mainStore.get<string>('theme')).toBe('dark');
    });

    it('should overwrite existing value', () => {
      storage.mainStore.set('theme', 'light');
      storage.mainStore.set('theme', 'dark');
      expect(storage.mainStore.get<string>('theme')).toBe('dark');
    });

    it('should store complex objects', () => {
      const config = { model: 'gpt-4', temperature: 0.7, maxTokens: 4096 };
      storage.mainStore.set('ai_config', config);
      expect(storage.mainStore.get<typeof config>('ai_config')).toEqual(config);
    });

    it('should support query and run', () => {
      storage.mainStore.set('key1', 'val1');
      storage.mainStore.set('key2', 'val2');
      const rows = storage.mainStore.query<{ key: string }>(
        'SELECT key FROM settings ORDER BY key',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.key).toBe('key1');
    });
  });

  describe('aiStore', () => {
    it('should set and get a value', () => {
      storage.aiStore.set('last_conversation', 'conv-123');
      expect(storage.aiStore.get<string>('last_conversation')).toBe('conv-123');
    });

    it('should be isolated from mainStore', () => {
      storage.mainStore.set('same_key', 'main');
      storage.aiStore.set('same_key', 'ai');
      expect(storage.mainStore.get<string>('same_key')).toBe('main');
      expect(storage.aiStore.get<string>('same_key')).toBe('ai');
    });
  });

  describe('providerStore', () => {
    it('should set and get a value', async () => {
      const store = storage.providerStore('openai');
      await store.set('model', 'gpt-4');
      expect(await store.get<string>('model')).toBe('gpt-4');
    });

    it('should delete a value', async () => {
      const store = storage.providerStore('openai');
      await store.set('temp', '123');
      await store.delete('temp');
      expect(await store.get('temp')).toBeNull();
    });

    it('should query by prefix', async () => {
      const store = storage.providerStore('openai');
      await store.set('conv/1', 'msg1');
      await store.set('conv/2', 'msg2');
      await store.set('other', 'val');
      const results = await store.query<string>('conv/');
      expect(results).toHaveLength(2);
    });

    it('should isolate different providers', async () => {
      const openai = storage.providerStore('openai');
      const anthropic = storage.providerStore('anthropic');
      await openai.set('key', 'openai-key');
      await anthropic.set('key', 'anthropic-key');
      expect(await openai.get<string>('key')).toBe('openai-key');
      expect(await anthropic.get<string>('key')).toBe('anthropic-key');
    });
  });

  describe('extensionStore', () => {
    it('should set and get a value', async () => {
      const store = storage.extensionStore('ext-abc');
      await store.set('setting', true);
      expect(await store.get<boolean>('setting')).toBe(true);
    });

    it('should isolate from providerStore', async () => {
      const ext = storage.extensionStore('same-id');
      const prov = storage.providerStore('same-id');
      await ext.set('key', 'ext');
      await prov.set('key', 'prov');
      expect(await ext.get<string>('key')).toBe('ext');
      expect(await prov.get<string>('key')).toBe('prov');
    });
  });

  describe('LRU connection pool', () => {
    it('should reuse existing namespace connection', async () => {
      const store1 = storage.providerStore('openai');
      await store1.set('key1', 'val1');
      const store2 = storage.providerStore('openai');
      await store2.set('key2', 'val2');
      // 同一 provider 应共享底层 db
      expect(await store1.get<string>('key2')).toBe('val2');
    });

    it('should evict oldest when exceeding max connections', async () => {
      const smallDir = mkdtempSync(join(tmpdir(), 'urchin-lru-test-'));
      const smallFactory = createMockDatabaseFactory();
      const smallStorage = new StorageLayer(smallDir, new MockSafeStorage(), smallFactory.factory, {
        maxNamespaceConnections: 3,
      });
      try {
        const s1 = smallStorage.providerStore('p1');
        const s2 = smallStorage.providerStore('p2');
        const s3 = smallStorage.providerStore('p3');
        await s1.set('k', 'v1');
        await s2.set('k', 'v2');
        await s3.set('k', 'v3');

        // databases[0]=main, [1]=ai, [2]=p1, [3]=p2, [4]=p3
        expect(smallFactory.databases.length).toBe(5);
        const p1Db = smallFactory.databases[2];
        expect(p1Db).toBeDefined();
        if (!p1Db) return;
        expect(p1Db.isClosed()).toBe(false);

        // 创建第 4 个，应淘汰 p1（最久未使用）
        const s4 = smallStorage.providerStore('p4');
        await s4.set('k', 'v4');

        // p1 的连接已被关闭
        expect(p1Db.isClosed()).toBe(true);

        // 重新访问 p1 会创建新连接（新 MockDatabase 实例）
        const s1New = smallStorage.providerStore('p1');
        await s1New.set('k2', 'v1-new');
        expect(await s1New.get<string>('k2')).toBe('v1-new');
      } finally {
        smallStorage.close();
        rmSync(smallDir, { recursive: true, force: true });
      }
    });
  });

  describe('migrations', () => {
    it('should have created main database tables', () => {
      const tables = storage.mainStore.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('windows');
      expect(tableNames).toContain('tabs');
      expect(tableNames).toContain('bookmarks');
      expect(tableNames).toContain('history');
      expect(tableNames).toContain('settings');
      expect(tableNames).toContain('schema_migrations');
    });

    it('should have created ai database tables', () => {
      const tables = storage.aiStore.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('conversations');
      expect(tableNames).toContain('conversation_messages');
      expect(tableNames).toContain('providers');
      expect(tableNames).toContain('provider_secrets_index');
      expect(tableNames).toContain('settings');
      expect(tableNames).toContain('schema_migrations');
    });

    it('should record migration version', () => {
      const rows = storage.mainStore.query<{ version: number }>(
        'SELECT version FROM schema_migrations',
      );
      expect(rows[0]?.version).toBe(1);
    });
  });

  describe('close', () => {
    it('should close all connections without throwing', () => {
      storage.providerStore('p1');
      storage.providerStore('p2');
      expect(() => storage.close()).not.toThrow();
      // 防止 afterEach 再次 close
      storage = new StorageLayer(dataDir, new MockSafeStorage(), mockFactory.factory);
    });
  });
});
