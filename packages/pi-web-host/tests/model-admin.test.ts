/**
 * 模型管理域（第五批对接）集成测试。
 *
 * 通过 modelRuntimeFactory 注入假 ModelRuntime，走真实 server.ts 的 WS 消息
 * 链路（真端口 + 真 ws 客户端），验证：
 * 1. list_providers → providers_status（runtime 服务商清单）
 * 2. officialOnly 合入（agentDir/official-providers.json 缓存 → 占位行）
 * 3. add_provider_key → provider_keys 推送
 * 4. save_model_config → models_config 推送 + 落盘 + list_models_config 回读
 * 5. refresh_builtin_models → refresh_builtin_result + 官方索引落盘 + officialOnly 行
 * 6. test_model_connection 失败路径回执
 * 7. set_default_model / clear_default_model → default_model echo
 *
 * 注意：model-admin 域对 pi SDK 只有 type 导入（运行时零值导入），注入假工厂
 * 后整条链路不加载 vendored SDK——无需 vi.mock。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startPiWebHostServer, type PiWebHostServerHandle } from '../src/server';

const handles: PiWebHostServerHandle[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.close().catch(() => undefined);
  }
  vi.unstubAllGlobals();
});

/** model-admin 域用到的 ModelRuntime 最小假件（见 dispatch/runtime-holder 契约） */
function makeFakeRuntime(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const providers = [
    { id: 'anthropic', name: 'Anthropic', auth: { apiKey: { type: 'api' } } },
    { id: 'openai', name: 'OpenAI', auth: {} },
  ];
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getProviderAuthStatus: () => ({ configured: false, source: 'none' }),
    isUsingOAuth: () => false,
    getModels: () => [{ api: 'openai-completions', id: 'fake-model' }],
    getRegisteredProviderIds: () => providers.map((p) => p.id),
    refresh: () => Promise.resolve({ errors: new Map() }),
    setRuntimeApiKey: () => undefined,
    removeRuntimeApiKey: () => undefined,
    ...overrides,
  };
}

interface TestClient {
  ws: WebSocket;
  all: Record<string, unknown>[];
  send: (msg: Record<string, unknown>) => void;
  waitFor: (
    pred: (m: Record<string, unknown>) => boolean,
    label: string,
  ) => Promise<Record<string, unknown>>;
}

