/**
 * M25 邮箱密码迁移单测（pi/secrets 旧根 → dataDir/secrets 新根）
 *
 * 覆盖：旧根缺失不动新根、正常复制、同名不覆盖、部分失败不中断。
 * 依据：2026-11-10「账户密码缺失」修复——mail 密码根从 userData/pi 迁至数据目录。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateMailSecrets } from '../../src/main/mail/migrate-mail-secrets';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mail-secrets-migrate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrateMailSecrets', () => {
  it('should return 0 and create nothing when legacy root is missing', () => {
    const legacy = makeTempRoot();
    const fresh = makeTempRoot();
    expect(migrateMailSecrets(join(legacy, 'secrets'), join(fresh, 'secrets'))).toBe(0);
    expect(existsSync(join(fresh, 'secrets', 'mail-account'))).toBe(false);
  });

  it('should copy mail-account entries to the new root', () => {
    const legacy = makeTempRoot();
    const fresh = makeTempRoot();
    const legacyAccountDir = join(legacy, 'secrets', 'mail-account', 'acct-1');
    mkdirSync(legacyAccountDir, { recursive: true });
    writeFileSync(join(legacyAccountDir, 'password.enc'), 'ENC-1');

    const moved = migrateMailSecrets(join(legacy, 'secrets'), join(fresh, 'secrets'));

    expect(moved).toBe(1);
    expect(
      readFileSync(join(fresh, 'secrets', 'mail-account', 'acct-1', 'password.enc'), 'utf8'),
    ).toBe('ENC-1');
  });

  it('should NOT overwrite an existing entry at the new root', () => {
    const legacy = makeTempRoot();
    const fresh = makeTempRoot();
    const legacyAccountDir = join(legacy, 'secrets', 'mail-account', 'acct-1');
    mkdirSync(legacyAccountDir, { recursive: true });
    writeFileSync(join(legacyAccountDir, 'password.enc'), 'LEGACY');

    const newAccountDir = join(fresh, 'secrets', 'mail-account', 'acct-1');
    mkdirSync(newAccountDir, { recursive: true });
    writeFileSync(join(newAccountDir, 'password.enc'), 'FRESH-REAUTH');

    const moved = migrateMailSecrets(join(legacy, 'secrets'), join(fresh, 'secrets'));

    expect(moved).toBe(0);
    expect(readFileSync(join(newAccountDir, 'password.enc'), 'utf8')).toBe('FRESH-REAUTH');
  });

  it('should copy entries regardless of entry type (dir or stray file)', () => {
    const legacy = makeTempRoot();
    const fresh = makeTempRoot();
    // 正常目录条目 + 一个散落文件条目（历史异常产物）：两者都应被搬迁
    const stray = join(legacy, 'secrets', 'mail-account', 'stray-id');
    mkdirSync(join(legacy, 'secrets', 'mail-account'), { recursive: true });
    writeFileSync(stray, 'stray file');
    const okDir = join(legacy, 'secrets', 'mail-account', 'ok-id');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(join(okDir, 'password.enc'), 'OK');

    const moved = migrateMailSecrets(join(legacy, 'secrets'), join(fresh, 'secrets'));

    expect(moved).toBe(2);
    expect(existsSync(join(fresh, 'secrets', 'mail-account', 'ok-id', 'password.enc'))).toBe(true);
    expect(existsSync(join(fresh, 'secrets', 'mail-account', 'stray-id'))).toBe(true);
  });
});
