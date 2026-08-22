/**
 * pi auth.json 空白占位注入单元测试（dev.43）
 *
 * 验证：
 * 1. auth.json 不存在 → 注入 `_urchin_bootstrap` 空白占位（合法 ApiKeyCredential，无 key）
 * 2. auth.json 为空对象 {} → 同上注入
 * 3. 已有真实凭据 → 不动（绝不覆盖用户配置）
 * 4. JSON 损坏 → 不动（留给 pi 自行处理）
 * 5. 注入结果与 pi 官方形状一致（isPiConfigured 判定通过的键数 > 0）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAuthPlaceholder } from '../../src/main/pi-web/auth-placeholder';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'urchin-piweb-auth-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

const authPath = (): string => join(dir, 'auth.json');

describe('ensureAuthPlaceholder', () => {
  it('should seed a blank placeholder when auth.json does not exist', async () => {
    await ensureAuthPlaceholder(dir);
    const data = JSON.parse(readFileSync(authPath(), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['_urchin_bootstrap']);
    // 官方 ApiKeyCredential 形状（key 可空），无任何密钥
    expect(data._urchin_bootstrap).toEqual({ type: 'api_key' });
  });

  it('should seed when auth.json is an empty object (pi SDK auto-created)', async () => {
    writeFileSync(authPath(), '{}\n', 'utf-8');
    await ensureAuthPlaceholder(dir);
    const data = JSON.parse(readFileSync(authPath(), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(data)).toContain('_urchin_bootstrap');
  });

  it('should NOT touch auth.json when real credentials exist', async () => {
    const original = { anthropic: { type: 'api_key', key: 'sk-real' } };
    writeFileSync(authPath(), JSON.stringify(original, null, 2), 'utf-8');
    await ensureAuthPlaceholder(dir);
    const data = JSON.parse(readFileSync(authPath(), 'utf-8')) as Record<string, unknown>;
    expect(data).toEqual(original);
  });

  it('should NOT touch unparsable auth.json', async () => {
    writeFileSync(authPath(), '{corrupted', 'utf-8');
    await ensureAuthPlaceholder(dir);
    expect(readFileSync(authPath(), 'utf-8')).toBe('{corrupted');
  });

  it('should be idempotent (seed once, second call no-op)', async () => {
    await ensureAuthPlaceholder(dir);
    const first = readFileSync(authPath(), 'utf-8');
    await ensureAuthPlaceholder(dir);
    expect(readFileSync(authPath(), 'utf-8')).toBe(first);
  });
});
