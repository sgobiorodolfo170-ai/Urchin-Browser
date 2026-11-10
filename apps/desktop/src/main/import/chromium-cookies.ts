/**
 * Import 域 · Chromium 系（Chrome / Edge）Cookie 读取
 *
 * 依据：Chromium profile 的 `Network\Cookies`（SQLite）+ `Local State`：
 *   - `os_crypt.encrypted_key`：Base64(DPAPI 包装的 32 字节主密钥)；
 *   - `os_crypt.app_bound_encrypted_key`：Chrome 127+ App-Bound Encryption（ABE）；
 *   - Cookie `encrypted_value`：`v10`/`v11`（AES-256-GCM，主密钥可解）、
 *     `v20`（ABE，应用级加密，本应用无法解）。
 *
 * 设计理由（AGENTS.md §六 可测试性 + §七.2）：
 * - 解密原语（AES-GCM / DPAPI）可注入：单测无需真实 Chrome 数据；
 * - DPAPI 用系统 PowerShell `ProtectedData.Unprotect`，不新增 npm 原生依赖；
 * - ABE 不绕过：v20 行跳过并计数，UI 明示「仅旧版可用」，不假装导入成功；
 * - 明文 Cookie 只在主进程内存中存在，日志只记计数。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CookieReadResult, ImportCookie } from './types';
import {
  defaultReadonlyFactory as createDefaultReadonlyFactory,
  type SqliteReadonlyDatabase,
  type SqliteReadonlyFactory,
} from './sqlite-readonly';

/** Windows FILETIME（1601-01-01）→ Unix 秒的偏移。 */
const WINDOWS_EPOCH_OFFSET_SEC = 11_644_473_600;

/** cookies 表行（仅取导入需要的列）。 */
export interface ChromiumCookieRow {
  readonly host_key: string | null;
  readonly name: string | null;
  readonly value: string | null;
  readonly encrypted_value: Uint8Array | null;
  readonly path: string | null;
  readonly expires_utc: number | null;
  readonly is_secure: number | null;
  readonly is_httponly: number | null;
  readonly samesite: number | null;
  readonly is_persistent: number | null;
}

/** fs / 解密依赖注入（收窄路径/编码类型，便于单测 mock）。 */
export interface ChromiumCookieDeps {
  readonly existsSync?: (path: string) => boolean;
  readonly readFileSync?: (path: string, encoding: BufferEncoding) => string;
  readonly copyFileSync?: (src: string, dest: string) => void;
  readonly rmSync?: (path: string, options?: { force?: boolean }) => void;
  /** DPAPI 解包（默认 PowerShell；单测注入 fake） */
  readonly decryptDpapi?: (wrapped: Buffer) => Promise<Buffer>;
}

/** Cookie 能力检测结果（供 ImportedBrowser 展示）。 */
export interface ChromiumCookieSupport {
  readonly support: 'full' | 'partial' | 'none';
  readonly note?: string;
}

/** Chromium sameSite → Electron 枚举映射（-1 unspecified, 0 None, 1 Lax, 2 Strict）。 */
export function mapChromiumSameSite(value: number | null): ImportCookie['sameSite'] {
  if (value === 0) return 'no_restriction';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  return 'unspecified';
}

/** Chromium expires_utc（1601 起的微秒）→ Unix 秒；非持久/非法返回 undefined。 */
export function chromiumExpiryToUnixSeconds(
  expiresUtc: number | null,
  isPersistent: number | null,
): number | undefined {
  if (isPersistent === 0) return undefined;
  if (!expiresUtc || expiresUtc <= 0) return undefined;
  const seconds = Math.floor(expiresUtc / 1_000_000 - WINDOWS_EPOCH_OFFSET_SEC);
  return seconds > 0 ? seconds : undefined;
}

/** Cookie 数据库路径：优先 Network\Cookies，回退旧版根目录 Cookies。 */
export function resolveChromiumCookiesPath(
  profileDir: string,
  deps: Pick<ChromiumCookieDeps, 'existsSync'> = {},
): string | null {
  const exists = deps.existsSync ?? existsSync;
  const network = join(profileDir, 'Network', 'Cookies');
  if (exists(network)) return network;
  const legacy = join(profileDir, 'Cookies');
  return exists(legacy) ? legacy : null;
}

