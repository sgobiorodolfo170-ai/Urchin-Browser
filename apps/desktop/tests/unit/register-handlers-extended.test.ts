/**
 * M13 AI Side Panel · ai/register-handlers 扩展测试
 *
 * 补充覆盖 ai-ipc-handlers.test.ts 未覆盖的 handler：
 * 1. pi.providers：返回 pi 内置 Provider 元信息
 * 2. provider.rescan：重新扫描 providers 目录
 * 3. provider.config.get/set：配置存储（含无 configStore 分支）
 * 4. ai.agent.start：Agent 模式对话（含无 config / 无 provider / createPiAgent 失败 / 正常流程）
 * 5. ai.agent.abort：中止 Agent 对话
 * 6. dispose：清理所有活跃流
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const mockPort1 = {
  postMessage: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
};
const mockPort2 = {
  postMessage: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
};
vi.mock('electron', () => ({
  MessageChannelMain: vi.fn().mockImplementation(() => ({
    port1: mockPort1,
    port2: mockPort2,
  })),
}));

// ── mock 动态加载的 pi-agent-factory 与 pi-event-bridge ──
const mocks = vi.hoisted(() => ({
  createPiAgent: vi.fn(),
  bridgeAgentToPort: vi.fn(),
  getPiBuiltinProvidersInfo: vi.fn(),
}));

vi.mock('../../src/main/ai/pi-agent-factory', () => ({
  createPiAgent: mocks.createPiAgent,
  isBuiltinProvider: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/main/ai/pi-event-bridge', () => ({
  bridgeAgentToPort: mocks.bridgeAgentToPort,
}));

vi.mock('../../src/main/ai/pi-providers-info', () => ({
  getPiBuiltinProvidersInfo: mocks.getPiBuiltinProvidersInfo,
}));

import type { IpcMainInvokeEvent } from '@urchin/ipc-contract';
import { registerAiHandlers } from '../../src/main/ai/register-handlers';
import type { Orchestrator } from '../../src/main/orchestrator/orchestrator';
import type { ProviderRegistry } from '../../src/main/orchestrator/provider-registry';
import type { ProviderHost } from '../../src/main/orchestrator/types';
import { MockMessagePort } from '../helpers/mock-orchestrator';

/** mock startStream（orchestrator/stream 需要 host/port，测试中隔离） */
vi.mock('../../src/main/orchestrator/stream', () => ({
  startStream: vi.fn(() => ({ abort: vi.fn() })),
}));

function createMockHost(): ProviderHost {
  const port = new MockMessagePort();
  return {
    providerId: 'openai',
    manifest: {
      id: 'openai',
      name: 'OpenAI',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['chat.completion', 'chat.completion.streaming'],
      configSchema: z.record(z.unknown()),
      authMethod: 'api_key',
    },
    process: {
      pid: 12345,
      postMessage: vi.fn(),
      on: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
      kill: vi.fn().mockReturnValue(true),
    },
    port,
    lastHeartbeat: Date.now(),
    state: 'ready',
    rateLimiter: {
      acquireRequestToken: vi.fn().mockResolvedValue(undefined),
      availableTokens: 100,
    },
  };
}

function createMockOrchestrator(): Orchestrator & { _host: ProviderHost } {
  const host = createMockHost();
  return {
    ensureProviderLoaded: vi.fn().mockResolvedValue(host),
    dispose: vi.fn(),
    _host: host,
  } as never;
}

function createMockRegistry(): ProviderRegistry & {
  list: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    has: vi.fn(),
    scan: vi.fn().mockReturnValue(1),
    reload: vi.fn().mockReturnValue(2),
    install: vi.fn(),
    remove: vi.fn(),
  } as never;
}

/** 创建 mock ipcMain */
function createMockIpcMain(sender?: { send: unknown; postMessage: unknown } | null) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    hasHandler(channel: string) {
      return handlers.has(channel);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      const event = { sender: sender ?? null } as unknown as IpcMainInvokeEvent;
      return fn(event, req);
    },
  };
}

