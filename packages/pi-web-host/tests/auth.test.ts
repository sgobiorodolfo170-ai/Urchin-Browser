import { describe, expect, it } from 'vitest';
import {
  generateToken,
  buildHostUrl,
  isTokenValid,
  isAuthorizedRequest,
  tokenFromQuery,
  tokenFromCookie,
  buildTokenCookie,
  HOST_READY_PREFIX,
  HOST_READY_LINE_RE,
  HOST_TOKEN_COOKIE,
} from '../src/auth';

describe('generateToken', () => {
  it('should produce 43-char base64url token of 32 random bytes', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 随机性：两次调用不应相等
    expect(generateToken()).not.toBe(a);
  });
});

describe('buildHostUrl', () => {
  it('should embed token into 127.0.0.1 url', () => {
    const url = buildHostUrl(8081, 'abc_XYZ-123');
    expect(url).toBe('http://127.0.0.1:8081/?token=abc_XYZ-123');
  });
});

describe('isTokenValid', () => {
  it('should accept exact match', () => {
    expect(isTokenValid('tok', 'tok')).toBe(true);
  });
  it('should reject mismatch / missing', () => {
    expect(isTokenValid('tok', 'tk')).toBe(false);
    expect(isTokenValid('tok', undefined)).toBe(false);
    expect(isTokenValid(undefined, undefined)).toBe(false);
    expect(isTokenValid(undefined, 'tok')).toBe(false);
  });
});

describe('tokenFromQuery / tokenFromCookie', () => {
  it('should read query token', () => {
    expect(tokenFromQuery('?token=abc')).toBe('abc');
    expect(tokenFromQuery('?a=1&token=abc')).toBe('abc');
    expect(tokenFromQuery('')).toBeUndefined();
    expect(tokenFromQuery('?token=')).toBeUndefined();
  });
  it('should read cookie token', () => {
    expect(tokenFromCookie(`${HOST_TOKEN_COOKIE}=secret`)).toBe('secret');
    expect(tokenFromCookie(`other=x; ${HOST_TOKEN_COOKIE}=secret`)).toBe('secret');
    expect(tokenFromCookie('')).toBeUndefined();
  });
});

describe('isAuthorizedRequest', () => {
  it('should authorize via query token', () => {
    expect(isAuthorizedRequest('s', '?token=s', undefined)).toBe(true);
  });
  it('should authorize via cookie', () => {
    expect(isAuthorizedRequest('s', '', `${HOST_TOKEN_COOKIE}=s`)).toBe(true);
  });
  it('should reject when neither matches', () => {
    expect(isAuthorizedRequest('s', '?token=o', 'other=1')).toBe(false);
  });
});

describe('buildTokenCookie', () => {
  it('should include HttpOnly + SameSite=Strict + Path=/', () => {
    const cookie = buildTokenCookie('tok');
    expect(cookie.startsWith(`${HOST_TOKEN_COOKIE}=tok;`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
  });
});

describe('HOST_READY_LINE_RE', () => {
  it('should parse full ready line', () => {
    const line = `${HOST_READY_PREFIX}http://127.0.0.1:41234/?token=abc123_XYZ-\n`;
    const m = HOST_READY_LINE_RE.exec(line);
    expect(m?.[1]).toBe('http://127.0.0.1:41234/?token=abc123_XYZ-');
  });
  it('should match with ANSI terminator (chunk boundary)', () => {
    const m = HOST_READY_LINE_RE.exec(`${HOST_READY_PREFIX}http://127.0.0.1:1/?token=ab\x1b[0m`);
    expect(m?.[1]).toBe('http://127.0.0.1:1/?token=ab');
  });
  it('should NOT accept truncated token without terminator', () => {
    // token 未收完（缓冲末尾），不允许 `$` 终止——防止截断误判
    const m = HOST_READY_LINE_RE.exec(`${HOST_READY_PREFIX}http://127.0.0.1:1/?token=abc`);
    expect(m).toBeNull();
  });
});
