/**
 * @urchin/provider-sdk · 运行器单元测试
 *
 * 验证 SDK 与 Orchestrator 协议的端到端正确性。
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  UrchinAIProvider,
  ProviderManifest,
  CompletionRequest,
  CompletionChunk,
  CompletionResponse,
} from '@urchin/ai-provider-contract';
import { runProvider } from '../src/runner';
import type {
  ParentPortLike,
  MessagePortLike,
  ParentPortMessageEvent,
  TimerProvider,
} from '../src/types';

// ─── Mock 工具 ───

/** 创建 mock MessagePort，记录所有 postMessage */
function createMockPort(): MessagePortLike & {
  readonly messages: unknown[];
  emit(msg: unknown): void;
} {
  const messages: unknown[] = [];
  const listeners: ((msg: unknown) => void)[] = [];
  const mock: MessagePortLike & {
    messages: unknown[];
    emit(msg: unknown): void;
  } = {
    messages,
    postMessage(msg: unknown): void {
      messages.push(msg);
    },
    on(_event: 'message', listener: (msg: unknown) => void) {
      listeners.push(listener);
      return mock;
    },
    start(): void {
      // noop
    },
    close(): void {
      // noop
    },
    emit(msg: unknown): void {
      for (const l of listeners) l(msg);
    },
  };
  return mock;
}

/** 创建 mock parentPort */
function createMockParentPort(): ParentPortLike & {
  emitOrchInit(port: MessagePortLike): void;
} {
  const listeners: ((event: ParentPortMessageEvent) => void)[] = [];
  const mock: ParentPortLike & {
    emitOrchInit(port: MessagePortLike): void;
  } = {
    on(_event: 'message', listener: (event: ParentPortMessageEvent) => void) {
      listeners.push(listener);
      return mock;
    },
    postMessage(): void {
      // noop
    },
    emitOrchInit(port: MessagePortLike): void {
      for (const l of listeners) {
        l({ data: { kind: 'orch.init' }, ports: [port] });
      }
    },
  };
  return mock;
}

