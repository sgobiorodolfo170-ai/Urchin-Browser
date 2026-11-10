/**
 * Import 域 · Firefox Cookie 读取（cookies.sqlite，明文存储）
 *
 * 依据：Firefox profile 的 `cookies.sqlite` / `moz_cookies` 表：
 *   host, path, expiry, isSecure, isHttpOnly, name, value, sameSite, originAttributes
 *
 * 设计理由（AGENTS.md §六 可测试性 + §七.2）：
 * - 行映射抽成纯函数 buildCookiesFromFirefoxRows，单测无需真实 SQLite；
 * - 与书签导入同策略：复制临时文件（含 -wal/-shm）后只读打开，避开 Firefox
 *   运行时锁，原文件不写；
 * - 容器/分区 Cookie（originAttributes 非空）不导入：Electron CookiesSetDetails
 *   无 userContextId/partitionKey 表达，强行按普通 Cookie 写入会串容器；
 * - 明文值不落日志（调用方仅记录计数）。
 */
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CookieReadResult, ImportCookie } from './types';
import {
  defaultReadonlyFactory as createDefaultReadonlyFactory,
  type SqliteReadonlyDatabase,
  type SqliteReadonlyFactory,
} from './sqlite-readonly';

/** moz_cookies 行（better-sqlite3 返回 snake/camel 依查询别名；此处用原列名）。 */
export interface MozCookieRow {
  readonly host: string | null;
  readonly path: string | null;
  readonly expiry: number | null;
  readonly isSecure: number | null;
  readonly isHttpOnly: number | null;
  readonly name: string | null;
  readonly value: string | null;
  readonly sameSite: number | null;
  readonly originAttributes: string | null;
}

/** fs 依赖注入（单测 mock；收窄为 string 路径，避免 node:fs 重载类型噪音）。 */
export interface FirefoxCookieFsDeps {
  readonly existsSync?: (path: string) => boolean;
  readonly copyFileSync?: (src: string, dest: string) => void;
  readonly rmSync?: (path: string, options?: { force?: boolean }) => void;
}

/** Firefox sameSite → Electron 枚举映射（0=no_restriction/None, 1=Lax, 2=Strict）。 */
export function mapFirefoxSameSite(value: number | null): ImportCookie['sameSite'] {
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  if (value === 0) return 'no_restriction';
  return 'unspecified';
}

/**
 * 行集 → 可写入 Cookie（纯函数）。
 *
 * 跳过：空 host/name、容器或分区 Cookie（originAttributes 非空）。
 */
export function buildCookiesFromFirefoxRows(rows: readonly MozCookieRow[]): CookieReadResult {
  const cookies: ImportCookie[] = [];
  let skipped = 0;
  for (const row of rows) {
    const host = row.host?.trim() ?? '';
    const name = row.name ?? '';
    if (!host || !name) {
      skipped++;
      continue;
    }
    // 容器标签（userContextId）/ 存储分区（partitionKey）等均无法用 Electron
    // cookies.set 表达；跳过以避免把隔离容器 Cookie 串到普通会话。
    if ((row.originAttributes ?? '').trim() !== '') {
      skipped++;
      continue;
    }
    const path = row.path?.startsWith('/') ? row.path : '/';
    const expiry = typeof row.expiry === 'number' ? row.expiry : 0;
    const cookie: ImportCookie = {
      host,
      path,
      name,
      value: row.value ?? '',
      secure: row.isSecure === 1,
      httpOnly: row.isHttpOnly === 1,
      sameSite: mapFirefoxSameSite(row.sameSite),
      ...(expiry > 0 ? { expiresSec: expiry } : {}),
    };
    cookies.push(cookie);
  }
  return { cookies, skipped, encryptedSkipped: 0 };
}

/** Firefox profile 是否具备 Cookie 库（能力检测；无则 UI 显示不可用）。 */
export function detectFirefoxCookieSupport(
  profileDir: string,
  deps: FirefoxCookieFsDeps = {},
): boolean {
  const exists = deps.existsSync ?? existsSync;
  return exists(join(profileDir, 'cookies.sqlite'));
}

/** 复制 cookies.sqlite（含 WAL/SHM）到临时目录，返回临时主文件路径与清理函数。 */
export function copyFirefoxCookieDb(
  profileDir: string,
  deps: FirefoxCookieFsDeps = {},
): { tmpPath: string; cleanup: () => void } {
  const copyFile = deps.copyFileSync ?? copyFileSync;
  const rm = deps.rmSync ?? rmSync;
  const source = join(profileDir, 'cookies.sqlite');
  const tmpPath = join(tmpdir(), `urchin-ff-cookies-${randomUUID()}.sqlite`);
  try {
    copyFile(source, tmpPath);
  } catch {
    throw new Error('源浏览器正在运行或 Cookie 数据库被占用，请关闭浏览器后重试');
  }
  // WAL 模式下最新 Cookie 可能在 -wal 中；必须同名复制，SQLite 才能回放。
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${source}${suffix}`;
    try {
      if (existsSync(sidecar)) copyFile(sidecar, `${tmpPath}${suffix}`);
    } catch {
      /* sidecar 复制失败：忽略，主库仍可读（可能缺最近写入） */
    }
  }
  return {
    tmpPath,
    cleanup: () => {
      for (const path of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
        rm(path, { force: true });
      }
    },
  };
}

/** 从已打开的 DB 读取全部 moz_cookies 行。 */
export function queryFirefoxCookieRows(db: SqliteReadonlyDatabase): readonly MozCookieRow[] {
  return db
    .prepare(
      'SELECT host, path, expiry, isSecure, isHttpOnly, name, value, sameSite, originAttributes FROM moz_cookies',
    )
    .all() as unknown as readonly MozCookieRow[];
}

/**
 * 读取 Firefox profile 的全部可导入 Cookie。
 *
 * @param profileDir profile 绝对路径（含 cookies.sqlite）
 * @param deps fs 注入
 * @param dbFactory 只读 SQLite 工厂注入（默认惰性 better-sqlite3）
 */
export async function readFirefoxCookies(
  profileDir: string,
  deps: FirefoxCookieFsDeps = {},
  dbFactory?: SqliteReadonlyFactory,
): Promise<CookieReadResult> {
  const { tmpPath, cleanup } = copyFirefoxCookieDb(profileDir, deps);
  try {
    const factory = dbFactory ?? (await createDefaultReadonlyFactory());
    const db = factory(tmpPath);
    try {
      return buildCookiesFromFirefoxRows(queryFirefoxCookieRows(db));
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
}
