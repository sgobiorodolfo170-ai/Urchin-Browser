/**
 * chromium-cookies 单元测试
 *
 * 覆盖：
 * 1. AES-256-GCM（v10）解密与 v20（ABE）跳过
 * 2. 能力检测：无库 / DPAPI（full）/ ABE（partial）/ 缺密钥
 * 3. expires_utc → Unix 秒、sameSite 映射
 * 4. readChromiumCookies：明文 + v10 + v20 混合行的计数与清理
 */
import { createCipheriv, createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  buildCookiesFromChromiumRows,
  chromiumExpiryToUnixSeconds,
  decryptChromiumAesGcm,
  decryptChromiumCookieValue,
  detectChromiumCookieSupport,
  mapChromiumSameSite,
  readChromiumCookies,
  type ChromiumCookieRow,
} from '../../src/main/import/chromium-cookies';
import type { SqliteReadonlyFactory } from '../../src/main/import/sqlite-readonly';

const PROFILE = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default';
const LOCAL_STATE = join('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data', 'Local State');
const COOKIES_PATH = join(PROFILE, 'Network', 'Cookies');
const KEY = Buffer.alloc(32, 9);

function encryptV10(value: string): Buffer {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()]);
}

function row(overrides: Partial<ChromiumCookieRow> = {}): ChromiumCookieRow {
  return {
    host_key: 'example.com',
    name: 'sid',
    value: 'plain',
    encrypted_value: null,
    path: '/',
    expires_utc: 13_400_000_000_000_000,
    is_secure: 1,
    is_httponly: 1,
    samesite: 1,
    is_persistent: 1,
    ...overrides,
  };
}

function localStateFile(crypt: Record<string, string>): string {
  return JSON.stringify({ os_crypt: crypt });
}

describe('decrypt / map helpers', () => {
  it('should decrypt v10 AES-GCM payloads', () => {
    expect(decryptChromiumAesGcm(encryptV10('hello'), KEY)).toBe('hello');
  });

  it('should return null for wrong key length or non-v10 payloads', () => {
    expect(decryptChromiumAesGcm(encryptV10('hello'), Buffer.alloc(16))).toBeNull();
    expect(decryptChromiumAesGcm(Buffer.from('v20xx'), KEY)).toBeNull();
    expect(decryptChromiumAesGcm(Buffer.alloc(10), KEY)).toBeNull();
  });

  it('should map Chromium sameSite codes', () => {
    expect(mapChromiumSameSite(-1)).toBe('unspecified');
    expect(mapChromiumSameSite(0)).toBe('no_restriction');
    expect(mapChromiumSameSite(1)).toBe('lax');
    expect(mapChromiumSameSite(2)).toBe('strict');
    expect(mapChromiumSameSite(null)).toBe('unspecified');
  });

  it('should convert FILETIME microseconds to Unix seconds, session for non-persistent', () => {
    const unix = chromiumExpiryToUnixSeconds(13_400_000_000_000_000, 1);
    expect(unix).toBe(13_400_000_000 - 11_644_473_600);
    expect(chromiumExpiryToUnixSeconds(13_400_000_000_000_000, 0)).toBeUndefined();
    expect(chromiumExpiryToUnixSeconds(0, 1)).toBeUndefined();
  });
});

describe('detectChromiumCookieSupport', () => {
  function deps(localState: string | null, hasCookies = true) {
    return {
      existsSync: (path: string) => hasCookies && path === COOKIES_PATH,
      readFileSync: () => {
        if (localState === null) throw new Error('missing');
        return localState;
      },
    };
  }

  it('should return none when the Cookies database is missing', () => {
    expect(detectChromiumCookieSupport(PROFILE, deps('{}', false)).support).toBe('none');
  });

  it('should return full when only the DPAPI key is present', () => {
    const result = detectChromiumCookieSupport(
      PROFILE,
      deps(localStateFile({ encrypted_key: 'x' })),
    );
    expect(result).toEqual({ support: 'full' });
  });

  it('should return partial when App-Bound Encryption is enabled', () => {
    const result = detectChromiumCookieSupport(
      PROFILE,
      deps(localStateFile({ encrypted_key: 'x', app_bound_encrypted_key: 'y' })),
    );
    expect(result.support).toBe('partial');
    expect(result.note).toContain('ABE');
  });

  it('should return none when Local State has no key or is unreadable', () => {
    expect(detectChromiumCookieSupport(PROFILE, deps(localStateFile({}))).support).toBe('none');
    expect(detectChromiumCookieSupport(PROFILE, deps(null)).support).toBe('none');
  });
});

