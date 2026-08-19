/**
 * M8 Storage Layer · 核心存储层
 *
 * 依据：契约 H §2 / §5 / ST1-ST3 + ST8 决策
 * 职责：
 * 1. 管理主库（urchin.db）与 AI 库（ai.db），WAL 模式
 * 2. 运行 schema 迁移
 * 3. 提供 mainStore / aiStore KV facade（基于 settings 表）
 * 4. 管理 per-provider / per-extension 命名空间 db（LRU 连接池，ST8 决策）
 * 5. 提供 secrets SecretStore
 *
 * ST1 决策：主库与 AI 库分离（独立 db 文件）。
 * ST2 决策：per-ext/provider 独立 db（drop 简单）。
 * ST3 决策：journal_mode = WAL（并发读写）。
 * ST8 决策：连接数上限 50，LRU 关闭最旧。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';
import { runMigrations, MIGRATIONS_MAIN, MIGRATIONS_AI } from './migrations';
import { SecretStoreImpl } from './secret-store';
import type {
  IDatabase,
  ISafeStorage,
  SecretStore,
  NamespaceStorage,
  DatabaseFactory,
} from './types';

const log = createLogger('storage-layer');

/** 命名空间连接池默认上限（ST8 决策） */
const DEFAULT_MAX_NAMESPACE_CONNECTIONS = 50;

/** 命名空间 KV 表 DDL */
const NAMESPACE_KV_DDL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

/**
 * 命名空间 KV 存储实现。
 *
 * 基于 SQLite kv_store 表，value 以 JSON 序列化存储。
 */
class NamespaceStorageImpl implements NamespaceStorage {
  constructor(private readonly db: IDatabase) {
    db.exec(NAMESPACE_KV_DDL);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- better-sqlite3 is sync; async per interface contract for IPC compatibility
  async get<T>(key: string): Promise<T | null> {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- better-sqlite3 is sync; async per interface contract for IPC compatibility
  async set<T>(key: string, value: T): Promise<void> {
    const json = JSON.stringify(value);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, json, now);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- better-sqlite3 is sync; async per interface contract for IPC compatibility
  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- better-sqlite3 is sync; async per interface contract for IPC compatibility
  async query<T>(prefix: string): Promise<readonly { readonly key: string; readonly value: T }[]> {
    const rows = this.db
      .prepare('SELECT key, value FROM kv_store WHERE key LIKE ?')
      .all(`${prefix}%`) as readonly { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
}

export class StorageLayer {
  private readonly dataDir: string;
  private readonly piDataDir: string;
  private readonly main: IDatabase;
  private readonly ai: IDatabase;
  private readonly connectionPool = new Map<string, IDatabase>();
  private readonly maxConnections: number;
  private readonly dbFactory: DatabaseFactory;
  readonly secrets: SecretStore;

  constructor(
    dataDir: string,
    piDataDir: string,
    safeStorage: ISafeStorage,
    dbFactory: DatabaseFactory,
    options?: { readonly maxNamespaceConnections?: number },
  ) {
    this.dataDir = dataDir;
    this.piDataDir = piDataDir;
    this.dbFactory = dbFactory;
    this.maxConnections = options?.maxNamespaceConnections ?? DEFAULT_MAX_NAMESPACE_CONNECTIONS;

    mkdirSync(dataDir, { recursive: true });
    mkdirSync(piDataDir, { recursive: true });

    // 主库（书签/历史/非 pi 设置）在用户数据目录；AI 库（pi 对话/pi 设置）在 pi 目录。
    // DD1 决策：pi 数据与用户个人数据隔离，pi 目录固定 userData/pi，不随数据目录配置变动。
    this.main = this.dbFactory(join(dataDir, 'urchin.db'));
    this.ai = this.dbFactory(join(piDataDir, 'ai.db'));
    this.main.pragma('journal_mode = WAL');
    this.ai.pragma('journal_mode = WAL');

    runMigrations(this.main, MIGRATIONS_MAIN);
    runMigrations(this.ai, MIGRATIONS_AI);

    // 密钥（ai.apiKey / summary.apiKey 等）属 pi 敏感数据，加密落盘到 pi 目录
    this.secrets = new SecretStoreImpl(piDataDir, safeStorage);

    log.info('storage layer initialized', { dataDir, piDataDir });
  }

  /** 主库 facade（settings 表 KV） */
  readonly mainStore = {
    get: <T>(key: string): T | null => {
      const row = this.main.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as T;
    },
    set: <T>(key: string, value: T): void => {
      const json = JSON.stringify(value);
      const now = Date.now();
      this.main
        .prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run(key, json, now);
    },
    query: <T>(sql: string, ...params: readonly unknown[]): readonly T[] =>
      this.main.prepare(sql).all(...params) as T[],
    run: (sql: string, ...params: readonly unknown[]): void => {
      this.main.prepare(sql).run(...params);
    },
  };

  /** AI 库 facade（settings 表 KV） */
  readonly aiStore = {
    get: <T>(key: string): T | null => {
      const row = this.ai.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.value) as T;
    },
    set: <T>(key: string, value: T): void => {
      const json = JSON.stringify(value);
      const now = Date.now();
      this.ai
        .prepare(
          'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run(key, json, now);
    },
    query: <T>(sql: string, ...params: readonly unknown[]): readonly T[] =>
      this.ai.prepare(sql).all(...params) as T[],
    run: (sql: string, ...params: readonly unknown[]): void => {
      this.ai.prepare(sql).run(...params);
    },
  };

  /** Provider 私有命名空间（ST2 + ST8 决策；DD1 决策：Provider 数据属 pi 隔离区） */
  providerStore(providerId: string): NamespaceStorage {
    return this.getOrCreateNamespaceDb(this.piDataDir, 'providers', providerId);
  }

  /** Extension 私有命名空间（CP4 决策；扩展数据随用户数据目录） */
  extensionStore(extId: string): NamespaceStorage {
    return this.getOrCreateNamespaceDb(this.dataDir, 'extensions', extId);
  }

  /** 关闭所有数据库连接 */
  close(): void {
    for (const db of this.connectionPool.values()) {
      db.close();
    }
    this.connectionPool.clear();
    this.main.close();
    this.ai.close();
    log.info('storage layer closed');
  }

  /**
   * 获取或创建命名空间数据库（LRU 策略，ST8 决策）。
   */
  private getOrCreateNamespaceDb(rootDir: string, subdir: string, id: string): NamespaceStorage {
    const key = `${subdir}/${id}`;

    // LRU 更新：命中则移到末尾
    const existing = this.connectionPool.get(key);
    if (existing) {
      this.connectionPool.delete(key);
      this.connectionPool.set(key, existing);
      return new NamespaceStorageImpl(existing);
    }

    // 超限时关闭最旧连接
    if (this.connectionPool.size >= this.maxConnections) {
      const oldestKey = this.connectionPool.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestDb = this.connectionPool.get(oldestKey);
        oldestDb?.close();
        this.connectionPool.delete(oldestKey);
      }
    }

    const dbPath = join(rootDir, subdir, `${id}.db`);
    mkdirSync(join(rootDir, subdir), { recursive: true });
    const db = this.dbFactory(dbPath);
    db.pragma('journal_mode = WAL');
    this.connectionPool.set(key, db);
    return new NamespaceStorageImpl(db);
  }
}
