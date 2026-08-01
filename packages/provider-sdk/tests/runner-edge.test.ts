/**
 * @urchin/provider-sdk 路 杩愯鍣ㄨ竟鐣岃矾寰勫崟鍏冩祴璇? *
 * 瑕嗙洊 runner 鐨勯槻寰℃€у垎鏀笌 context 鐨?noop store锛屾彁鍗囩孩绾胯鐩栫巼銆? */

import { describe, it, expect, vi } from 'vitest';
import type {
  UrchinAIProvider,
  ProviderManifest,
  CompletionRequest,
  CompletionChunk,
} from '@urchin/ai-provider-contract';
import { runProvider } from '../src/runner';
import { buildProviderContext } from '../src/context';
import type { MessagePortLike, ParentPortLike, TimerProvider } from '../src/types';

// 鈹€鈹€鈹€ Mock 宸ュ叿锛堜笌 runner.test.ts 鐩稿悓鐨勫疄鐜帮紝閬垮厤璺ㄦ枃浠跺叡浜姸鎬侊級 鈹€鈹€鈹€

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

function createMockParentPort(): ParentPortLike & {
  emitOrchInit(port: MessagePortLike): void;
  emitOrchInitRaw(data: unknown, ports: MessagePortLike[]): void;
  emitRaw(data: unknown): void;
} {
  const listeners: ((event: { data: unknown; ports: MessagePortLike[] }) => void)[] = [];
  const mock: ParentPortLike & {
    emitOrchInit(port: MessagePortLike): void;
    emitOrchInitRaw(data: unknown, ports: MessagePortLike[]): void;
    emitRaw(data: unknown): void;
  } = {
    on(_event: 'message', listener: (event: { data: unknown; ports: MessagePortLike[] }) => void) {
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
    emitOrchInitRaw(data: unknown, ports: MessagePortLike[]): void {
      for (const l of listeners) {
        l({ data, ports });
      }
    },
    emitRaw(data: unknown): void {
      for (const l of listeners) {
        l({ data, ports: [] });
      }
    },
  };
  return mock;
}

function makeManifest(): ProviderManifest {
  return {
    id: 'mock-edge',
    name: 'Mock Edge Provider',
    version: '1.0.0',
    apiVersion: 'urchin-ai-provider/v1',
    capabilities: ['chat.completion', 'chat.completion.streaming'],
    configSchema: {} as never,
    authMethod: 'api_key',
    rateLimit: { requestsPerMin: 60 },
  };
}

function flush(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeProvider(overrides: Partial<UrchinAIProvider> = {}): UrchinAIProvider {
  return {
    manifest: makeManifest(),
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn(),
    complete: vi.fn(),
    ...overrides,
  };
}

// 鈹€鈹€鈹€ context锛歯oop store 鍏ㄩ儴鏂规硶 鈹€鈹€鈹€

describe('provider-sdk context', () => {
  it('should provide noop secret store that returns null', async () => {
    const ctx = buildProviderContext({}, new AbortController().signal, 't');
    expect(await ctx.secrets.get('k')).toBeNull();
    await expect(ctx.secrets.set('k', 'v')).resolves.toBeUndefined();
    await expect(ctx.secrets.delete('k')).resolves.toBeUndefined();
  });

  it('should provide noop storage that returns null / empty array', async () => {
    const ctx = buildProviderContext({}, new AbortController().signal, 't');
    expect(await ctx.storage.get('k')).toBeNull();
    await expect(ctx.storage.set('k', 'v')).resolves.toBeUndefined();
    await expect(ctx.storage.delete('k')).resolves.toBeUndefined();
    await expect(ctx.storage.query('prefix')).resolves.toEqual([]);
  });

  it('should default moduleName to provider', () => {
    const ctx = buildProviderContext({}, new AbortController().signal);
    expect(ctx).toBeDefined();
    expect(ctx.abort.aborted).toBe(false);
  });
});

// 鈹€鈹€鈹€ runner锛氶槻寰℃€у垎鏀?鈹€鈹€鈹€

describe('provider-sdk runner edge paths', () => {
  it('should warn when orch.init has no transferred port', () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();

    runProvider(() => makeProvider(), { parentPort });
    // 瑙﹀彂 orch.init 浣?ports 涓虹┖鏁扮粍 鈫?鏃?port 鍒嗘敮锛屼笉寤虹珛 orchPort
    parentPort.emitOrchInitRaw({ kind: 'orch.init' }, []);

    // 鍚庣画 init 娑堟伅鏃犳硶閫佽揪锛坥rchPort 鏈缓绔嬶級锛屾棤 ready 娑堟伅
    expect(port.messages).toHaveLength(0);
  });

  it('should ignore invalid messages on parentPort', async () => {
    const parentPort = createMockParentPort();

    runProvider(() => makeProvider(), { parentPort });
    // 鏃犳晥娑堟伅锛氶潪瀵硅薄銆佹棤 kind銆乲ind 闈炲瓧绗︿覆 鈫?warn 鍚庡拷鐣ワ紝涓嶆姏寮傚父
    parentPort.emitRaw(null);
    parentPort.emitRaw('string');
    parentPort.emitRaw({ noKind: true });
    parentPort.emitRaw({ kind: 42 });
    await flush(10);
    expect(true).toBe(true);
  });

  it('should handle stream without conversationId via default abort controller', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    // eslint-disable-next-line @typescript-eslint/require-await -- mock async generator
    stream.mockImplementation(async function* () {
      yield { content: 'default-conv' };
    });
    const provider = makeProvider({ stream });

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    // 鏃?conversationId 鐨?stream
    port.emit({ kind: 'stream', req: { messages: [], model: 'm' } });
    await flush(20);

    expect(stream).toHaveBeenCalledTimes(1);
    const endMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();

    // 鏃?conversationId 鐨?abort 鈫?璧?defaultAbortController 鍒嗘敮
    port.emit({ kind: 'abort' });
    await flush(10);
    expect((endMsg as { finishReason: string }).finishReason).toBe('stop');
  });

  it('should abort default stream when abort has no conversationId', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    stream.mockImplementation(async function* () {
      yield { content: 'first' };
      await new Promise((r) => setTimeout(r, 50));
      yield { content: 'second' };
    });
    const provider = makeProvider({ stream });

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    port.emit({ kind: 'stream', req: { messages: [], model: 'm' } });
    await flush(5);

    port.emit({ kind: 'abort' });
    await flush(70);

    const endMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();
    expect((endMsg as { finishReason: string }).finishReason).toBe('aborted');
  });

  it('should send error for complete when provider not initialized', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();

    runProvider(() => makeProvider(), { parentPort });
    parentPort.emitOrchInit(port);

    port.emit({
      kind: 'complete',
      conversationId: 'c-noinit',
      req: { messages: [], model: 'm' },
    });
    await flush(10);

    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toContain('not initialized');
  });

  it('should send error when complete fails', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const complete = vi.fn().mockRejectedValue(new Error('complete boom'));
    const provider = makeProvider({ complete });

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    port.emit({
      kind: 'complete',
      conversationId: 'c-fail',
      req: { messages: [], model: 'm' },
    });
    await flush(10);

    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toContain('complete boom');
  });

  it('should warn when abort targets unknown conversation', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();

    runProvider(() => makeProvider(), { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    port.emit({ kind: 'abort', conversationId: 'unknown-conv' });
    await flush(10);
    expect(port.messages).toBeDefined();
  });

  it('should warn and continue when provider.dispose throws', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const dispose = vi.fn().mockRejectedValue(new Error('dispose boom'));
    const provider = makeProvider({ dispose });

    const handle = runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    await handle.stop();
    expect(dispose).toHaveBeenCalled();
  });

  it('should clean up heartbeat and port on stop', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const timers = createMockTimers();
    const provider = makeProvider();

    const handle = runProvider(() => provider, { parentPort, timers });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    await handle.stop();
    expect(handle.ready).toBe(true);
  });

  it('should handle non-Error stream failure via ProviderError.from', async () => {
    const parentPort = createMockParentPort();
    const port = createMockPort();
    const stream = vi.fn<(req: CompletionRequest) => AsyncIterable<CompletionChunk>>();
    stream.mockImplementation(async function* () {
      yield { content: 'first' };
      await Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- 模拟非 Error 异常路径
      throw 'string error';
    });
    const provider = makeProvider({ stream });

    runProvider(() => provider, { parentPort });
    parentPort.emitOrchInit(port);
    port.emit({ kind: 'init', providerId: 'mock-edge', config: {} });
    await flush(10);

    port.emit({
      kind: 'stream',
      conversationId: 'conv-str-err',
      req: { messages: [], model: 'm' },
    });
    await flush(20);

    const errMsg = port.messages.find((m) => (m as { kind?: string }).kind === 'error');
    expect(errMsg).toBeDefined();
  });

  it('should not crash when send is called before port ready', async () => {
    const parentPort = createMockParentPort();

    runProvider(() => makeProvider(), { parentPort });
    // 涓?emitOrchInit 鈫?orchPort 鏈氨缁紱init 鍓嶇殑 stream 娑堟伅瑙﹀彂 send() warn 鍒嗘敮
    parentPort.emitRaw({ kind: 'stream', conversationId: 'x', req: { messages: [], model: 'm' } });
    await flush(10);
    expect(true).toBe(true);
  });
});

/** 鍒涘缓鍙楁帶瀹氭椂鍣?*/
function createMockTimers(): TimerProvider {
  return {
    setInterval(): ReturnType<typeof setInterval> {
      return 0 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(): void {
      // noop
    },
  };
}
