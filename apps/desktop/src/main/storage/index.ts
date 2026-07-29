/**
 * M8 Storage Layer · 模块入口
 *
 * 依据：04-模块全景 M8 v0.1
 */
export { StorageLayer } from './storage-layer';
export { SecretStoreImpl } from './secret-store';
export { runMigrations, MIGRATIONS_MAIN, MIGRATIONS_AI } from './migrations';
export { createSqliteDatabase } from './sqlite-factory';
export type {
  IDatabase,
  IStatement,
  ISafeStorage,
  SecretStore,
  NamespaceStorage,
  DatabaseFacade,
  DatabaseFactory,
  Migration,
} from './types';
