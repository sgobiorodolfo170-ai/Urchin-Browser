/**
 * M8 Storage Layer · 迁移机制
 *
 * 依据：契约 H §3 / §4 / §6 / ST4 决策
 * 职责：
 * 1. 定义主库（urchin.db）schema 迁移
 * 2. 定义 AI 库（ai.db）schema 迁移
 * 3. 提供 runMigrations 函数，基于 schema_migrations 表做版本追踪
 *
 * ST4 决策：自定义 schema_migrations + raw SQL，不引入额外依赖。
 */

import type { Migration, IDatabase } from './types';

/** 主库迁移列表（windows/tabs/bookmarks/history/settings） */
export const MIGRATIONS_MAIN: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS windows (
        id TEXT PRIMARY KEY,
        bounds TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tabs (
        id TEXT PRIMARY KEY,
        window_id TEXT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        index_in_window INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tabs_window ON tabs(window_id);

      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
        url TEXT,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_parent ON bookmarks(parent_id);

      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT,
        visited_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
      CREATE INDEX IF NOT EXISTS idx_history_visited ON history(visited_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

/** AI 库迁移列表（conversations/messages/providers/secrets_index） */
export const MIGRATIONS_AI: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        tab_id TEXT,
        provider_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        streaming_state TEXT NOT NULL DEFAULT 'idle'
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_tab ON conversations(tab_id);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON conversation_messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        package_path TEXT NOT NULL,
        manifest TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS provider_secrets_index (
        provider_id TEXT NOT NULL,
        key_name TEXT NOT NULL,
        PRIMARY KEY (provider_id, key_name)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

/**
 * 运行数据库迁移。
 *
 * @param db better-sqlite3 Database 实例
 * @param migrations 迁移列表（按 version 升序）
 *
 * ST4 决策：基于 schema_migrations 表追踪已应用版本，每个迁移在事务内执行。
 */
export function runMigrations(db: IDatabase, migrations: readonly Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  const current = row?.v ?? 0;

  for (const m of migrations) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    });
    tx();
  }
}
