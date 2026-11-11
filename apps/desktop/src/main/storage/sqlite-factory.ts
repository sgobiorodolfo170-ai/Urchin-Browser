/**
 * M8 Storage Layer · SQLite 数据库工厂（生产环境）
 *
 * 依据：契约 H §5
 * 职责：创建 better-sqlite3 数据库实例，适配为 IDatabase 接口。
 *
 * 仅在 main 进程使用，测试环境使用 MockDatabase 替代。
 *
 * ⚠ 原生模块必须**按需加载**（2026-11-11 dev.185 半装树事故）：
 * 顶层 `import Database from 'better-sqlite3'` 会被打包成主进程共享 chunk 的
 * 顶层 `require`。一旦安装树残缺（自动更新在「解压完成后拷贝到安装目录」
 * 阶段被中断：app.asar 已换成新版，而 app.asar.unpacked/node_modules 只拷了
 * 267 个包里的 7 个），chunk 一加载就抛 Cannot find module 'better-sqlite3'——
 * 发生在 logger 初始化与任何 try/catch 之前，只剩 uncaughtException 裸弹窗，
 * 日志无痕、用户也无从判断是「安装没装完」。
 * 改为 loadSqliteFactory() 异步导入后，故障面收敛到 whenReady 内的 storage
 * 初始化点，可被启动守卫捕获并转成用户可读的「重新运行安装包」修复提示。
 * 同源先例：src/main/import/sqlite-readonly.ts（dev.176）。
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- thin adapter over better-sqlite3 native module with custom type declarations */

import type Database from 'better-sqlite3';
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

/**
 * 创建生产用数据库工厂（按需加载原生模块）。
 *
 * 返回的工厂依旧是同步的（better-sqlite3 本身是同步 API），因此 StorageLayer
 * 的构造时序不变——只是把「加载原生模块」这一步提到调用方显式 await，让加载
 * 失败可在启动点被捕获。
 *
 * @returns 注入 StorageLayer 的 DatabaseFactory
 * @throws 原生模块缺失 / 预编译产物缺失 / ABI 不匹配时抛出原始加载错误，
 *         由 main/index.ts 的启动守卫捕获并转成修复提示。
 */
export async function loadSqliteFactory(): Promise<DatabaseFactory> {
  const { default: DatabaseCtor } = await import('better-sqlite3');
  return (path: string): IDatabase => new SqliteDatabase(new DatabaseCtor(path));
}
