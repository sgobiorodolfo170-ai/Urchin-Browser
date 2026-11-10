/**
 * cookie-importer 单元测试
 *
 * 覆盖：
 * 1. toCookieSetDetails：host-only / 域名 Cookie、SameSite=None 必须 Secure、
 *    __Host-/__Secure- 约束、过期跳过、URL/path 规范化
 * 2. importCookiesToSession：成功/跳过/失败计数，因规则跳过不调用 session
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COOKIE_IMPORT_BATCH_SIZE,
  importCookiesToSession,
  toCookieSetDetails,
  type CookieWriteSession,
} from '../../src/main/import/cookie-importer';
import type { ImportCookie } from '../../src/main/import/types';

const NOW = 1_700_000_000;

function cookie(overrides: Partial<ImportCookie> = {}): ImportCookie {
  return {
    host: 'example.com',
    path: '/',
    name: 'sid',
    value: 'abc',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
    ...overrides,
  };
}

describe('toCookieSetDetails', () => {
  it('should build an https url for host-only secure cookies without domain', () => {
    const details = toCookieSetDetails(cookie(), NOW);

    expect(details).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: 'abc',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
    });
  });

  it('should keep leading-dot domain cookies as domain cookies', () => {
    const details = toCookieSetDetails(cookie({ host: '.example.com', path: '/app' }), NOW);

    expect(details?.url).toBe('https://example.com/app');
    expect(details?.domain).toBe('.example.com');
  });

  it('should use http url when the cookie is not secure', () => {
    const details = toCookieSetDetails(cookie({ secure: false }), NOW);

    expect(details?.url).toBe('http://example.com/');
  });

  it('should skip SameSite=None cookies without Secure', () => {
    expect(
      toCookieSetDetails(cookie({ sameSite: 'no_restriction', secure: false }), NOW),
    ).toBeNull();
  });

  it('should enforce __Host- prefix rules', () => {
    expect(toCookieSetDetails(cookie({ name: '__Host-a', secure: false }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ name: '__Host-a', path: '/sub' }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ name: '__Host-a', host: '.example.com' }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ name: '__Host-a' }), NOW)).not.toBeNull();
    expect(toCookieSetDetails(cookie({ name: '__Secure-a', secure: false }), NOW)).toBeNull();
  });

  it('should skip expired cookies but keep session cookies', () => {
    expect(toCookieSetDetails(cookie({ expiresSec: NOW - 10 }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ expiresSec: NOW + 60 }), NOW)?.expirationDate).toBe(
      NOW + 60,
    );
    expect(toCookieSetDetails(cookie(), NOW)?.expirationDate).toBeUndefined();
  });

  it('should reject empty host/name and malformed hosts', () => {
    expect(toCookieSetDetails(cookie({ host: '' }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ name: '' }), NOW)).toBeNull();
    expect(toCookieSetDetails(cookie({ host: 'bad host.com' }), NOW)).toBeNull();
  });
});

describe('importCookiesToSession', () => {
  function makeSession(failOn?: string): {
    session: CookieWriteSession;
    set: ReturnType<typeof vi.fn>;
  } {
    const set = vi.fn().mockImplementation((details: { name: string }) => {
      if (failOn && details.name === failOn) return Promise.reject(new Error('bad cookie'));
      return Promise.resolve();
    });
    return { session: { cookies: { set } }, set };
  }

  it('should count imported / skipped / failed cookies', async () => {
    const { session, set } = makeSession('boom');

    const summary = await importCookiesToSession(
      [
        cookie({ name: 'ok' }),
        cookie({ name: 'expired', expiresSec: 1 }),
        cookie({ name: 'boom' }),
      ],
      session,
    );

    expect(summary).toEqual({ imported: 1, skipped: 1, failed: 1, encryptedSkipped: 0 });
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('should yield between batches for large imports', async () => {
    const { session, set } = makeSession();
    const cookies = Array.from({ length: COOKIE_IMPORT_BATCH_SIZE + 1 }, (_, i) =>
      cookie({ name: `c${i}` }),
    );

    const summary = await importCookiesToSession(cookies, session);

    expect(summary.imported).toBe(COOKIE_IMPORT_BATCH_SIZE + 1);
    expect(set).toHaveBeenCalledTimes(COOKIE_IMPORT_BATCH_SIZE + 1);
  });
});