describe('registerAiHandlers extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPiBuiltinProvidersInfo.mockReturnValue({
      providers: [{ id: 'openai', name: 'OpenAI' }],
      generatedAt: 1234567890,
    });
    mocks.createPiAgent.mockReturnValue({
      agent: {
        prompt: vi.fn().mockResolvedValue(undefined),
      },
      model: {},
      tools: [],
    });
    mocks.bridgeAgentToPort.mockReturnValue({
      abort: vi.fn(),
      ended: false,
    });
  });

  it('should register pi.providers handler', () => {
    const ipcMain = createMockIpcMain();
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), createMockRegistry());
    expect(ipcMain.hasHandler('pi.providers')).toBe(true);
  });

  it('pi.providers should return builtin providers info', async () => {
    const ipcMain = createMockIpcMain();
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), createMockRegistry());

    const result = (await ipcMain.invoke('pi.providers', {})) as {
      providers: { id: string }[];
      generatedAt: number;
    };

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.id).toBe('openai');
    expect(result.generatedAt).toBe(1234567890);
    expect(mocks.getPiBuiltinProvidersInfo).toHaveBeenCalled();
  });

  it('provider.rescan should reload registry and return providers', async () => {
    const ipcMain = createMockIpcMain();
    const registry = createMockRegistry();
    registry.list.mockReturnValue([
      {
        id: 'openai',
        name: 'OpenAI',
        version: '1.0.0',
        apiVersion: 'urchin-ai-provider/v1',
        capabilities: ['chat.completion'],
        authMethod: 'api_key',
      },
    ]);
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), registry);

    const result = (await ipcMain.invoke('provider.rescan', {})) as {
      count: number;
      providers: { id: string }[];
    };

    expect(result.count).toBe(2);
    expect(registry.reload).toHaveBeenCalled();
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.id).toBe('openai');
  });

  it('provider.config.get should return stored config', async () => {
    const ipcMain = createMockIpcMain();
    const configStore = {
      get: vi.fn().mockResolvedValue({ apiKey: 'sk-test' }),
      set: vi.fn(),
    };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      configStore,
    );

    const result = (await ipcMain.invoke('provider.config.get', {
      providerId: 'openai',
    })) as { providerId: string; config: { apiKey: string } };

    expect(result.providerId).toBe('openai');
    expect(result.config.apiKey).toBe('sk-test');
  });

  it('provider.config.get should return null config when none stored', async () => {
    const ipcMain = createMockIpcMain();
    const configStore = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      configStore,
    );

    const result = (await ipcMain.invoke('provider.config.get', {
      providerId: 'openai',
    })) as { config: unknown };

    expect(result.config).toBeNull();
  });

  it('provider.config.get should throw UNAVAILABLE without configStore', async () => {
    const ipcMain = createMockIpcMain();
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), createMockRegistry());

    const result = (await ipcMain.invoke('provider.config.get', {
      providerId: 'openai',
    })) as { code: string };

    expect(result.code).toBe('UNAVAILABLE');
  });

  it('provider.config.set should write config and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const configStore = { get: vi.fn(), set: vi.fn() };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      configStore,
    );

    const result = (await ipcMain.invoke('provider.config.set', {
      providerId: 'openai',
      config: { apiKey: 'sk-test' },
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(configStore.set).toHaveBeenCalledWith('openai', { apiKey: 'sk-test' });
  });

  it('provider.config.set should throw UNAVAILABLE without configStore', async () => {
    const ipcMain = createMockIpcMain();
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), createMockRegistry());

    const result = (await ipcMain.invoke('provider.config.set', {
      providerId: 'openai',
      config: {},
    })) as { code: string };

    expect(result.code).toBe('UNAVAILABLE');
  });

  it('ai.agent.start should throw UNAVAILABLE without agentConfigProvider', async () => {
    const ipcMain = createMockIpcMain();
    registerAiHandlers(ipcMain as never, createMockOrchestrator(), createMockRegistry());

    const result = (await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
    })) as { code: string };

    expect(result.code).toBe('UNAVAILABLE');
  });

  it('ai.agent.start should throw PERMISSION when no apiKey configured', async () => {
    const ipcMain = createMockIpcMain();
    const agentConfigProvider = { get: vi.fn().mockResolvedValue({}) };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      undefined,
      agentConfigProvider,
    );

    const result = (await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
    })) as { code: string };

    expect(result.code).toBe('PERMISSION');
  });

  it('ai.agent.start should throw INTERNAL when createPiAgent fails', async () => {
    const ipcMain = createMockIpcMain();
    const agentConfigProvider = { get: vi.fn().mockResolvedValue({ apiKey: 'sk-test' }) };
    mocks.createPiAgent.mockImplementation(() => {
      throw new Error('agent factory boom');
    });
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      undefined,
      agentConfigProvider,
    );

    const result = (await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
    })) as { code: string };

    expect(result.code).toBe('INTERNAL');
  });

  it('ai.agent.start should create agent and bridge to port', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const agentConfigProvider = { get: vi.fn().mockResolvedValue({ apiKey: 'sk-test' }) };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      undefined,
      agentConfigProvider,
    );

    const result = (await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
      enableTools: false,
    })) as { conversationId: string };

    expect(result.conversationId).toBeTruthy();
    expect(mocks.createPiAgent).toHaveBeenCalled();
    expect(mocks.bridgeAgentToPort).toHaveBeenCalled();
    expect(sender.postMessage).toHaveBeenCalledTimes(1);
  });

  it('ai.agent.abort should return ok for existing and missing streams', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const agentConfigProvider = { get: vi.fn().mockResolvedValue({ apiKey: 'sk-test' }) };
    registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      undefined,
      agentConfigProvider,
    );

    const startResult = (await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
    })) as { conversationId: string };

    const abortOk = (await ipcMain.invoke('ai.agent.abort', {
      conversationId: startResult.conversationId,
    })) as { ok: boolean };

    expect(abortOk.ok).toBe(true);

    const missingOk = (await ipcMain.invoke('ai.agent.abort', {
      conversationId: 'not-found',
    })) as { ok: boolean };

    expect(missingOk.ok).toBe(true);
  });

  it('dispose should abort active streams', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const agentConfigProvider = { get: vi.fn().mockResolvedValue({ apiKey: 'sk-test' }) };
    const bridgeAbort = vi.fn();
    mocks.bridgeAgentToPort.mockReturnValue({ abort: bridgeAbort, ended: false });

    const handles = registerAiHandlers(
      ipcMain as never,
      createMockOrchestrator(),
      createMockRegistry(),
      undefined,
      agentConfigProvider,
    );

    await ipcMain.invoke('ai.agent.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4o-mini',
    });

    handles.dispose();
    expect(bridgeAbort).toHaveBeenCalled();
  });
});
