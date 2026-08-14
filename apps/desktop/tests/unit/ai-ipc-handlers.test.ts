/**
 * M13 AI Side Panel · ai/register-handlers 单元测试
 *
 * 验证：
 * 1. provider.list 返回已注册 Provider 清单
 * 2. ai.chat.start 创建 MessageChannel 并下发 port1，启动流式对话
 * 3. ai.chat.start 在 sender 无效时返回 INTERNAL 错误 payload
 * 4. ai.chat.abort 中止进行中的流式对话
 * 5. ai.chat.abort 在流不存在时仍返回 ok
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ── mock electron：MessageChannelMain + 类型 ──
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

import type { IpcMainInvokeEvent } from '@urchin/ipc-contract';
import { registerAiHandlers } from '../../src/main/ai/register-handlers';
import type { Orchestrator } from '../../src/main/orchestrator/orchestrator';
import type { ProviderRegistry } from '../../src/main/orchestrator/provider-registry';
import type { ProviderHost } from '../../src/main/orchestrator/types';
import { MockMessagePort } from '../helpers/mock-orchestrator';

/** 创建 mock ProviderHost */
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

/** 创建 mock Orchestrator */
function createMockOrchestrator(): Orchestrator & { _host: ProviderHost } {
  const host = createMockHost();
  return {
    ensureProviderLoaded: vi.fn().mockResolvedValue(host),
    dispose: vi.fn(),
    _host: host,
  } as never;
}

/** 创建 mock ProviderRegistry */
function createMockRegistry(): ProviderRegistry & {
  _installMock: ReturnType<typeof vi.fn>;
  _removeMock: ReturnType<typeof vi.fn>;
} {
  const installMock = vi.fn();
  const removeMock = vi.fn();
  return {
    list: vi.fn().mockReturnValue([
      {
        id: 'openai',
        name: 'OpenAI',
        version: '1.0.0',
        apiVersion: 'urchin-ai-provider/v1',
        capabilities: ['chat.completion', 'chat.completion.streaming'],
        authMethod: 'api_key',
        entryPath: '/providers/openai/index.js',
        manifestPath: '/providers/openai/manifest.json',
        rateLimit: { requestsPerMin: 60 },
      },
    ]),
    get: vi.fn(),
    has: vi.fn(),
    scan: vi.fn().mockReturnValue(1),
    reload: vi.fn().mockReturnValue(1),
    install: installMock,
    remove: removeMock,
    _installMock: installMock,
    _removeMock: removeMock,
  } as never;
}

/** 创建 mock ipcMain（支持 sender 注入；传 null 表示无 sender） */
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

describe('registerAiHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register provider.list / ai.chat.start / ai.chat.abort handlers', () => {
    const ipcMain = createMockIpcMain();
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    expect(ipcMain.hasHandler('provider.list')).toBe(true);
    expect(ipcMain.hasHandler('ai.chat.start')).toBe(true);
    expect(ipcMain.hasHandler('ai.chat.abort')).toBe(true);
  });

  it('provider.list should return serialized provider list', async () => {
    const ipcMain = createMockIpcMain();
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    const result = (await ipcMain.invoke('provider.list', {})) as {
      providers: { id: string; name: string; authMethod: string }[];
    };

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.id).toBe('openai');
    expect(result.providers[0]!.name).toBe('OpenAI');
    expect(result.providers[0]!.authMethod).toBe('api_key');
  });

  it('ai.chat.start should create MessageChannel and post port1 to sender', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    const result = (await ipcMain.invoke('ai.chat.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'gpt-4o-mini',
      stream: true,
    })) as { conversationId: string };

    expect(result.conversationId).toBeTruthy();
    // sender.postMessage 应被调用以发送 port1
    expect(sender.postMessage).toHaveBeenCalledTimes(1);
    // 第一个参数是 channel 名 'ai.chat.port'
    const calls = sender.postMessage.mock.calls as unknown as unknown[][];
    expect(calls[0]![0]).toBe('ai.chat.port');
    // 第三个参数是 transfer list（包含 port1）
    const transfer = calls[0]![2];
    expect(Array.isArray(transfer)).toBe(true);
  });

  it('ai.chat.start should return INTERNAL error payload when sender is invalid', async () => {
    const ipcMain = createMockIpcMain(null);
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    const result = (await ipcMain.invoke('ai.chat.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'Hi' }],
      model: 'gpt-4o-mini',
      stream: true,
    })) as { code: string; message: string };

    expect(result.code).toBe('INTERNAL');
    expect(result.message).toContain('invalid sender');
  });

  it('ai.chat.abort should return ok with conversationId when stream exists', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    // 先启动一个流
    const startResult = (await ipcMain.invoke('ai.chat.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'gpt-4o-mini',
      stream: true,
    })) as { conversationId: string };

    // 然后中止它
    const abortResult = (await ipcMain.invoke('ai.chat.abort', {
      conversationId: startResult.conversationId,
    })) as { ok: true; conversationId: string };

    expect(abortResult.ok).toBe(true);
    expect(abortResult.conversationId).toBe(startResult.conversationId);
  });

  it('ai.chat.abort should return ok even when stream not found', async () => {
    const ipcMain = createMockIpcMain();
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    const result = (await ipcMain.invoke('ai.chat.abort', {
      conversationId: 'non-existent-conv',
    })) as { ok: true; conversationId: string };

    expect(result.ok).toBe(true);
    expect(result.conversationId).toBe('non-existent-conv');
  });

  it('ai.chat.start should call orchestrator.ensureProviderLoaded', async () => {
    const sender = { send: vi.fn(), postMessage: vi.fn() };
    const ipcMain = createMockIpcMain(sender);
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    await ipcMain.invoke('ai.chat.start', {
      providerId: 'openai',
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'gpt-4o-mini',
      stream: true,
    });

    expect(orchestrator.ensureProviderLoaded).toHaveBeenCalledWith('openai');
  });

  // ── provider.list ──

  it('provider.list should return real capabilities and authMethod', async () => {
    const ipcMain = createMockIpcMain();
    const orchestrator = createMockOrchestrator();
    const registry = createMockRegistry();

    registerAiHandlers(ipcMain as never, orchestrator, registry);

    const result = (await ipcMain.invoke('provider.list', {})) as {
      providers: { capabilities: string[]; authMethod: string }[];
    };

    expect(result.providers[0]!.capabilities).toEqual([
      'chat.completion',
      'chat.completion.streaming',
    ]);
    expect(result.providers[0]!.authMethod).toBe('api_key');
  });
});
