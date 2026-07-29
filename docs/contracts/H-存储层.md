# 契约 H · M8 Storage Layer

> 状态：Draft  · 日期：2026-07-27  · 关联决策：ST1-ST8
> 模块归属：main  · 关联模块：M5 / M6 / M7 / M9 / M11 / M12
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

主进程的统一持久化层：
- SQLite（better-sqlite3 同步 API）存结构化数据（书签/历史/会话/Provider 配置/对话历史）
- Electron `safeStorage` 存敏感数据（API keys）
- per-Provider 与 per-extension namespace 隔离（独立 db 文件）

**为什么不用 JSON 文件**：浏览器场景下 bookmarks/history 量级可能到几万条，JSON 读写慢且无索引能力。

## 2. SQLite 数据库划分（ST1 + ST2 决策）

```
app_path/
  urchin.db            # 主库（windows/tabs/bookmarks/history/settings）
  ai.db                # AI 库（conversations/messages/provider_state）
  extensions/
    <ext-id>.db        # per-extension 独立库（CP4 决策）
  providers/
    <provider-id>.db   # per-provider 独立库（M12 ProviderContext.storage）
  secrets/
    <provider-id>/
      <key-name>.enc   # safeStorage 加密文件
```

**ST1 + ST2 决策落地理由**：
- per-extension / per-provider 独立文件——崩溃或卸载时清理简单，单文件 drop database 即可。
- 主库与 AI 库分离——AI 数据高频写入（对话 token 流），不挤占主库 IO；crash 时主库不受影响。

## 3. 主库 schema

```sql
-- windows（持久化的窗口状态，TP4 决策配套）
CREATE TABLE windows (
  id TEXT PRIMARY KEY,
  bounds TEXT NOT NULL,         -- JSON: {x, y, width, height}
  state TEXT NOT NULL,          -- JSON: { isMaximized, isFullScreen }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- tabs（持久化的标签会话，TP4 决策）
CREATE TABLE tabs (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  index_in_window INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tabs_window ON tabs(window_id);

-- bookmarks（M5）
CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
  url TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'folder' | 'bookmark'
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bookmarks_parent ON bookmarks(parent_id);

-- history（M6）
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT,
  visited_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_history_url ON history(url);
CREATE INDEX idx_history_visited ON history(visited_at DESC);

-- settings（M7）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,          -- JSON-encoded
  updated_at INTEGER NOT NULL
);

-- schema_migrations（ST4 决策）
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

## 4. AI 库 schema

```sql
-- conversations（M13 + M14）
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  tab_id TEXT,                  -- 关联的 tab（可能为 NULL 孤儿）
  provider_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  streaming_state TEXT NOT NULL DEFAULT 'idle'
);
CREATE INDEX idx_conversations_tab ON conversations(tab_id);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,           -- 'system' | 'user' | 'assistant'
  content TEXT NOT NULL,
  metadata TEXT,                -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON conversation_messages(conversation_id, created_at);

-- provider 注册表
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  package_path TEXT NOT NULL,
  manifest TEXT NOT NULL,       -- JSON: ProviderManifest
  config TEXT NOT NULL,         -- JSON: ProviderConfig (API key 不在此处)
  enabled INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- API key 索引（指向 safeStorage 中的加密值）
CREATE TABLE provider_secrets_index (
  provider_id TEXT NOT NULL,
  key_name TEXT NOT NULL,       -- 'api_key' / 'oauth_token' / etc.
  PRIMARY KEY (provider_id, key_name)
);
-- 实际值存于：safeStorage.encryptString(value) → 文件系统 secrets/<provider_id>/<key_name>.enc
```

## 5. 存储层 API

```typescript
// apps/desktop/src/main/storage/storage-layer.ts
import Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import path from 'path';

export class StorageLayer {
  private main: Database.Database;
  private ai: Database.Database;
  private connectionPool = new Map<string, Database.Database>();  // ST8 决策：LRU pool

  constructor(private dataDir: string) {
    this.main = new Database(path.join(dataDir, 'urchin.db'));
    this.ai = new Database(path.join(dataDir, 'ai.db'));
    this.main.pragma('journal_mode = WAL');   // ST3 决策
    this.ai.pragma('journal_mode = WAL');
    this.runMigrations(this.main, 'main');
    this.runMigrations(this.ai, 'ai');
  }

  /** 主库 facade */
  readonly mainStore = {
    get:    <T>(key: string): T | null => /* settings 表 KV */,
    set:    (key: string, value: T): void => /* upsert */,
    query:  <T>(sql: string, params: any[]): T[] => this.main.prepare(sql).all(...params),
    run:    (sql: string, params: any[]): void => this.main.prepare(sql).run(...params),
  };

  /** AI 库 facade */
  readonly aiStore = {
    /* 同上 */
  };

  /**
   * Provider 私有命名空间（M12 ProviderContext.storage）
   * 自动创建/打开 provider_<id>.db
   * ST2 + ST8 决策
   */
  providerStore(providerId: string): ProviderStorage {
    return this.getOrCreateNamespaceDb('providers', providerId);
  }