/** Local State 路径（profileDir 的父目录即 User Data）。 */
export function resolveChromiumLocalStatePath(profileDir: string): string {
  return join(dirname(profileDir), 'Local State');
}

/**
 * 能力检测：Cookie 库存在 + 主密钥形态。
 *
 * - 有 ABE（app_bound_encrypted_key）→ partial（仅旧版 v10/v11 可解）；
 * - 仅 DPAPI（encrypted_key）→ full；
 * - 无 Cookie 库 / 无密钥 → none。
 */
export function detectChromiumCookieSupport(
  profileDir: string,
  deps: Pick<ChromiumCookieDeps, 'existsSync' | 'readFileSync'> = {},
): ChromiumCookieSupport {
  const exists = deps.existsSync ?? existsSync;
  const readFile = deps.readFileSync ?? readFileSync;
  if (!resolveChromiumCookiesPath(profileDir, { existsSync: exists })) {
    return { support: 'none', note: '未找到 Cookie 数据库' };
  }
  try {
    const raw = readFile(resolveChromiumLocalStatePath(profileDir), 'utf-8');
    const localState = JSON.parse(raw) as {
      os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string };
    };
    const crypt = localState.os_crypt ?? {};
    if (crypt.app_bound_encrypted_key) {
      return {
        support: 'partial',
        note: '已启用应用级加密（ABE），仅能导入旧版 v10/v11 Cookie',
      };
    }
    if (crypt.encrypted_key) {
      return { support: 'full' };
    }
    return { support: 'none', note: 'Local State 缺少主密钥' };
  } catch {
    return { support: 'none', note: '无法读取 Local State' };
  }
}

/** 用 Windows DPAPI（当前用户）解包主密钥；不新增原生依赖。 */
export function decryptDpapiWithPowerShell(wrapped: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('DPAPI 仅支持 Windows'));
      return;
    }
    const b64 = wrapped.toString('base64');
    // PowerShell 5.1 需要显式加载 System.Security 才有 ProtectedData；
    // 主密钥的 DPAPI 解包只在当前用户态进行，不涉及提权。
    const script =
      "$ErrorActionPreference='Stop';" +
      'try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {};' +
      "$d=[Convert]::FromBase64String('" +
      b64 +
      "'); $p=[Security.Cryptography.ProtectedData]::Unprotect($d,$null,'CurrentUser'); " +
      '[Convert]::ToBase64String($p)';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          // 不回传原始错误：PowerShell 的 stderr 会带完整命令行（含 DPAPI 密文 base64），
          // 不应进入 UI toast / 日志。
          reject(new Error('DPAPI 主密钥解密失败（PowerShell 不可用或系统策略限制）'));
          return;
        }
        try {
          resolve(Buffer.from(stdout.trim(), 'base64'));
        } catch {
          reject(new Error('DPAPI 主密钥解密失败（返回值不是合法 base64）'));
        }
      },
    );
  });
}

