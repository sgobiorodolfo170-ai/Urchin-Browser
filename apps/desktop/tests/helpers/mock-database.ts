/**
 * M8 Storage Layer · 测试用 Mock 数据库
 *
 * 实现 IDatabase 接口，使用内存 Map 模拟 SQLite 操作。
 * 仅支持 StorageLayer 使用到的特定 SQL 模式。
 */

import type { IDatabase, IStatement } from '../../src/main/storage/types';

/** Mock 数据库行 */
type Row = Record<string, unknown>;

// --- 预编译正则（非全局，用于单次匹配） ---
const RE_SELECT_VALUE_BY_KEY = /^SELECT\s+value\s+FROM\s+(\w+)\s+WHERE\s+key\s*=\s*\?$/i;
const RE_SELECT_KV_BY_LIKE = /^SELECT\s+key,\s*value\s+FROM\s+(\w+)\s+WHERE\s+key\s+LIKE\s*\?$/i;
const RE_SELECT_KEY_ORDER = /^SELECT\s+key\s+FROM\s+(\w+)\s+ORDER\s+BY\s+key$/i;
const RE_SELECT_MAX_VERSION = /^SELECT\s+MAX\(version\)\s+AS\s+v\s+FROM\s+schema_migrations$/i;
const RE_SELECT_VERSION = /^SELECT\s+version\s+FROM\s+schema_migrations$/i;
const RE_SELECT_TABLES =
  /^SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type='table'\s+ORDER\s+BY\s+name$/i;
const RE_INSERT_KV_CONFLICT =
  /^INSERT\s+INTO\s+(\w+)\s+\(key,\s*value,\s*updated_at\)\s+VALUES\s+\(\?,\s*\?,\s*\?\)\s+ON\s+CONFLICT/i;
const RE_INSERT_MIGRATION =
  /^INSERT\s+INTO\s+schema_migrations\s+\(version,\s*applied_at\)\s+VALUES\s+\(\?,\s*\?\)$/i;
const RE_DELETE_BY_KEY = /^DELETE\s+FROM\s+(\w+)\s+WHERE\s+key\s*=\s*\?$/i;

// --- 预编译正则（全局，用于 matchAll 多次匹配） ---
const RE_CREATE_TABLE_IF_NOT_EXISTS = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
const RE_CREATE_TABLE = /CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)(\w+)/gi;

/** Mock 预处理语句 */
class MockStatement implements IStatement {
  constructor(
    private readonly db: MockDatabase,
    private readonly sql: string,
  ) {}

  all(...params: readonly unknown[]): unknown[] {
    return this.execute(params);
  }

