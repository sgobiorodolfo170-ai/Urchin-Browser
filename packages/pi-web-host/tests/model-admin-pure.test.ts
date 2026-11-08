/**
 * model-admin/model-admin.ts 纯函数单元测试
 *
 * 只覆盖无 IO / 无 SDK 的导出：overlay 转正、表单合并、推理能力推断、
 * 思考档位映射、档位表清洗、凭据文件写入。ModelAdminService 本体走
 * tests/model-admin.test.ts 与 tests/model-admin-service.test.ts。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  graduateOverlayModels,
  mergeProviderConfigEntry,
  detectReasoningCapability,
  buildThinkingLevelMapFromMeta,
  sanitizeThinkingLevelMap,
  writeCredentialFile,
  ensureCredentialFilePermissions,
} from '../src/model-admin/model-admin';
import type { UiModelConfigEntry, UiProviderConfig } from '../src/model-admin/protocol-types';

/** Minimal valid form (providerId/models are required, everything else optional). */
function cfg(over: Partial<UiProviderConfig> = {}): UiProviderConfig {
  return { providerId: 'p', models: [], ...over };
}

const official = {
  opencode: {
    'union-alpha-free': 'openai-completions',
    'kimi-k2.6': 'anthropic-messages',
  },
} as Record<string, Record<string, string | undefined>>;