describe('decryptChromiumCookieValue', () => {
  it('should prefer plaintext value', async () => {
    const result = await decryptChromiumCookieValue(
      { value: 'plain', encrypted_value: null },
      KEY,
      'example.com',
    );
    expect(result).toEqual({ status: 'ok', value: 'plain' });
  });

  it('should decrypt v10 and skip v20', async () => {
    await expect(
      decryptChromiumCookieValue(
        { value: '', encrypted_value: encryptV10('secret') },
        KEY,
        'example.com',
      ),
    ).resolves.toEqual({ status: 'ok', value: 'secret' });

    await expect(
      decryptChromiumCookieValue(
        { value: '', encrypted_value: Buffer.from('v20abcdefghijklmnop') },
        KEY,
        'example.com',
      ),
    ).resolves.toEqual({ status: 'encrypted' });
  });

  it('should strip the 32-byte SHA256(host_key) integrity prefix before decoding', async () => {
    const hostKey = '.example.com';
    const hash = createHash('sha256').update(hostKey).digest();
    const plain = Buffer.concat([hash, Buffer.from('real-value', 'utf8')]);
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()]);

    await expect(
      decryptChromiumCookieValue({ value: '', encrypted_value: encrypted }, KEY, hostKey),
    ).resolves.toEqual({ status: 'ok', value: 'real-value' });
  });

  it('should fall back to DPAPI for legacy blobs', async () => {
    const decryptDpapi = vi.fn().mockResolvedValue(Buffer.from('legacy'));
    await expect(
      decryptChromiumCookieValue(
        { value: '', encrypted_value: Buffer.from('opaque') },
        KEY,
        'example.com',
        decryptDpapi,
      ),
    ).resolves.toEqual({ status: 'ok', value: 'legacy' });

    await expect(
      decryptChromiumCookieValue(
        { value: '', encrypted_value: Buffer.from('opaque') },
        KEY,
        'example.com',
        () => Promise.reject(new Error('no dpapi')),
      ),
    ).resolves.toEqual({ status: 'invalid' });
  });
});

describe('buildCookiesFromChromiumRows', () => {
  it('should map host/path/expiry and skip empty identifiers', () => {
    const result = buildCookiesFromChromiumRows([
      { ...row(), value: 'v' },
      { ...row({ host_key: '.example.com', name: 'dom' }), value: 'v2' },
      { ...row({ host_key: '' }), value: 'v' },
    ]);

    expect(result.cookies).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.cookies[0]).toMatchObject({
      host: 'example.com',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(result.cookies[1]?.host).toBe('.example.com');
  });
});

describe('readChromiumCookies', () => {
  it('should decrypt v10, skip v20, count invalid rows and clean temp files', async () => {
    const copyFileSync = vi.fn();
    const rmSync = vi.fn();
    const existsSync = vi.fn((path: string) => path === COOKIES_PATH || path === LOCAL_STATE);
    const readFileSync = vi.fn(() =>
      localStateFile({ encrypted_key: Buffer.from('DPAPIwrapped').toString('base64') }),
    );
    const decryptDpapi = vi.fn().mockResolvedValue(KEY);
    const rows = [
      row({ value: 'plain' }),
      row({ name: 'secret', value: '', encrypted_value: encryptV10('decrypted') }),
      row({ name: 'abe', value: '', encrypted_value: Buffer.from('v20aaaaaaaaaaaaaaaa') }),
      row({ name: '', value: 'nameless' }),
    ];
    const dbFactory: SqliteReadonlyFactory = vi.fn(() => ({
      prepare: vi.fn(() => ({ all: () => rows })),
      close: vi.fn(),
    }));

    const result = await readChromiumCookies(
      PROFILE,
      { copyFileSync, rmSync, existsSync, readFileSync, decryptDpapi },
      dbFactory,
    );

    expect(result.cookies).toHaveLength(2);
    expect(result.cookies[1]).toMatchObject({ name: 'secret', value: 'decrypted' });
    expect(result.encryptedSkipped).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.note).toContain('ABE');
    expect(rmSync).toHaveBeenCalled();
  });

  it('should throw when the Cookies database is missing', async () => {
    await expect(
      readChromiumCookies(PROFILE, { existsSync: () => false, readFileSync: () => '{}' }),
    ).rejects.toThrow('未找到 Cookie 数据库');
  });
});
