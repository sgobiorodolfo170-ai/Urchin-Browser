/**
 * model-admin/model-admin.ts · 服务层补测（P6-backfill-D，2026-11-10）
 *
 * 化解 model-admin 组 75.33/75 边际门槛：覆盖三大未测方法——
 * appendBuiltinModel（内置服务商纯 overlay 追加，无网络）、
 * refreshProviderModels（已存服务商重探测 + 手填字段优先合并，#486 并发语义）、
 * enrichModels（草稿行补参包装层：空 id 校验 + 目录 fetch 注入）。
 * fetch 一律 vi.stubGlobal，不触网。
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
let runtime: FakeRuntime;
let invalidatePiConfig: ReturnType<typeof vi.fn>;
let pushModels: ReturnType<typeof vi.fn>;

function makeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  const providers = [
    { id: 'anthropic', name: 'Anthropic', auth: { apiKey: {} } },
    { id: 'openai', name: 'OpenAI', auth: { apiKey: {} } },
  ];
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getProviderAuthStatus: () => ({ configured: false }),
    isUsingOAuth: () => false,
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
    pushModels,
    onOAuthActivated: vi.fn(),
  };
}

function lastOf(type: string): Record<string, unknown> | undefined {
  for (let i = emitted.length - 1; i >= 0; i -= 1) {
    const msg = emitted[i] as unknown as Record<string, unknown>;
    if (msg.type === type) return msg;
  }
  return undefined;
}

function readModelsJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8')) as Record<string, unknown>;
}

function makeService(): ModelAdminService {
  return new ModelAdminService(makeHost(agentDir));
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-model-admin-append-'));
  emitted = [];
  invalidatePiConfig = vi.fn();
  pushModels = vi.fn();
  runtime = makeRuntime();
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('appendBuiltinModel（内置服务商纯 overlay 追加）', () => {
  it('追加一行：models.json 生成纯 overlay 条目（无 baseUrl/api），结果 ok', async () => {
    const svc = makeService();
    await svc.appendBuiltinModel('openai', { id: 'gpt-custom-x', name: 'X' }, 1);
    const result = lastOf('append_builtin_result');
    expect(result?.ok).toBe(true);
    const providers = readModelsJson().providers as Record<string, unknown>;
    const entry = providers.openai as { models?: { id: string; name?: string }[] };
    expect(entry.models?.map((m) => m.id)).toEqual(['gpt-custom-x']);
    // 纯 overlay：不写 provider 级 baseUrl/api，compose 时从同服务商现有模型继承
    expect(entry.baseUrl).toBeUndefined();
    expect(entry.api).toBeUndefined();
    // 落盘后热重载运行时模型列表
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });

  it('重复 id 幂等：ok:true 且不重复写入', async () => {
    const svc = makeService();
    await svc.appendBuiltinModel('openai', { id: 'gpt-custom-x' }, 1);
    emitted = [];
    await svc.appendBuiltinModel('openai', { id: 'gpt-custom-x' }, 2);
    const result = lastOf('append_builtin_result');
    expect(result?.ok).toBe(true);
    const entry = (readModelsJson().providers as Record<string, unknown>).openai as {
      models?: unknown[];
    };
    expect(entry.models).toHaveLength(1);
  });

  it('空 providerId / 空 modelId / 非法 api / 非法 baseUrl / 不存在的服务商 → ok:false', async () => {
    const svc = makeService();
    await svc.appendBuiltinModel('  ', { id: 'x' }, 1);
    expect(lastOf('append_builtin_result')?.ok).toBe(false);
    await svc.appendBuiltinModel('openai', { id: '  ' }, 2);
    expect(lastOf('append_builtin_result')?.ok).toBe(false);
    await svc.appendBuiltinModel('openai', { id: 'x', api: 'bogus-api' }, 3);
    expect(String(lastOf('append_builtin_result')?.error)).toContain('接口类型无效');
    await svc.appendBuiltinModel('openai', { id: 'x', baseUrl: 'not-a-url' }, 4);
    expect(String(lastOf('append_builtin_result')?.error)).toContain('接口地址无效');
    await svc.appendBuiltinModel('no-such-provider', { id: 'x' }, 5);
    expect(String(lastOf('append_builtin_result')?.error)).toContain('不存在');
  });

  it('追加到已有条目：保留既有模型并追加新行', async () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: { openai: { baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-4o' }] } },
      }),
    );
    const svc = makeService();
    await svc.appendBuiltinModel('openai', { id: 'gpt-5' }, 1);
    const entry = (readModelsJson().providers as Record<string, unknown>).openai as {
      baseUrl?: string;
      models?: { id: string }[];
    };
    expect(entry.models?.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-5']);
    expect(entry.baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('refreshProviderModels（重探测 + 手填优先合并）', () => {
  const MODELS_RESPONSE = {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: [{ id: 'm1' }, { id: 'm2', name: 'Fetched Two', context_window: 128000 }],
      }),
    text: () => Promise.resolve(''),
  };

  it('全量新增：探测结果全部落盘，结果带 added/total', async () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          myprov: { name: 'My', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', models: [] },
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(MODELS_RESPONSE)),
    );
    const svc = makeService();
    await svc.refreshProviderModels('myprov', 7);
    const result = lastOf('refresh_provider_result');
    expect(result?.ok).toBe(true);
    expect(result?.added).toBe(2);
    expect(result?.total).toBe(2);
    const entry = (readModelsJson().providers as Record<string, unknown>).myprov as {
      models?: { id: string }[];
    };
    expect(entry.models?.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(runtime.refresh).toHaveBeenCalled();
    expect(invalidatePiConfig).toHaveBeenCalled();
  });

  it('#486 合并语义：手填字段优先，只新增缺失 id', async () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          myprov: {
            baseUrl: 'https://api.test/v1',
            models: [{ id: 'm1', name: '手填名', context_window: 999 }],
          },
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(MODELS_RESPONSE)),
    );
    const svc = makeService();
    await svc.refreshProviderModels('myprov', 7);
    const result = lastOf('refresh_provider_result');
    expect(result?.ok).toBe(true);
    expect(result?.added).toBe(1);
    const entry = (readModelsJson().providers as Record<string, unknown>).myprov as {
      models?: { id: string; name?: string; context_window?: number }[];
    };
    const m1 = entry.models?.find((m) => m.id === 'm1');
    expect(m1?.name).toBe('手填名');
    expect(m1?.context_window).toBe(999);
    expect(entry.models).toHaveLength(2);
  });

  it('裸域名 404 时自动重试 /v1/models', async () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { myprov: { baseUrl: 'https://api.test', models: [] } } }),
    );
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/models')) return Promise.resolve(MODELS_RESPONSE);
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = makeService();
    await svc.refreshProviderModels('myprov', 7);
    const result = lastOf('refresh_provider_result');
    expect(result?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('无 baseUrl（盘上与运行时都没有）→ ok:false，不发请求', async () => {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({ providers: { bare: { name: 'NoUrl' } } }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = makeService();
    await svc.refreshProviderModels('bare', 7);
    const result = lastOf('refresh_provider_result');
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain('baseUrl');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrichModels（草稿行补参包装层）', () => {
  it('空 id 列表 → ok:false 错误回执，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = makeService();
    await svc.enrichModels(3, ['  ', ''], undefined);
    const result = lastOf('enrich_models_result');
    expect(result?.ok).toBe(false);
    expect(String(result?.error)).toContain('No model ids');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('目录 fetch 命中：结果回执 + 进度事件 + 提示', async () => {
    const openrouter = JSON.stringify({
      data: [{ id: 'vendor/ctx-model', name: 'Ctx Model', context_length: 200000 }],
    });
    const modelsDev = JSON.stringify({
      'ctx-model': { name: 'Ctx Model', limit: { context: 200000 } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes('openrouter.ai')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(openrouter),
          });
        }
        if (u.includes('models.dev')) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(modelsDev) });
        }
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      }),
    );
    const svc = makeService();
    await svc.enrichModels(4, ['ctx-model'], undefined);
    const result = lastOf('enrich_models_result');
    expect(result?.ok).toBe(true);
    const results = result?.results as { id: string; status: string }[];
    expect(results.length).toBe(1);
    expect(emitted.some((m) => (m as { type: string }).type === 'enrich_models_progress')).toBe(
      true,
    );
  });

  it('目录不可达 → ok:false 且错误传播', async () => {
    // getOpenRouterCatalog 有模块级缓存：resetModules 拿全新实例，避免上个用例的缓存串场
    vi.resetModules();
    const { ModelAdminService: FreshService } = await import('../src/model-admin/model-admin');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })),
    );
    const svc = new FreshService(makeHost(agentDir));
    await svc.enrichModels(5, ['some-model'], undefined);
    const result = lastOf('enrich_models_result');
    expect(result?.ok).toBe(false);
  });
});
