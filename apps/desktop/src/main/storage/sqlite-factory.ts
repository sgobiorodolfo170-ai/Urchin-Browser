/**
 * M8 Storage Layer · SQLite 数据库工厂（生产环境）
 *
 * 依据：契约 H §5
 * 职责：创建 better-sqlite3 数据库实例，适配为 IDatabase 接口。
 *
 * 仅在 main 进程使用，测试环境使用 MockDatabase 替代。
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- thin adapter over better-sqlite3 native module with custom type declarations */

import Database from 'better-sqlite3';
import type { DatabaseFactory, IDatabase, IStatement } from './types';

/** better-sqlite3 Statement 适配器 */
class SqliteStatement implements IStatement {
  constructor(private readonly stmt: Database.Statement) {}

  all(...params: readonly unknown[]): unknown[] {
    return this.stmt.all(...params);
  }

  get(...params: readonly unknown[]): unknown {
    return this.stmt.get(...params);
  }

  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt.run(...params);
  }
}

/** better-sqlite3 Database 适配器 */
class SqliteDatabase implements IDatabase {
  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): IStatement {
    return new SqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma);
  }

  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}

/** 生产环境数据库工厂 */
export const createSqliteDatabase: DatabaseFactory = (path: string): IDatabase => {
  return new SqliteDatabase(new Database(path));
};