/** 解 v10/v11 AES-256-GCM 密文为原始 Buffer；失败返回 null（调用方计数）。 */
export function decryptChromiumAesGcmBuffer(encrypted: Uint8Array, key: Buffer): Buffer | null {
  // 3 字节前缀 + 12 字节 nonce + 至少 16 字节 GCM tag
  if (encrypted.length < 3 + 12 + 16) return null;
  const buf = Buffer.from(encrypted);
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  if (key.length !== 32) return null;
  try {
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(15, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** 解 v10/v11 AES-256-GCM 密文为 UTF-8 文本（兼容旧调用/单测）。 */
export function decryptChromiumAesGcm(encrypted: Uint8Array, key: Buffer): string | null {
  return decryptChromiumAesGcmBuffer(encrypted, key)?.toString('utf8') ?? null;
}

/**
 * Chromium 加密 Cookie 明文可能带 32 字节 `SHA256(host_key)` 完整性前缀
 * （Chromium 的 cookie 值哈希校验）；先按 Buffer 比对前缀再解码，
 * 避免二进制哈希被当成 UTF-8 文本触发「ASCII control characters」拒绝。
 *
 * @param plain 解密后的原始字节
 * @param hostKey Cookie host_key（保持原始前导点形态）
 */
export function decodeChromiumCookieValue(plain: Buffer, hostKey: string): string {
  if (plain.length >= 32) {
    const expected = createHash('sha256').update(hostKey).digest();
    if (plain.subarray(0, 32).equals(expected)) {
      return plain.subarray(32).toString('utf8');
    }
  }
  return plain.toString('utf8');
}

/** 单条 Cookie 值解密结果。 */
export type ChromiumCookieValueResult =
  | { readonly status: 'ok'; readonly value: string }
  | { readonly status: 'encrypted' }
  | { readonly status: 'invalid' };

/**
 * 解一条 Cookie 的 value（明文优先；encrypted_value 按前缀分流）。
 *
 * v20（ABE）直接返回 encrypted（跳过并计数）；旧版无前缀 DPAPI blob 走注入解密。
 */
export async function decryptChromiumCookieValue(
  row: Pick<ChromiumCookieRow, 'value' | 'encrypted_value'>,
  masterKey: Buffer,
  hostKey: string,
  decryptDpapi: (wrapped: Buffer) => Promise<Buffer> = decryptDpapiWithPowerShell,
): Promise<ChromiumCookieValueResult> {
  if (typeof row.value === 'string' && row.value !== '') {
    return { status: 'ok', value: row.value };
  }
  const encrypted = row.encrypted_value;
  if (!encrypted || encrypted.length === 0) return { status: 'ok', value: '' };
  const buf = Buffer.from(encrypted);
  const prefix = buf.length >= 3 ? buf.subarray(0, 3).toString('latin1') : '';
  if (prefix === 'v20') return { status: 'encrypted' };
  if (prefix === 'v10' || prefix === 'v11') {
    const plain = decryptChromiumAesGcmBuffer(buf, masterKey);
    return plain === null
      ? { status: 'invalid' }
      : { status: 'ok', value: decodeChromiumCookieValue(plain, hostKey) };
  }
  // Chrome 80 之前：整块即 DPAPI 密文
  try {
    const plain = await decryptDpapi(buf);
    return { status: 'ok', value: decodeChromiumCookieValue(plain, hostKey) };
  } catch {
    return { status: 'invalid' };
  }
}

/** 取 Local State 中的 DPAPI 主密钥（去掉 "DPAPI" 前缀）。 */
export async function loadChromiumMasterKey(
  profileDir: string,
  deps: ChromiumCookieDeps = {},
): Promise<Buffer> {
  const readFile = deps.readFileSync ?? readFileSync;
  const decryptDpapi = deps.decryptDpapi ?? decryptDpapiWithPowerShell;
  const raw = readFile(resolveChromiumLocalStatePath(profileDir), 'utf-8');
  const localState = JSON.parse(raw) as { os_crypt?: { encrypted_key?: string } };
  const encoded = localState.os_crypt?.encrypted_key;
  if (!encoded) throw new Error('Local State 缺少 os_crypt.encrypted_key');
  let wrapped = Buffer.from(encoded, 'base64');
  if (wrapped.subarray(0, 5).toString('latin1') === 'DPAPI') {
    wrapped = wrapped.subarray(5);
  }
  const key = await decryptDpapi(wrapped);
  if (key.length !== 32) throw new Error(`主密钥长度非法：${key.length}`);
  return key;
}

/** 复制 Cookies 数据库（含 WAL/SHM）到临时目录。 */
export function copyChromiumCookieDb(
  cookiesPath: string,
  deps: Pick<ChromiumCookieDeps, 'existsSync' | 'copyFileSync' | 'rmSync'> = {},
): { tmpPath: string; cleanup: () => void } {
  const exists = deps.existsSync ?? existsSync;
  const copyFile = deps.copyFileSync ?? copyFileSync;
  const rm = deps.rmSync ?? rmSync;
  const tmpPath = join(tmpdir(), `urchin-chromium-cookies-${randomUUID()}.sqlite`);
  try {
    copyFile(cookiesPath, tmpPath);
  } catch {
    // Chromium 运行时可能对 Cookie 库加锁（Copy-Item 报「正在使用」）；
    // 以用户可理解的短消息返回，由 IPC 摘要展示（不泄漏路径/系统错误）。
    throw new Error('源浏览器正在运行或 Cookie 数据库被占用，请关闭浏览器后重试');
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${cookiesPath}${suffix}`;
    try {
      if (exists(sidecar)) copyFile(sidecar, `${tmpPath}${suffix}`);
    } catch {
      /* sidecar 复制失败：忽略，主库仍可读（可能缺最近写入） */
    }
  }
  return {
    tmpPath,
    cleanup: () => {
      for (const path of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`, `${tmpPath}-journal`]) {
        rm(path, { force: true });
      }
    },
  };
}

