/**
 * model-admin/model-admin.ts · ModelAdminService 单元测试
 *
 * 用注入的假 ModelRuntime + 临时 agentDir 覆盖服务层的读写与推送：
 * listProviders（含 officialOnly 合入）、models.json 读写、API key 多密钥
 * 生命周期（set / add / activate / remove / clear）、provider-keys 掩码、
 * OAuth 登出失败、损坏文件隔离。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelAdminService, type ModelAdminHost } from '../src/model-admin/model-admin';
import type { ModelAdminServerMessage } from '../src/model-admin/protocol-types';

interface FakeRuntime {
  getProviders: () => { id: string; name: string; auth: Record<string, unknown> }[];
  getProvider: (
    id: string,
  ) => { id: string; name: string; auth: Record<string, unknown> } | undefined;
  getProviderAuthStatus: (id: string) => { configured: boolean; source?: string };
  isUsingOAuth: (id: string) => boolean;
  getModels: () => unknown[];
  refresh: ReturnType<typeof vi.fn>;
  setRuntimeApiKey: ReturnType<typeof vi.fn>;
  removeRuntimeApiKey: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
}

let agentDir: string;
let emitted: ModelAdminServerMessage[];
let host: ModelAdminHost;
let runtime: FakeRuntime;
let invalidatePiConfig: ReturnType<typeof vi.fn>;
let pushModels: ReturnType<typeof vi.fn>;

function makeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  const providers = [
    { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {}, oauth: { name: 'Claude' } } },
    { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
  ];
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getProviderAuthStatus: (id: string) =>
      id === 'anthropic' ? { configured: true, source: 'stored' } : { configured: false },
    isUsingOAuth: (id: string) => id === 'anthropic',
    getModels: () => [],
    refresh: vi.fn(() => Promise.resolve({ errors: new Map() })),
    setRuntimeApiKey: vi.fn(() => Promise.resolve()),
    removeRuntimeApiKey: vi.fn(() => Promise.resolve()),
    logout: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function makeHost(dir: string): ModelAdminHost {
  return {
    agentDir: dir,
    emit: (msg) => emitted.push(msg),
    flushSnapshot: vi.fn(),
    isDisposed: () => false,
    modelRuntime: () => runtime as never,
    invalidatePiConfig,
    pushModels: pushModels,
    onOAuthActivated: vi.fn(),
  };
}

function lastOf(type: string): Record<string, unknown> | undefined {
  for (let i = emitted.length - 1; i >= 0; i--) {
    const msg = emitted[i] as unknown as Record<string, unknown>;
    if (msg.type === type) return msg;
  }
  return undefined;
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, name), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-model-admin-'));
  emitted = [];
  runtime = makeRuntime();
  invalidatePiConfig = vi.fn();
  pushModels = vi.fn(() => Promise.resolve());
  host = makeHost(agentDir);
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('listProviders', () => {
  it('should emit mapped provider statuses', async () => {
    const service = new ModelAdminService(host);
    await service.listProviders();
    const msg = lastOf('providers_status');
    expect(msg?.providers).toEqual([
      {
        id: 'anthropic',
        name: 'Anthropic',
        configured: true,
        source: 'stored',
        supportsApiKey: true,
        supportsOAuth: true,
        oauthName: 'Claude',
        usingOAuth: true,
      },
      {
        id: 'openai',
        name: 'OpenAI',
        configured: false,
        source: undefined,
        supportsApiKey: true,
        supportsOAuth: false,
        oauthName: undefined,
        usingOAuth: false,
      },
    ]);
  });

  it('should tolerate a provider whose auth status throws', async () => {
    runtime.getProviderAuthStatus = (id: string) => {
      if (id === 'openai') throw new Error('bad provider');
      return { configured: true, source: 'stored' };
    };
    const service = new ModelAdminService(host);
    await service.listProviders();
    const providers = lastOf('providers_status')?.providers as Record<string, unknown>[];
    expect(providers.find((p) => p.id === 'openai')).toMatchObject({
      configured: false,
      usingOAuth: false,
    });
  });

  it('should report a notice when the runtime provider list throws', async () => {
    runtime.getProviders = () => {
      throw new Error('runtime down');
    };
    const service = new ModelAdminService(host);
    await service.listProviders();
    expect(lastOf('providers_status')).toBeUndefined();
    expect(lastOf('notice')).toMatchObject({ level: 'error' });
    expect(String(lastOf('notice')?.textEn)).toContain('runtime down');
  });

  it('should append officialOnly rows from the cache file', async () => {
    writeFileSync(join(agentDir, 'official-providers.json'), JSON.stringify(['newco', 'openai']));
    const service = new ModelAdminService(host);
    await service.listProviders();
    const providers = lastOf('providers_status')?.providers as Record<string, unknown>[];
    expect(providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'newco']);
    expect(providers[2]).toMatchObject({ id: 'newco', officialOnly: true, configured: false });
  });

  it('should ignore an empty or corrupt official cache', async () => {
    writeFileSync(join(agentDir, 'official-providers.json'), '[]');
    const service = new ModelAdminService(host);
    await service.listProviders();
    const providers = lastOf('providers_status')?.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(2);
  });
});

describe('models.json config', () => {
  const modelsJson = `{
    // hand written
    "providers": {
      "acme": {
        "name": "Acme",
        "api": "openai-completions",
        "baseUrl": "https://acme.local/v1",
        "apiKey": "sk-secret",
        "headers": { "Authorization": "Bearer sk-secret" },
        "models": [
          {
            "id": "acme-1",
            "name": "Acme One",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 8192,
            "thinkingLevelMap": { "high": "HIGH", "bogus": "x" },
            "cost": { "input": 1 }
          }
        ]
      }
    }
  }`;

  it('should list custom providers without leaking secrets or headers', async () => {
    writeFileSync(join(agentDir, 'models.json'), modelsJson);
    const service = new ModelAdminService(host);
    await service.listModelsConfig();
    const providers = lastOf('models_config')?.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual({
      providerId: 'acme',
      name: 'Acme',
      api: 'openai-completions',
      baseUrl: 'https://acme.local/v1',
      hasApiKey: true,
      authHeader: undefined,
      models: [
        {
          id: 'acme-1',
          name: 'Acme One',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 128000,
          maxTokens: 8192,
          thinkingLevelMap: { high: 'HIGH' },
        },
      ],
    });
    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('Authorization');
  });

  it('should treat a missing models.json as empty', async () => {
    const service = new ModelAdminService(host);
    await service.listModelsConfig();
    expect(lastOf('models_config')?.providers).toEqual([]);
  });

  it('should save a provider and preserve unknown fields', async () => {
    writeFileSync(join(agentDir, 'models.json'), modelsJson);
    const service = new ModelAdminService(host);
    await service.saveModelConfig('acme', {
      providerId: 'acme',
      name: 'Acme Renamed',
      api: 'openai-completions',
      baseUrl: 'https://acme.local/v1',
      models: [{ id: 'acme-1', name: 'Acme One (new)' }],
    });
    const saved = readJson('models.json') as {
      providers: Record<string, Record<string, unknown>>;
    };
    const entry = saved.providers.acme;
    expect(entry?.name).toBe('Acme Renamed');
    expect(entry?.headers).toEqual({ Authorization: 'Bearer sk-secret' });
    expect(entry?.apiKey).toBe('sk-secret');
    const models = entry?.models as Record<string, unknown>[];
    expect(models[0]).toMatchObject({
      id: 'acme-1',
      name: 'Acme One (new)',
      cost: { input: 1 },
      thinkingLevelMap: { high: 'HIGH' },
    });
    expect(runtime.refresh).toHaveBeenCalled();
    expect(lastOf('models_config')).toBeDefined();
    expect(String(lastOf('notice')?.textEn)).toContain('Saved provider');
  });

  it('should reject an invalid provider id or an empty model list', async () => {
    const service = new ModelAdminService(host);
    await service.saveModelConfig('../evil', { providerId: '../evil', models: [{ id: 'm' }] });
    expect(String(lastOf('notice')?.textEn)).toContain('Invalid provider ID');
    await service.saveModelConfig('ok-provider', { providerId: 'ok-provider', models: [] });
    expect(String(lastOf('notice')?.textEn)).toContain('At least one model');
  });

  it('should delete an existing provider and refresh', async () => {
    writeFileSync(join(agentDir, 'models.json'), modelsJson);
    const service = new ModelAdminService(host);
    await service.deleteModelConfig('acme');
    const saved = readJson('models.json') as { providers: Record<string, unknown> };
    expect(saved.providers).toEqual({});
    expect(runtime.refresh).toHaveBeenCalled();
    expect(invalidatePiConfig).toHaveBeenCalled();
    expect(String(lastOf('notice')?.textEn)).toContain('Deleted provider');
  });

  it('should report a missing provider on delete', async () => {
    const service = new ModelAdminService(host);
    await service.deleteModelConfig('ghost');
    expect(String(lastOf('notice')?.textEn)).toContain('does not exist');
  });
});

describe('API key lifecycle', () => {
  it('should reject an empty provider id or key', async () => {
    const service = new ModelAdminService(host);
    await service.setProviderApiKey('  ', 'k');
    expect(String(lastOf('notice')?.textEn)).toContain('Enter a provider ID');
    await service.setProviderApiKey('openai', '   ');
    expect(String(lastOf('notice')?.textEn)).toContain('Enter an API key');
  });

  it('should store a key in auth.json and provider-keys.json and apply it', async () => {
    const service = new ModelAdminService(host);
    await service.setProviderApiKey('openai', '  sk-openai  ');

    expect(readJson('auth.json')).toMatchObject({
      openai: { type: 'api_key', key: 'sk-openai' },
    });
    expect(readJson('provider-keys.json')).toEqual({
      openai: { activeKeyName: '密钥 1', keys: [{ name: '密钥 1', apiKey: 'sk-openai' }] },
    });
    expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('openai', 'sk-openai');
    expect(runtime.refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ['openai'] });
    expect(invalidatePiConfig).toHaveBeenCalled();

    const keysMsg = lastOf('provider_keys');
    expect(keysMsg?.keys).toEqual({ openai: [{ name: '密钥 1', active: true }] });
    expect(JSON.stringify(keysMsg)).not.toContain('sk-openai');
  });

  it('should reactivate an existing key instead of duplicating it', async () => {
    const service = new ModelAdminService(host);
    await service.setProviderApiKey('openai', 'sk-1');
    await service.addProviderKey('openai', 'sk-2');
    await service.setProviderApiKey('openai', 'sk-1');
    const stored = readJson('provider-keys.json') as {
      openai: { activeKeyName: string; keys: { name: string }[] };
    };
    expect(stored.openai.keys).toHaveLength(2);
    expect(stored.openai.activeKeyName).toBe('密钥 1');
  });

  it('should stack secondary keys without activating them', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-first');
    await service.addProviderKey('openai', 'sk-second', 'work');
    const stored = readJson('provider-keys.json') as {
      openai: { activeKeyName: string; keys: { name: string; apiKey: string }[] };
    };
    expect(stored.openai.keys).toEqual([
      { name: '密钥 1', apiKey: 'sk-first' },
      { name: 'work', apiKey: 'sk-second' },
    ]);
    expect(stored.openai.activeKeyName).toBe('密钥 1');
    expect(service.getActiveKeyName('openai')).toBe('密钥 1');
    expect(service.hasProviderKey('openai', 'work')).toBe(true);
    expect(service.hasProviderKey('openai', 'ghost')).toBe(false);
  });

  it('should deduplicate a key name on collision', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-1', 'work');
    await service.addProviderKey('openai', 'sk-2', 'work');
    const stored = readJson('provider-keys.json') as {
      openai: { keys: { name: string }[] };
    };
    expect(stored.openai.keys.map((k) => k.name)).toEqual(['work', 'work (2)']);
  });

  it('should report a duplicate key on add', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-same');
    await service.addProviderKey('openai', 'sk-same');
    expect(String(lastOf('notice')?.textEn)).toContain('already has this key');
  });

  it('should activate a stored key by name', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-1');
    await service.addProviderKey('openai', 'sk-2', 'second');
    await expect(service.activateProviderKey('openai', 'second')).resolves.toBe(true);
    expect(service.getActiveKeyName('openai')).toBe('second');
    expect(runtime.setRuntimeApiKey).toHaveBeenLastCalledWith('openai', 'sk-2');
  });

  it('should fail activation for an unknown key name', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-1');
    await expect(service.activateProviderKey('openai', 'nope')).resolves.toBe(false);
    expect(service.getActiveKeyName('openai')).toBe('密钥 1');
  });

  it('should fall back to the first remaining key when the active one is removed', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-1');
    await service.addProviderKey('openai', 'sk-2', 'second');
    await service.activateProviderKey('openai', 'second');
    await service.removeProviderKey('openai', 'second');
    expect(service.getActiveKeyName('openai')).toBe('密钥 1');
    expect(runtime.setRuntimeApiKey).toHaveBeenLastCalledWith('openai', 'sk-1');
  });

  it('should clear auth.json and runtime when the last key is removed', async () => {
    const service = new ModelAdminService(host);
    await service.addProviderKey('openai', 'sk-only');
    await service.removeProviderKey('openai', '密钥 1');
    expect(readJson('auth.json')).not.toHaveProperty('openai');
    expect(readJson('provider-keys.json')).toEqual({});
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('openai');
    expect(String(lastOf('notice')?.textEn)).toContain('now unconfigured');
  });

  it('should warn when removing an unknown key', async () => {
    const service = new ModelAdminService(host);
    await service.removeProviderKey('openai', 'ghost');
    expect(String(lastOf('notice')?.textEn)).toContain('does not exist');
  });

  it('should refuse to clear a key while OAuth is in use', async () => {
    const service = new ModelAdminService(host);
    await service.clearProviderApiKey('anthropic');
    expect(String(lastOf('notice')?.textEn)).toContain('OAuth sign-out');
  });

  it('should clear a stored key for a non-OAuth provider', async () => {
    const service = new ModelAdminService(host);
    await service.setProviderApiKey('openai', 'sk-1');
    await service.clearProviderApiKey('openai');
    expect(readJson('auth.json')).not.toHaveProperty('openai');
    expect(readJson('provider-keys.json')).toEqual({});
    expect(runtime.removeRuntimeApiKey).toHaveBeenCalledWith('openai');
  });

  it('should report an already-clear provider', async () => {
    const service = new ModelAdminService(host);
    await service.clearProviderApiKey('openai');
    expect(String(lastOf('notice')?.textEn)).toContain('has no saved key');
  });

  it('should require a provider id when clearing', async () => {
    const service = new ModelAdminService(host);
    await service.clearProviderApiKey('   ');
    expect(String(lastOf('notice')?.textEn)).toContain('Enter a provider ID');
  });

  it('should seed provider keys from a legacy auth.json key', () => {
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-legacy' } }),
    );
    const service = new ModelAdminService(host);
    service.listProviderKeys();
    const stored = readJson('provider-keys.json') as {
      openai?: { activeKeyName: string | null; keys: { name: string; apiKey: string }[] };
    };
    expect(stored.openai).toEqual({
      activeKeyName: '密钥 1',
      keys: [{ name: '密钥 1', apiKey: 'sk-legacy' }],
    });
  });

  it('should quarantine a corrupt provider-keys file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(agentDir, 'provider-keys.json'), '{broken');
    const service = new ModelAdminService(host);
    service.listProviderKeys();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(lastOf('provider_keys')?.keys)).not.toContain('broken');
    warn.mockRestore();
  });
});

describe('OAuth logout', () => {
  it('should report failure for a provider without OAuth', async () => {
    const service = new ModelAdminService(host);
    await service.logoutProviderOAuth('openai');
    expect(lastOf('provider_oauth_logout_result')).toMatchObject({
      provider: 'openai',
      ok: false,
    });
  });

  it('should log out an OAuth provider and refresh', async () => {
    const service = new ModelAdminService(host);
    await service.logoutProviderOAuth('anthropic');
    expect(runtime.logout).toHaveBeenCalledWith('anthropic');
    expect(lastOf('provider_oauth_logout_result')).toMatchObject({
      provider: 'anthropic',
      ok: true,
    });
  });
});

describe('disposal helpers', () => {
  it('should abort enrich jobs without throwing', () => {
    const service = new ModelAdminService(host);
    expect(() => service.abortEnrichModels()).not.toThrow();
    expect(() => service.abortEnrichModels(42)).not.toThrow();
    expect(() => service.dispose()).not.toThrow();
  });

  it('should delegate OAuth flow listing', () => {
    const service = new ModelAdminService(host);
    service.listProviderOAuthFlows();
    expect(lastOf('provider_oauth_flows')).toEqual({
      type: 'provider_oauth_flows',
      flows: [],
    });
  });
});