function connect(handle: PiWebHostServerHandle): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=${handle.token}`);
    const all: Record<string, unknown>[] = [];
    const waiters: {
      pred: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
      label: string;
    }[] = [];
    ws.on('error', reject);
    ws.on('message', (data) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(
          Buffer.isBuffer(data)
            ? data.toString('utf8')
            : ArrayBuffer.isView(data) || data instanceof ArrayBuffer
              ? Buffer.from(data as ArrayBuffer).toString('utf8')
              : String(data),
        ) as Record<string, unknown>;
      } catch {
        return;
      }
      all.push(m);
      // 只移除已匹配的 waiter，未命中的保留（否则先到的消息会吞掉后续等待）
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]?.pred(m)) {
          const w = waiters.splice(i, 1)[0];
          w?.resolve(m);
        }
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', client: 'model-admin-test' }));
      resolve({
        ws,
        all,
        send: (msg) => ws.send(JSON.stringify(msg)),
        waitFor: (pred, label) =>
          new Promise((res, rej) => {
            const hit = all.find(pred);
            if (hit) {
              res(hit);
              return;
            }
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    'waitFor 超时: ' + label + '；已收到 ' + all.map((m) => m.type).join(','),
                  ),
                ),
              8_000,
            );
            waiters.push({
              pred,
              label,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          }),
      });
    });
  });
}

async function startServer(
  agentFiles?: Record<string, string>,
  runtimeOverrides?: Record<string, unknown>,
): Promise<{
  handle: PiWebHostServerHandle;
  agentDir: string;
}> {
  const agentDir = mkdtempSync(join(tmpdir(), 'piwh-ma-'));
  for (const [name, content] of Object.entries(agentFiles ?? {})) {
    writeFileSync(join(agentDir, name), content);
  }
  const wwwDir = mkdtempSync(join(tmpdir(), 'piwh-ma-www-'));
  writeFileSync(join(wwwDir, 'index.html'), '<!doctype html><html><body>pi-web</body></html>');
  const fakeRuntime = makeFakeRuntime(runtimeOverrides);
  const handle = await startPiWebHostServer({
    wwwDir,
    agentDir,
    modelRuntimeFactory: () => Promise.resolve(fakeRuntime as never),
  });
  handles.push(handle);
  return { handle, agentDir };
}

describe('模型管理域（第五批对接）', () => {
  it('list_providers 返回 runtime 服务商清单；无缓存时不追加 officialOnly 行', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({ type: 'list_providers' });
    const msg = await c.waitFor((m) => m.type === 'providers_status', 'providers_status');
    const providers = msg.providers as { id: string; officialOnly?: boolean }[];
    expect(providers.map((p) => p.id)).toEqual(['anthropic', 'openai']);
    expect(providers.some((p) => p.officialOnly)).toBe(false);
  });

  it('official-providers.json 缓存中本地未内置的 id 以 officialOnly 占位行合入', async () => {
    const { handle } = await startServer({
      'official-providers.json': JSON.stringify([
        'anthropic',
        'openai',
        'qwen-token-plan-individual-cn',
      ]),
    });
    const c = await connect(handle);
    c.send({ type: 'list_providers' });
    const msg = await c.waitFor((m) => m.type === 'providers_status', 'providers_status');
    const providers = msg.providers as {
      id: string;
      officialOnly?: boolean;
      configured: boolean;
    }[];
    expect(providers).toHaveLength(3);
    const last = providers[providers.length - 1];
    expect(last.id).toBe('qwen-token-plan-individual-cn');
    expect(last.officialOnly).toBe(true);
    expect(last.configured).toBe(false);
  });

  it('add_provider_key 后推送 provider_keys（昵称回显、明文不下发）', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({
      type: 'add_provider_key',
      provider: 'anthropic',
      apiKey: 'sk-e2e-secret',
      name: 'k1',
    });
    const msg = await c.waitFor((m) => m.type === 'provider_keys', 'provider_keys');
    const keys = (msg.keys as Record<string, { name: string; active: boolean }[]>).anthropic;
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe('k1');
    expect(keys[0].active).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('sk-e2e-secret');
  });

  it('save_model_config 持久化 models.json 并经 list_models_config 回读', async () => {
    const { handle, agentDir } = await startServer();
    const c = await connect(handle);
    c.send({
      type: 'save_model_config',
      providerId: 'e2e-prov',
      config: {
        providerId: 'e2e-prov',
        name: 'E2E 测试服务商',
        baseUrl: 'http://127.0.0.1:9',
        models: [{ id: 'm1' }],
      },
    });
    await c.waitFor((m) => m.type === 'models_config', 'models_config after save');
    const raw = readFileSync(join(agentDir, 'models.json'), 'utf8');
    expect(raw).toContain('e2e-prov');
    c.send({ type: 'list_models_config' });
    const again = await c.waitFor((m) => m.type === 'models_config', 'models_config on list');
    const providers = again.providers as { providerId: string; hasApiKey?: boolean }[];
    expect(providers.some((p) => p.providerId === 'e2e-prov')).toBe(true);
  });

  it('refresh_builtin_models：假 runtime refresh + 官方索引 fetch → 结果回执 + 索引落盘 + officialOnly 行', async () => {
    const { handle, agentDir } = await startServer();
    // mock 全局 fetch：refreshBuiltinModels 的官方提供商索引拉取
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(['anthropic', 'openai', 'qwen-token-plan-individual-cn']),
        }),
      ),
    );
    const c = await connect(handle);
    c.send({ type: 'refresh_builtin_models', reqId: 7 });
    const result = await c.waitFor(
      (m) => m.type === 'refresh_builtin_result',
      'refresh_builtin_result',
    );
    expect(result.reqId).toBe(7);
    expect(result.ok).toBe(true);
    // 索引已落盘缓存（重启后 officialOnly 行仍可见）
    expect(existsSync(join(agentDir, 'official-providers.json'))).toBe(true);
    // providers_status 推送包含 officialOnly 占位行
    const status = await c.waitFor(
      (m) => m.type === 'providers_status',
      'providers_status after refresh',
    );
    const providers = status.providers as { id: string; officialOnly?: boolean }[];
    expect(providers.some((p) => p.officialOnly && p.id === 'qwen-token-plan-individual-cn')).toBe(
      true,
    );
  });

  it('test_model_connection 对拒绝连接的地址回 ok=false（失败路径反馈）', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({ type: 'test_model_connection', reqId: 3, baseUrl: 'http://127.0.0.1:9' });
    const msg = await c.waitFor((m) => m.type === 'test_model_connection_result', 'conn result');
    expect(msg.reqId).toBe(3);
    expect(msg.ok).toBe(false);
    expect(typeof msg.error).toBe('string');
  });

  it('set_default_model / clear_default_model echo default_model', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({ type: 'set_default_model', modelId: 'anthropic/claude-x' });
    const set = await c.waitFor((m) => m.type === 'default_model', 'default_model set');
    expect(set.modelId).toBe('anthropic/claude-x');
    // 重连后仍恢复（per-server 内存态）
    const c2 = await connect(handle);
    const restored = await c2.waitFor((m) => m.type === 'default_model', 'default_model restored');
    expect(restored.modelId).toBe('anthropic/claude-x');
    c2.send({ type: 'clear_default_model' });
    const cleared = await c2.waitFor(
      (m) => m.type === 'default_model' && m.modelId === null,
      'default_model cleared',
    );
    expect(cleared.modelId).toBeNull();
  });

  it('未知模型管理消息不至于静默：回 error（bad_message）', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({ type: 'save_model_config', providerId: '' });
    const msg = await c.waitFor((m) => m.type === 'error', 'error for bad save');
    expect(msg.code).toBe('bad_message');
  });

  it('clear_provider_api_key 清空后 provider_keys 推送空列表', async () => {
    const { handle } = await startServer();
    const c = await connect(handle);
    c.send({ type: 'add_provider_key', provider: 'anthropic', apiKey: 'sk-e2e-clear', name: 'k1' });
    await c.waitFor((m) => m.type === 'provider_keys', 'keys after add');
    c.send({ type: 'clear_provider_api_key', provider: 'anthropic' });
    const msg = await c.waitFor(
      (m) =>
        m.type === 'provider_keys' &&
        (((m.keys as Record<string, unknown>).anthropic as unknown[]) ?? []).length === 0,
      'keys after clear',
    );
    // 清空后该服务商条目被整体删除（键缺失 = 无剩余密钥）
    expect((msg.keys as Record<string, unknown>).anthropic).toBeUndefined();
  });

  it('clone_provider 返回预填草稿（baseUrl + 模型目录，apiKey 不回传）', async () => {
    const { handle } = await startServer(undefined, {
      getProvider: (id: string) =>
        id === 'anthropic'
          ? {
              id: 'anthropic',
              name: 'Anthropic',
              baseUrl: 'https://api.anthropic.com',
              auth: { apiKey: { type: 'api' } },
            }
          : undefined,
      getModels: () => [
        { api: 'anthropic-messages', id: 'claude-x', name: 'Claude X' },
        { api: 'anthropic-messages', id: 'claude-y' },
      ],
    });
    const c = await connect(handle);
    c.send({ type: 'clone_provider', provider: 'anthropic', reqId: 9 });
    const msg = await c.waitFor((m) => m.type === 'clone_provider_result', 'clone result');
    expect(msg.reqId).toBe(9);
    expect(msg.ok).toBe(true);
    const config = msg.config as {
      providerId: string;
      baseUrl?: string;
      models: { id: string }[];
      apiKey?: string;
    };
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.models.map((m) => m.id)).toEqual(['claude-x', 'claude-y']);
    expect(config.apiKey).toBeUndefined();
  });
});
