/**
 * better-sqlite3 类型声明（最小化）
 *
 * 仅声明 StorageLayer 使用到的 API 子集。
 * 完整类型见 @types/better-sqlite3。
 */

declare module 'better-sqlite3' {
  interface Statement {
    all(...params: readonly unknown[]): unknown[];
    get(...params: readonly unknown[]): unknown;
    run(...params: readonly unknown[]): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  }

  class Database {
    constructor(filename: string, options?: Record<string, unknown>);

    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string, options?: { simple?: boolean }): unknown;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }

  namespace Database {
    export type Database = Database;
    export type Statement = Statement;
  }

  export = Database;
}