describe('graduateOverlayModels', () => {
  it('should remove a bare-id row once the official catalog lists it', () => {
    const providers = {
      opencode: { models: [{ id: 'union-alpha-free' }, { id: 'my-local' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([
      { providerId: 'opencode', modelId: 'union-alpha-free' },
    ]);
    expect(providers.opencode?.models).toEqual([{ id: 'my-local' }]);
  });

  it('should graduate a row whose explicit api matches the official one', () => {
    const providers = {
      opencode: { models: [{ id: 'union-alpha-free', api: 'openai-completions' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([
      { providerId: 'opencode', modelId: 'union-alpha-free' },
    ]);
    expect(providers).not.toHaveProperty('opencode');
  });

  it('should keep rows with their own baseUrl', () => {
    const providers = {
      opencode: {
        models: [
          { id: 'union-alpha-free', baseUrl: 'https://proxy.local/v1' },
          {
            id: 'union-alpha-free',
            api: 'openai-completions',
            baseUrl: 'https://proxy.local/v1',
          },
        ],
      },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([]);
    expect(providers.opencode?.models).toHaveLength(2);
  });

  it('should keep rows with a different api', () => {
    const providers = {
      opencode: { models: [{ id: 'union-alpha-free', api: 'anthropic-messages' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([]);
    expect(providers.opencode?.models).toEqual([
      { id: 'union-alpha-free', api: 'anthropic-messages' },
    ]);
  });

  it('should graduate only bare rows when the official api is unknown', () => {
    const providers = {
      opencode: {
        models: [{ id: 'mystery-model' }, { id: 'mystery-model-2', api: 'openai-completions' }],
      },
    } as Record<string, Record<string, unknown>>;
    const officialUnknown = {
      opencode: { 'mystery-model': undefined, 'mystery-model-2': undefined },
    } as Record<string, Record<string, string | undefined>>;
    expect(graduateOverlayModels(providers, officialUnknown)).toEqual([
      { providerId: 'opencode', modelId: 'mystery-model' },
    ]);
    expect(providers.opencode?.models).toEqual([
      { id: 'mystery-model-2', api: 'openai-completions' },
    ]);
  });

  it('should delete a provider entry that graduates to nothing and has no other keys', () => {
    const providers = {
      opencode: { models: [{ id: 'union-alpha-free' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([
      { providerId: 'opencode', modelId: 'union-alpha-free' },
    ]);
    expect(providers).not.toHaveProperty('opencode');
  });

  it('should keep an entry with other keys and only clear models', () => {
    const providers = {
      opencode: { apiKey: 'sk-xxx', models: [{ id: 'union-alpha-free' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([
      { providerId: 'opencode', modelId: 'union-alpha-free' },
    ]);
    expect(providers.opencode).toEqual({ apiKey: 'sk-xxx', models: [] });
  });

  it('should ignore ids the official catalog does not list and providers without official data', () => {
    const providers = {
      opencode: { models: [{ id: 'future-model' }] },
      other: { models: [{ id: 'union-alpha-free' }] },
    } as Record<string, Record<string, unknown>>;
    expect(graduateOverlayModels(providers, official)).toEqual([]);
    expect(providers.opencode?.models).toEqual([{ id: 'future-model' }]);
    expect(providers.other?.models).toEqual([{ id: 'union-alpha-free' }]);
  });

  it('should not throw on dirty data', () => {
    const providers = {
      broken: { models: 'nope' },
      messy: { models: [null, 42, { id: 7 }, { id: '  ' }] },
    } as unknown as Record<string, Record<string, unknown>>;
    const dirty = {
      broken: { x: 'openai-completions' },
      messy: { x: 'openai-completions' },
    } as Record<string, Record<string, string | undefined>>;
    expect(() => graduateOverlayModels(providers, dirty)).not.toThrow();
    expect(graduateOverlayModels(providers, dirty)).toEqual([]);
  });
});

describe('mergeProviderConfigEntry', () => {
  it('should build a minimal entry from an empty form', () => {
    expect(mergeProviderConfigEntry(undefined, cfg(), [])).toEqual({ models: [] });
  });

  it('should preserve provider fields the form does not know', () => {
    const prev = { headers: { 'X-Tenant': 'a' }, models: [] };
    const merged = mergeProviderConfigEntry(prev, cfg({ name: 'Acme' }), []);
    expect(merged.headers).toEqual({ 'X-Tenant': 'a' });
    expect(merged.name).toBe('Acme');
  });

  it('should trim provider fields and drop cleared optionals', () => {
    const prev = { name: 'Old', api: 'openai-completions', baseUrl: 'https://old' };
    const merged = mergeProviderConfigEntry(prev, cfg({ name: '  ', api: '', baseUrl: '  ' }), []);
    expect(merged).not.toHaveProperty('name');
    expect(merged).not.toHaveProperty('api');
    expect(merged).not.toHaveProperty('baseUrl');
  });

  it('should keep the stored apiKey when the form omits it', () => {
    const prev = { apiKey: 'sk-old' };
    expect(mergeProviderConfigEntry(prev, cfg(), []).apiKey).toBe('sk-old');
  });

  it('should clear the apiKey when the form sends an empty string', () => {
    const prev = { apiKey: 'sk-old' };
    expect(mergeProviderConfigEntry(prev, cfg({ apiKey: '' }), [])).not.toHaveProperty('apiKey');
    expect(mergeProviderConfigEntry(prev, cfg({ apiKey: '   ' }), [])).not.toHaveProperty('apiKey');
  });

  it('should store a trimmed apiKey', () => {
    expect(mergeProviderConfigEntry(undefined, cfg({ apiKey: '  sk-new  ' }), []).apiKey).toBe(
      'sk-new',
    );
  });

  it('should set authHeader only when enabled', () => {
    expect(mergeProviderConfigEntry(undefined, cfg({ authHeader: true }), []).authHeader).toBe(
      true,
    );
    expect(
      mergeProviderConfigEntry({ authHeader: true }, cfg({ authHeader: false }), []),
    ).not.toHaveProperty('authHeader');
  });

  it('should keep unknown model fields for ids present in the form', () => {
    const prev = {
      models: [
        { id: 'm1', api: 'anthropic-messages', baseUrl: 'https://x', cost: { input: 1 } },
        { id: 'legacy' },
      ],
    };
    const form: UiModelConfigEntry[] = [{ id: 'm1', name: '  New name  ' }];
    const merged = mergeProviderConfigEntry(prev, cfg(), form);
    expect(merged.models).toEqual([
      {
        id: 'm1',
        api: 'anthropic-messages',
        baseUrl: 'https://x',
        cost: { input: 1 },
        name: 'New name',
      },
    ]);
  });

  it('should treat the form model list as the full set', () => {
    const prev = { models: [{ id: 'a' }, { id: 'b' }] };
    const merged = mergeProviderConfigEntry(prev, cfg(), [{ id: 'b' }]);
    expect(merged.models).toEqual([{ id: 'b' }]);
  });

  it('should drop optional model fields when the form clears them', () => {
    const prev = {
      models: [
        {
          id: 'm1',
          name: 'Old',
          reasoning: true,
          input: ['text'],
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
    };
    const merged = mergeProviderConfigEntry(prev, cfg(), [{ id: 'm1' }]);
    expect(merged.models).toEqual([{ id: 'm1' }]);
  });

  it('should coerce numeric model fields and keep arrays', () => {
    const merged = mergeProviderConfigEntry(undefined, cfg(), [
      {
        id: 'm1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: '128000' as unknown as number,
        maxTokens: 8192,
      },
    ]);
    expect(merged.models).toEqual([
      {
        id: 'm1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ]);
  });

  it('should keep a hand-written thinkingLevelMap when the form omits it', () => {
    const prev = { models: [{ id: 'm1', thinkingLevelMap: { xhigh: 'max' } }] };
    const merged = mergeProviderConfigEntry(prev, cfg(), [{ id: 'm1' }]);
    expect((merged.models as Record<string, unknown>[])[0]).toEqual({
      id: 'm1',
      thinkingLevelMap: { xhigh: 'max' },
    });
  });

  it('should overwrite thinkingLevelMap when the form provides one', () => {
    const prev = { models: [{ id: 'm1', thinkingLevelMap: { xhigh: 'max' } }] };
    const merged = mergeProviderConfigEntry(prev, cfg(), [
      { id: 'm1', thinkingLevelMap: { high: 'HIGH' } },
    ]);
    expect((merged.models as Record<string, unknown>[])[0]?.thinkingLevelMap).toEqual({
      high: 'HIGH',
    });
  });
});

describe('detectReasoningCapability', () => {
  it('should return false for an empty id', () => {
    expect(detectReasoningCapability('')).toBe(false);
  });

  it('should honour explicit metadata flags', () => {
    expect(detectReasoningCapability('plain-model', { reasoning: true })).toBe(true);
    expect(detectReasoningCapability('plain-model', { supports_reasoning: true })).toBe(true);
    expect(detectReasoningCapability('plain-model', { modalities: ['text', 'reasoning'] })).toBe(
      true,
    );
    expect(detectReasoningCapability('plain-model', { input_modalities: ['reasoning'] })).toBe(
      true,
    );
  });

  it('should detect explicit reasoning words', () => {
    expect(detectReasoningCapability('claude-sonnet-4-thinking')).toBe(true);
    expect(detectReasoningCapability('acme-reasoner-v2')).toBe(true);
  });

  it('should detect the OpenAI o-series without false positives', () => {
    for (const id of ['o1', 'o1-mini', 'o1-preview', 'o3-mini', 'o3-high', 'o4', 'o4-max']) {
      expect(detectReasoningCapability(id)).toBe(true);
    }
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'o1x', 'orca-7b']) {
      expect(detectReasoningCapability(id)).toBe(false);
    }
  });

  it('should detect DeepSeek R1 / QwQ / GLM-Zero / CoT families', () => {
    expect(detectReasoningCapability('deepseek-r1')).toBe(true);
    expect(detectReasoningCapability('r1-distill-qwen')).toBe(true);
    expect(detectReasoningCapability('qwq-32b-preview')).toBe(true);
    expect(detectReasoningCapability('glm-4-zero')).toBe(true);
    expect(detectReasoningCapability('glm-zero')).toBe(true);
    expect(detectReasoningCapability('cot-model')).toBe(true);
  });

  it('should not treat a non-reasoning name as reasoning', () => {
    expect(detectReasoningCapability('qwen3-32b')).toBe(false);
    expect(detectReasoningCapability('llama-3.1-70b')).toBe(false);
    expect(detectReasoningCapability('gpt-4.1')).toBe(false);
  });

  it('should ignore malformed metadata values', () => {
    expect(
      detectReasoningCapability('plain', {
        reasoning: 'yes',
        modalities: 'reasoning',
      }),
    ).toBe(false);
  });
});

describe('buildThinkingLevelMapFromMeta', () => {
  it('should return undefined without level metadata', () => {
    expect(buildThinkingLevelMapFromMeta()).toBeUndefined();
    expect(buildThinkingLevelMapFromMeta({})).toBeUndefined();
    expect(buildThinkingLevelMapFromMeta({ reasoning: true })).toBeUndefined();
  });

  it('should map advertised levels and null the rest', () => {
    expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ['low', 'high'] })).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    });
  });

  it('should return undefined when the result equals the pi default set', () => {
    expect(
      buildThinkingLevelMapFromMeta({
        reasoning_levels: ['minimal', 'low', 'medium', 'high'],
      }),
    ).toBeUndefined();
  });

  it('should keep an explicit off literal', () => {
    expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ['none', 'low'] })).toEqual({
      off: 'none',
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it('should ignore metadata that only advertises off', () => {
    expect(
      buildThinkingLevelMapFromMeta({ reasoning_levels: ['none', 'disabled'] }),
    ).toBeUndefined();
  });

  it('should accept object-array effort forms and normalise aliases', () => {
    expect(
      buildThinkingLevelMapFromMeta({
        supported_reasoning_levels: [{ effort: 'HIGH' }, { effort: 'max' }],
      }),
    ).toMatchObject({ high: 'HIGH', max: 'max' });
  });

  it('should accept comma-separated strings and wrapper objects', () => {
    expect(buildThinkingLevelMapFromMeta({ thinking_levels: 'low, x-high' })).toMatchObject({
      low: 'low',
      xhigh: 'x-high',
    });
    expect(
      buildThinkingLevelMapFromMeta({ reasoning_levels: { levels: ['medium'] } }),
    ).toMatchObject({ medium: 'medium' });
  });

  it('should read dictionary shapes and skip false entries', () => {
    expect(
      buildThinkingLevelMapFromMeta({ reasoning_levels: { low: true, high: false } }),
    ).toMatchObject({ low: 'low' });
  });

  it('should return undefined for unknown tokens only', () => {
    expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ['turbo'] })).toBeUndefined();
  });

  it('should keep the first token when a level is advertised twice', () => {
    expect(buildThinkingLevelMapFromMeta({ reasoning_levels: ['low', 'min'] })).toMatchObject({
      low: 'low',
    });
  });
});

describe('sanitizeThinkingLevelMap', () => {
  it('should reject non-object input', () => {
    expect(sanitizeThinkingLevelMap(undefined)).toBeUndefined();
    expect(sanitizeThinkingLevelMap(null)).toBeUndefined();
    expect(sanitizeThinkingLevelMap('x')).toBeUndefined();
    expect(sanitizeThinkingLevelMap(['low'])).toBeUndefined();
  });

  it('should keep null and trimmed strings for known levels only', () => {
    expect(sanitizeThinkingLevelMap({ low: '  low  ', high: null, xhigh: '', bogus: 'x' })).toEqual(
      { low: 'low', high: null },
    );
  });

  it('should return undefined when nothing usable remains', () => {
    expect(sanitizeThinkingLevelMap({ bogus: 'x', high: '' })).toBeUndefined();
    expect(sanitizeThinkingLevelMap({ high: 42 })).toBeUndefined();
  });
});

describe('credential file helpers', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('should create parent directories and write the payload', () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-cred-'));
    const target = join(dir, 'nested', 'auth.json');
    writeCredentialFile(target, '{"k":"v"}');
    expect(readFileSync(target, 'utf8')).toBe('{"k":"v"}');
  });

  it('should be a no-op for missing credential files', () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-cred-'));
    expect(() => ensureCredentialFilePermissions(dir!)).not.toThrow();
  });

  it('should fix permissions of existing credential files on POSIX', () => {
    if (process.platform === 'win32') return;
    dir = mkdtempSync(join(tmpdir(), 'pi-cred-'));
    const target = join(dir, 'provider-keys.json');
    writeCredentialFile(target, '{}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