  get(...params: readonly unknown[]): unknown {
    const results = this.execute(params);
    return results[0] ?? undefined;
  }

  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const results = this.execute(params);
    return { changes: results.length, lastInsertRowid: 0 };
  }

  private execute(params: readonly unknown[]): Row[] {
    const sql = this.sql.trim();

    // SELECT value FROM <table> WHERE key = ?
    let m = RE_SELECT_VALUE_BY_KEY.exec(sql);
    if (m) {
      const table = m[1];
      if (!table) return [];
      const key = String(params[0]);
      const row = this.db.getRow(table, key);
      return row ? [{ value: row.value }] : [];
    }

    // SELECT key, value FROM <table> WHERE key LIKE ?
    m = RE_SELECT_KV_BY_LIKE.exec(sql);
    if (m) {
      const table = m[1];
      if (!table) return [];
      const pattern = String(params[0]);
      const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
      const rows = this.db.queryPrefix(table, prefix);
      return rows.map((r) => ({ key: r.key, value: r.value }));
    }

    // SELECT key FROM <table> ORDER BY key
    m = RE_SELECT_KEY_ORDER.exec(sql);
    if (m) {
      const table = m[1];
      if (!table) return [];
      const rows = this.db.getAll(table);
      return rows.map((r) => ({ key: r.key }));
    }

    // SELECT MAX(version) AS v FROM schema_migrations
    m = RE_SELECT_MAX_VERSION.exec(sql);
    if (m) {
      const rows = this.db.getAll('schema_migrations');
      const maxVersion = rows.reduce((max, r) => Math.max(max, Number(r.version)), 0);
      return [{ v: maxVersion || null }];
    }

    // SELECT version FROM schema_migrations
    m = RE_SELECT_VERSION.exec(sql);
    if (m) {
      return this.db.getAll('schema_migrations').map((r) => ({ version: r.version }));
    }

    // SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    m = RE_SELECT_TABLES.exec(sql);
    if (m) {
      return this.db.listTables().map((name) => ({ name }));
    }

    // INSERT INTO <table> (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE ...
    m = RE_INSERT_KV_CONFLICT.exec(sql);
    if (m) {
      const table = m[1];
      if (!table) return [];
      const [key, value, updatedAt] = params;
      this.db.upsert(table, String(key), { key, value, updated_at: updatedAt });
      return [];
    }

    // INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
    m = RE_INSERT_MIGRATION.exec(sql);
    if (m) {
      const [version, appliedAt] = params;
      this.db.insert('schema_migrations', { version, applied_at: appliedAt });
      return [];
    }

    // DELETE FROM <table> WHERE key = ?
    m = RE_DELETE_BY_KEY.exec(sql);
    if (m) {
      const table = m[1];
      if (!table) return [];
      this.db.delete(table, String(params[0]));
      return [];
    }

    // Fallback: return empty
    return [];
  }
}

/** Mock 数据库实现 */
export class MockDatabase implements IDatabase {
  private readonly tables = new Map<string, Map<string, Row>>();
  private closed = false;

  prepare(sql: string): IStatement {
    return new MockStatement(this, sql);
  }

  exec(sql: string): void {
    // 处理 CREATE TABLE IF NOT EXISTS
    for (const match of sql.matchAll(RE_CREATE_TABLE_IF_NOT_EXISTS)) {
      const name = match[1];
      if (name && !this.tables.has(name)) {
        this.tables.set(name, new Map());
      }
    }

    // 处理 CREATE TABLE（无 IF NOT EXISTS）
    for (const match of sql.matchAll(RE_CREATE_TABLE)) {
      const name = match[1];
      if (name && !this.tables.has(name)) {
        this.tables.set(name, new Map());
      }
    }

    // CREATE INDEX 被忽略（mock 不需要索引）
  }

  pragma(): unknown {
    return null;
  }

  transaction<T>(fn: () => T): () => T {
    return fn;
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  // --- 内部辅助方法 ---

  private getTable(name: string): Map<string, Row> {
    let table = this.tables.get(name);
    if (!table) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  getRow(table: string, key: string): Row | undefined {
    return this.getTable(table).get(key);
  }

  getAll(table: string): Row[] {
    return Array.from(this.getTable(table).values());
  }

  queryPrefix(table: string, prefix: string): Row[] {
    return this.getAll(table).filter((row) => String(row.key).startsWith(prefix));
  }

  upsert(table: string, key: string, row: Row): void {
    this.getTable(table).set(key, row);
  }

  insert(table: string, row: Row): void {
    const map = this.getTable(table);
    const id = String(map.size + 1);
    map.set(id, row);
  }

  delete(table: string, key: string): void {
    this.getTable(table).delete(key);
  }

  listTables(): string[] {
    return Array.from(this.tables.keys()).sort();
  }
}

/** 创建 mock 数据库工厂 */
export function createMockDatabaseFactory(): {
  factory: (path: string) => IDatabase;
  databases: MockDatabase[];
} {
  const databases: MockDatabase[] = [];
  return {
    factory: () => {
      const db = new MockDatabase();
      databases.push(db);
      return db;
    },
    databases,
  };
}