/** 创建受控定时器 */
function createMockTimers(): TimerProvider & {
  tickHeartbeat(): void;
} {
  const intervalHandlers: (() => void)[] = [];
  return {
    setInterval(handler: () => void): ReturnType<typeof setInterval> {
      intervalHandlers.push(handler);
      return 0 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(): void {
      // noop
    },
    tickHeartbeat(): void {
      for (const h of intervalHandlers) h();
    },
  };
}

/** 构建合法 manifest */
function makeManifest(): ProviderManifest {
  return {
    id: 'mock-echo',
    name: 'Mock Echo Provider',
    version: '1.0.0',
    apiVersion: 'urchin-ai-provider/v1',
    capabilities: ['chat.completion', 'chat.completion.streaming'],
    configSchema: {} as never,
    authMethod: 'api_key',
    rateLimit: { requestsPerMin: 60 },
  };
}

/** 等待异步操作完成 */
function flush(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 测试 ───

describe('provider-sdk runner', () => {
  it('should receive orch.init and wait for init message', () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const initialize = vi.fn<(ctx: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize,
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete: vi.fn(),
    };

    const handle = runProvider(() => provider, { parentPort });
    expect(handle.ready).toBe(false);

    parentPort.emitOrchInit(port);
    expect(handle.ready).toBe(false);
    expect(port.messages).toHaveLength(0);
  });

  it('should initialize provider and send ready on init message', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const initialize = vi.fn<(ctx: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize,
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete: vi.fn(),
    };

    const handle = runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);

    port.emit({ kind: 'init', providerId: 'mock-echo', config: { apiKey: 'test-key' } });
    await flush(10);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(handle.ready).toBe(true);

    const readyMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'ready');
    expect(readyMsg).toBeDefined();
    expect((readyMsg as { manifest: ProviderManifest }).manifest.id).toBe('mock-echo');
  });

  it('should stream chunks and end on stream message', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const chunks: CompletionChunk[] = [
      { role: 'assistant' },
      { content: 'Hello' },
      { content: ' world' },
    ];
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    // eslint-disable-next-line @typescript-eslint/require-await -- mock async generator
    stream.mockImplementation(async function* () {
      for (const c of chunks) yield c;
    });
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream,
      complete: vi.fn(),
    };

    const handle = runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    const req: CompletionRequest = {
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'mock-model',
    };
    port.emit({ kind: 'stream', conversationId: 'conv-1', req });
    await flush(30);

    expect(stream).toHaveBeenCalledTimes(1);
    expect(handle.activeStreamCount).toBe(0);

    const chunkMsgs = port.messages.filter((m) => (m as { kind?: string }).kind === 'stream.chunk');
    expect(chunkMsgs).toHaveLength(3);
    const endMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();
    expect((endMsg as { finishReason: string }).finishReason).toBe('stop');
  });

  it('should handle abort and stop iteration', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();

    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    stream.mockImplementation(async function* () {
      yield { content: 'first' };
      await new Promise((r) => setTimeout(r, 50));
      yield { content: 'second' };
    });
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream,
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    port.emit({
      kind: 'stream',
      conversationId: 'conv-abort',
      req: { messages: [], model: 'm' },
    });
    await flush(10);

    port.emit({ kind: 'abort', conversationId: 'conv-abort' });
    await flush(70);

    const endMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();
    expect((endMsg as { finishReason: string }).finishReason).toBe('aborted');
    const chunkMsgs = port.messages.filter((m) => (m as { kind?: string }).kind === 'stream.chunk');
    expect(chunkMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle complete (non-stream) message', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const response: CompletionResponse = {
      content: 'hello back',
      role: 'assistant',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3 },
    };
    const complete = vi.fn<(req: CompletionRequest) => Promise<CompletionResponse>>();
    complete.mockResolvedValue(response);
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete,
    };

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    const req: CompletionRequest = {
      conversationId: 'conv-2',
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    };
    port.emit({ kind: 'complete', conversationId: 'conv-2', req });
    await flush(10);

    expect(complete).toHaveBeenCalledTimes(1);
    const respMsg = port.messages.find(
      (m) => (m as { kind?: string }).kind === 'complete.response',
    );
    expect(respMsg).toBeDefined();
    expect((respMsg as { response: CompletionResponse }).response.content).toBe('hello back');
  });

  it('should send heartbeat after init', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const timers = createMockTimers();
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort, timers });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    timers.tickHeartbeat();

    const hbMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'heartbeat');
    expect(hbMsg).toBeDefined();
    expect((hbMsg as { stats: { activeStreams: number } }).stats.activeStreams).toBe(0);
  });

  it('should handle init failure and send error', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const initialize = vi.fn<(ctx: unknown) => Promise<void>>();
    initialize.mockRejectedValue(new Error('init boom'));
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize,
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    expect(initialize).toHaveBeenCalledTimes(1);
    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toContain('init boom');
  });

  it('should handle stream failure and send error', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    // eslint-disable-next-line @typescript-eslint/require-await -- mock async generator
    stream.mockImplementation(async function* () {
      yield { content: 'first' };
      throw new Error('stream boom');
    });
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream,
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    port.emit({
      kind: 'stream',
      conversationId: 'conv-err',
      req: { messages: [], model: 'm' },
    });
    await flush(20);

    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toContain('stream boom');
  });

  it('should handle dispose and call provider.dispose', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose,
      stream: vi.fn(),
      complete: vi.fn(),
    };

    const handle = runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    // mock process.exit，避免测试进程退出
    const originalExit = process.exit;
    process.exit = (() => {
      // noop
    }) as unknown as typeof process.exit;

    port.emit({ kind: 'dispose' });
    await flush(10);

    expect(dispose).toHaveBeenCalledTimes(1);
    process.exit = originalExit;
    await handle.stop();
  });

  it('should report active stream count in heartbeat', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const timers = createMockTimers();
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    stream.mockImplementation(async function* () {
      yield { content: 'first' };
      await new Promise((r) => setTimeout(r, 100));
      yield { content: 'second' };
    });
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream,
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort, timers });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-echo', config: {} });
    await flush(10);

    port.emit({
      kind: 'stream',
      conversationId: 'conv-active',
      req: { messages: [], model: 'm' },
    });
    await flush(5);

    timers.tickHeartbeat();
    const hbMsgs = port.messages.filter((m) => (m as { kind?: string }).kind === 'heartbeat');
    const lastHb = hbMsgs[hbMsgs.length - 1] as { stats: { activeStreams: number } } | undefined;
    expect(lastHb).toBeDefined();
    expect(lastHb!.stats.activeStreams).toBe(1);

    port.emit({ kind: 'abort', conversationId: 'conv-active' });
    await flush(110);
  });

  it('should warn when receiving message before init', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const provider: UrchinAIProvider = {
      manifest: makeManifest(),
      initialize: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      complete: vi.fn(),
    };

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);

    port.emit({ kind: 'stream', conversationId: 'x', req: { messages: [], model: 'm' } });
    await flush(10);

    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toContain('not initialized');
  });
});
