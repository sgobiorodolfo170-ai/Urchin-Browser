/**
 * Import 域 · Cookie 写入 Urchin 会话
 *
 * 职责：把解析出的 ImportCookie 逐条写入 Electron session.cookies，
 * 并返回成功/跳过/失败计数（供 IPC 摘要与 UI toast）。
 *
 * 设计理由（AGENTS.md §六 可测试性 + §七.2）：
 * - 会话以最小接口注入（cookies.set），单测无需启动 Electron；
 * - 写入规则集中在 toCookieSetDetails 纯函数：URL/domain 形态、SameSite=None
 *   必须 Secure、__Host-/__Secure- 前缀约束、已过期 Cookie 跳过；
 * - 分批让出事件循环（每 50 条 setImmediate），避免上千条 Cookie 阻塞主进程。
 */

/** Electron CookiesSetDetails 的结构化子集（避免测试依赖 electron 类型）。 */
export interface CookieSetDetails {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly expirationDate?: number;
  readonly sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/** 可写入 Cookie 的最小会话接口。 */
export interface CookieWriteSession {
  readonly cookies: {
    set(details: CookieSetDetails): Promise<void>;
  };
}

/** 写入摘要（与 ipc-contract importCookiesSummarySchema 对齐）。 */
export interface CookieImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  encryptedSkipped: number;
  note?: string;
}

/** 批量写入大小（每批之间让出事件循环）。 */
export const COOKIE_IMPORT_BATCH_SIZE = 50;

/**
 * Cookie → Electron set 参数（纯函数）。
 *
 * @returns null = 规则不允许写入（计入 skipped）
 */
export function toCookieSetDetails(
  cookie: {
    readonly host: string;
    readonly path: string;
    readonly name: string;
    readonly value: string;
    readonly expiresSec?: number;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  },
  nowSec: number = Math.floor(Date.now() / 1000),
): CookieSetDetails | null {
  const host = cookie.host.trim();
  const name = cookie.name;
  if (!host || !name) return null;
  const isDomainCookie = host.startsWith('.');
  const hostForUrl = isDomainCookie ? host.slice(1) : host;
  if (!hostForUrl || /[\s/\\]/.test(hostForUrl)) return null;
  const path = cookie.path.startsWith('/') ? cookie.path : '/';
  // SameSite=None 必须 Secure，否则 Chromium 会拒绝；提前跳过避免失败计数噪音。
  if (cookie.sameSite === 'no_restriction' && !cookie.secure) return null;
  // __Host- 前缀约束：Secure + Path=/ + 无 Domain；__Secure- 必须 Secure。
  if (name.startsWith('__Host-') && (!cookie.secure || path !== '/' || isDomainCookie)) {
    return null;
  }
  if (name.startsWith('__Secure-') && !cookie.secure) return null;
  if (cookie.expiresSec !== undefined && cookie.expiresSec <= nowSec) return null;
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${hostForUrl}${path}`,
    name,
    value: cookie.value,
    ...(isDomainCookie ? { domain: host } : {}),
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expiresSec !== undefined ? { expirationDate: cookie.expiresSec } : {}),
    sameSite: cookie.sameSite,
  };
}

/**
 * 把 Cookie 写入会话。
 *
 * 失败只计数不抛错：书签导入已成功，单条 Cookie 被 Chromium 拒绝（如覆盖
 * Secure Cookie、SameSite 规则）不应中断整批导入。
 *
 * @param cookies 待写入 Cookie
 * @param session 目标会话（默认调用方传 session.defaultSession）
 */
export async function importCookiesToSession(
  cookies: readonly {
    readonly host: string;
    readonly path: string;
    readonly name: string;
    readonly value: string;
    readonly expiresSec?: number;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  }[],
  session: CookieWriteSession,
): Promise<CookieImportSummary> {
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < cookies.length; i++) {
    const details = toCookieSetDetails(cookies[i]!);
    if (!details) {
      skipped++;
      continue;
    }
    try {
      await session.cookies.set(details);
      imported++;
    } catch {
      failed++;
    }
    if ((i + 1) % COOKIE_IMPORT_BATCH_SIZE === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { imported, skipped, failed, encryptedSkipped: 0 };
}