  /** Extension 私有命名空间（CP4 决策） */
  extensionStore(extId: string): ExtensionStorage {
    return this.getOrCreateNamespaceDb('extensions', extId);
  }

  /** 敏感数据（safeStorage 加密，ST5 决策） */
  readonly secrets = new SecretStoreImpl(this.dataDir);

  private getOrCreateNamespaceDb(subdir: string, id: string): Database.Database {
    const key = `${subdir}/${id}`;
    if (this.connectionPool.has(key)) {
      // LRU 更新
      const db = this.connectionPool.get(key)!;
      this.connectionPool.delete(key);
      this.connectionPool.set(key, db);
      return db;
    }
    const dbPath = path.join(this.dataDir, subdir, `${id}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // ST8 决策：上限 50，超限 LRU 关闭最旧
    if (this.connectionPool.size >= 50) {
      const [oldestKey, oldestDb] = this.connectionPool.entries().next().value;
      oldestDb.close();
      this.connectionPool.delete(oldestKey);
    }
    this.connectionPool.set(key, db);
    return db;
  }
}

export interface ProviderStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  query<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
}
```

## 6. 迁移机制（ST4 决策）

```typescript
// apps/desktop/src/main/storage/migrations.ts
const MIGRATIONS_MAIN = [
  {
    version: 1,
    up: `
      CREATE TABLE windows (...);
      CREATE TABLE tabs (...);
      -- 见 §3
    `,
  },
  // 未来 v0.2/0.3 加表/列时追加 migration
];

function runMigrations(db: Database.Database, scope: 'main' | 'ai'): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrations = scope === 'main' ? MIGRATIONS_MAIN : MIGRATIONS_AI;
  const current = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get()?.v ?? 0;

  for (const m of migrations) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
    });
    tx();
  }
}
```

**ST4 决策落地理由**：浏览器 schema 不复杂，自定义 migration 文件够用，避免引入额外依赖（T6 决策：默认 TS，按需原生）。

## 7. 敏感数据（API key 加密，ST5 决策）

```typescript
class SecretStoreImpl implements SecretStore {
  constructor(private dataDir: string) {}

  async get(name: string): Promise<string | null> {
    const file = this.pathFor(name);
    if (!fs.existsSync(file)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage not available on this platform');
    }
    const encrypted = fs.readFileSync(file);
    return safeStorage.decryptString(encrypted);
  }

  async set(name: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage not available');
    }
    const encrypted = safeStorage.encryptString(value);
    fs.mkdirSync(path.dirname(this.pathFor(name)), { recursive: true });
    fs.writeFileSync(this.pathFor(name), encrypted, { mode: 0o600 });
  }

  async delete(name: string): Promise<void> {
    const file = this.pathFor(name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /**
   * ST6 决策：严格白名单字符，拒绝路径穿越。
   * name 格式: <providerId>/<keyName>，仅允许字母数字/下划线/连字符/斜杠
   */
  private pathFor(name: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(name)) {
      throw new Error(`Invalid secret name: ${name}`);
    }
    return path.join(this.dataDir, 'secrets', `${name}.enc`);
  }
}
```

Windows 上 `safeStorage` 用 DPAPI 加密，只有同一用户账户下能解密。卸载浏览器时 `secrets/` 目录应清理（v0.2+ 的 uninstaller 流程记住）。

## 8. 备份与导出（ST7 决策）

- **v0.2**: 用户可导出 bookmarks/history 为 HTML/JSON。
- **v0.3**: 完整 backup/restore（含 settings + ai conversations）。
- **API key 永不导出**——安全考虑，用户重新安装后需重新输入。

## 9. 决策记录

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| ST1 | 主库与 AI 库分离 | 是（独立 db 文件） | 合并 IO 互相挤占；AI crash 风险波及主库 |
| ST2 | per-ext/provider 独立 db | 是（drop 简单） | 单库 + namespace 表卸载时清理复杂 |
| ST3 | journal_mode | WAL（并发读写） | DELETE 模式慢；MEMORY 不持久 |
| ST4 | 迁移机制 | 自定义 schema_migrations + raw SQL | umzag 额外依赖；better-sqlite3-migra 过度抽象 |
| ST5 | API key 存储 | Electron safeStorage（DPAPI on Windows） | keytar 留待 v0.5+ 跨平台；明文不安全 |
| ST6 | secrets 路径校验 | 严格白名单字符正则 | path.resolve + 包含检查可能漏 edge case |
| ST7 | 备份范围 | v0.2 bookmarks/history；v0.3 全量；API key 永不 | 全量导出含 key 泄露风险 |
| ST8 | 连接数上限 | 50 个 namespace db，LRU 关闭 | 无限开文件描述符爆；上限过低则频繁开关 |

## 10. 未来演进

- v0.2: 备份/导出 API + UI
- v0.3: 完整 backup/restore（含 AI 对话）；考虑 keytar 替代 safeStorage（更安全的 OS keychain）
- v0.5: 跨设备 sync（如接入用户账号系统）
- v1.0: 数据库压缩与 vacuum 调度（避免长期使用后碎片）