/** 查询 cookies 表（仅取需要的列）。 */
export function queryChromiumCookieRows(db: SqliteReadonlyDatabase): readonly ChromiumCookieRow[] {
  return db
    .prepare(
      'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies',
    )
    .all() as unknown as readonly ChromiumCookieRow[];
}

/**
 * 把 cookies 行映射为待写入 Cookie（纯函数；解密已完成的 value 传入）。
 *
 * @param rows 已解出 value 的行（encrypted_value 不再使用）
 */
export function buildCookiesFromChromiumRows(
  rows: readonly (ChromiumCookieRow & { readonly value: string })[],
): CookieReadResult {
  const cookies: ImportCookie[] = [];
  let skipped = 0;
  for (const row of rows) {
    const host = row.host_key?.trim() ?? '';
    const name = row.name ?? '';
    if (!host || !name) {
      skipped++;
      continue;
    }
    const path = row.path?.startsWith('/') ? row.path : '/';
    const expiresSec = chromiumExpiryToUnixSeconds(row.expires_utc, row.is_persistent);
    cookies.push({
      host,
      path,
      name,
      value: row.value,
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      sameSite: mapChromiumSameSite(row.samesite),
      ...(expiresSec !== undefined ? { expiresSec } : {}),
    });
  }
  return { cookies, skipped, encryptedSkipped: 0 };
}

/**
 * 读取 Chromium profile 的可导入 Cookie。
 *
 * 主密钥解不出（ABE-only / PowerShell 被策略禁用）时抛错，由调用方降级提示。
 */
export async function readChromiumCookies(
  profileDir: string,
  deps: ChromiumCookieDeps = {},
  dbFactory?: SqliteReadonlyFactory,
): Promise<CookieReadResult> {
  const cookiesPath = resolveChromiumCookiesPath(profileDir, { existsSync: deps.existsSync });
  if (!cookiesPath) throw new Error('未找到 Cookie 数据库');
  const masterKey = await loadChromiumMasterKey(profileDir, deps);
  const decryptDpapi = deps.decryptDpapi ?? decryptDpapiWithPowerShell;
  const { tmpPath, cleanup } = copyChromiumCookieDb(cookiesPath, deps);
  try {
    const factory = dbFactory ?? (await createDefaultReadonlyFactory());
    const db = factory(tmpPath);
    try {
      const rows = queryChromiumCookieRows(db);
      const decrypted: (ChromiumCookieRow & { value: string })[] = [];
      let encryptedSkipped = 0;
      let invalid = 0;
      for (const row of rows) {
        const result = await decryptChromiumCookieValue(
          row,
          masterKey,
          row.host_key ?? '',
          decryptDpapi,
        );
        if (result.status === 'ok') {
          decrypted.push({ ...row, value: result.value });
        } else if (result.status === 'encrypted') {
          encryptedSkipped++;
        } else {
          invalid++;
        }
      }
      const mapped = buildCookiesFromChromiumRows(decrypted);
      return {
        cookies: mapped.cookies,
        skipped: mapped.skipped + invalid,
        encryptedSkipped,
        ...(encryptedSkipped > 0
          ? { note: `已跳过 ${encryptedSkipped} 条应用级加密（ABE v20）Cookie` }
          : {}),
      };
    } finally {
      db.close();
    }
  } finally {
    cleanup();
  }
}
