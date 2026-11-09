/**
 * M8 Storage Layer · 类型定义
 *
 * 依据：契约 H §5 / §7
 * 职责：定义存储层的抽象接口，便于单元测试解耦原生依赖。
 */

/** SQL 预处理语句接口 */
export interface IStatement {
  all(...params: readonly unknown[]): unknown[];
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** 数据库连接接口（better-sqlite3 子集） */
export interface IDatabase {
  prepare(sql: string): IStatement;
  exec(sql: string): void;
  pragma(pragma: string): unknown;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

/** 数据库工厂函数类型，用于解耦 better-sqlite3 创建（便于测试） */
export type DatabaseFactory = (path: string) => IDatabase;

/**
 * safeStorage 后端抽象。
 *
 * 用于解耦 Electron 的 safeStorage 模块，便于单元测试。
 * 生产环境由 ElectronSafeStorageBackend 实现，测试环境由 Mock 实现替换。
 *
 * 为何是 async（2026-11-09，Electron 45/46 前置）：
 * Electron 45 起同步 API（isEncryptionAvailable/encryptString/decryptString）标记 deprecated，
 * 46 起**移除**（Chromium 移除了同步 OSCrypt 后端）。异步 API 自 Electron 43 起可用，
 * 故在仍停留在 43.x 时先完成迁移——接口先改成 Promise，避免升级时被强制波及调用链。
 * SecretStore 的三个方法本来就是 async（历史注释「future keytar migration」），因此无同步链路被拉断。
 */
export interface ISafeStorage {
  isEncryptionAvailable(): Promise<boolean>;
  encryptString(plainText: string): Promise<Buffer>;
  decryptString(encrypted: Buffer): Promise<string>;
}

/**
 * 敏感数据存储接口（ST5 决策）。
 *
 * 用于 Provider API key 等敏感数据的加密存储。
 * 实际值经 safeStorage 加密后写入文件系统 secrets/<providerId>/<keyName>.enc。
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * 命名空间 KV 存储接口（ST2 决策）。
 *
 * 用于 Provider / Extension 的私有存储命名空间。
 * 底层为独立的 SQLite db 文件，崩溃或卸载时 drop database 即可清理。
 */
export interface NamespaceStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  query<T>(prefix: string): Promise<readonly { readonly key: string; readonly value: T }[]>;
}

/** 主库 / AI 库 facade 接口 */
export interface DatabaseFacade {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  query<T>(sql: string, ...params: readonly unknown[]): readonly T[];
  run(sql: string, ...params: readonly unknown[]): void;
}

/** 迁移定义 */
export interface Migration {
  readonly version: number;
  readonly up: string;
}
