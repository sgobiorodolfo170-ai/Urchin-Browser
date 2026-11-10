/**
 * firefox-cookies 单元测试
 *
 * 覆盖：
 * 1. buildCookiesFromFirefoxRows：字段映射、sameSite、会话/持久 Cookie、
 *    容器/分区（originAttributes 非空）与空字段跳过计数
 * 2. detectFirefoxCookieSupport：cookies.sqlite 存在性
 * 3. readFirefoxCookies：复制临时库 → 查询 → 映射 → 清理（注入 fake DB/fs）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildCookiesFromFirefoxRows,
  detectFirefoxCookieSupport,
  mapFirefoxSameSite,
  readFirefoxCookies,
  type MozCookieRow,
} from '../../src/main/import/firefox-cookies';
import type { SqliteReadonlyFactory } from '../../src/main/import/sqlite-readonly';

function row(overrides: Partial<MozCookieRow> = {}): MozCookieRow {
  return {
    host: 'example.com',
    path: '/',
    expiry: 1_800_000_000,
    isSecure: 1,
    isHttpOnly: 0,
    name: 'sid',
    value: 'abc',
    sameSite: 1,
    originAttributes: '',
    ...overrides,
  };
}

describe('mapFirefoxSameSite', () => {
  it('should map Firefox sameSite codes to Electron values', () => {
    expect(mapFirefoxSameSite(0)).toBe('no_restriction');
    expect(mapFirefoxSameSite(1)).toBe('lax');
    expect(mapFirefoxSameSite(2)).toBe('strict');
    expect(mapFirefoxSameSite(null)).toBe('unspecified');
    expect(mapFirefoxSameSite(9)).toBe('unspecified');
  });
});

describe('buildCookiesFromFirefoxRows', () => {
  it('should map rows and keep persistent/session distinction', () => {
    const result = buildCookiesFromFirefoxRows([
      row(),
      row({ host: '.example.com', name: 'dom', expiry: 0, sameSite: 2, isSecure: 0 }),
    ]);

    expect(result.skipped).toBe(0);
    expect(result.encryptedSkipped).toBe(0);
    expect(result.cookies).toHaveLength(2);
    expect(result.cookies[0]).toMatchObject({
      host: 'example.com',
      name: 'sid',
      value: 'abc',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      expiresSec: 1_800_000_000,
    });
    expect(result.cookies[1]).toMatchObject({
      host: '.example.com',
      sameSite: 'strict',
      secure: false,
    });
    expect(result.cookies[1]?.expiresSec).toBeUndefined();
  });

  it('should skip container/partition cookies (originAttributes non-empty) and empty rows', () => {
    const result = buildCookiesFromFirefoxRows([
      row({ originAttributes: '^userContextId=1' }),
      row({ originAttributes: '^partitionKey=(https,example.com)' }),
      row({ host: '' }),
      row({ name: '' }),
      row(),
    ]);

    expect(result.cookies).toHaveLength(1);
    expect(result.skipped).toBe(4);
  });

  it('should normalize non-absolute paths to "/"', () => {
    const result = buildCookiesFromFirefoxRows([row({ path: 'app' })]);
    expect(result.cookies[0]?.path).toBe('/');
  });
});

describe('detectFirefoxCookieSupport', () => {
  it('should return true only when cookies.sqlite exists', () => {
    const existsSync = vi.fn((path: string) => path.endsWith('cookies.sqlite'));
    expect(detectFirefoxCookieSupport('C:\\FF', { existsSync })).toBe(true);

    const missing = vi.fn(() => false);
    expect(detectFirefoxCookieSupport('C:\\FF', { existsSync: missing })).toBe(false);
  });
});

describe('readFirefoxCookies', () => {
  it('should copy, query, map and clean up temp files', async () => {
    const copyFileSync = vi.fn();
    const rmSync = vi.fn();
    const existsSync = vi.fn(() => false);
    const dbFactory: SqliteReadonlyFactory = vi.fn(() => ({
      prepare: vi.fn(() => ({ all: () => [row()] })),
      close: vi.fn(),
    }));

    const result = await readFirefoxCookies(
      'C:\\FF',
      { copyFileSync, rmSync, existsSync },
      dbFactory,
    );

    expect(copyFileSync).toHaveBeenCalledWith(
      'C:\\FF\\cookies.sqlite',
      expect.stringContaining('urchin-ff-cookies-'),
    );
    expect(dbFactory).toHaveBeenCalledTimes(1);
    expect(result.cookies).toHaveLength(1);
    expect(rmSync).toHaveBeenCalled();
  });
});
