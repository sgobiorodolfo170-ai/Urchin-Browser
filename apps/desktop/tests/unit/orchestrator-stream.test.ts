/**
 * M11 Orchestrator · 流式调用链路单元测试
 *
 * 依据：契约 I §6 / M17 token 直通
 *
 * 覆盖：
 * - 流启动后向 Provider 发送 stream 消息
 * - stream.chunk / stream.end 透传给 Renderer
 * - M17 token 直通：stream.end 的 usage 字段透传
 * - Renderer abort 转发给 Provider
 * - 流结束后状态变更
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { startStream } from '../../src/main/orchestrator/stream';
import type { ProviderHost } from '../../src/main/orchestrator/types';
import type { CompletionRequest } from '@urchin/ai-provider-contract';
import { MockMessagePort, MockUtilityProcess, MockTokenBucket } from '../helpers/mock-orchestrator';

/** 创建一个 mock ProviderHost，port 是真实可用的 MockMessagePort */
function createMockHost(providerId = 'test-provider'): {
  host: ProviderHost;
  providerPort: MockMessagePort;
  childPort: MockMessagePort;
} {
  const [providerPort, childPort] = MockMessagePort.pair();
  const host: ProviderHost = {
    providerId,
    manifest: {
      id: providerId,
      name: 'Test',
      version: '1.0.0',
      apiVersion: 'urchin-ai-provider/v1',
      capabilities: ['chat.completion.streaming'],
      configSchema: {} as never,
      authMethod: 'api_key',
    },
    process: new MockUtilityProcess(),
    port: providerPort,
    lastHeartbeat: Date.now(),
    state: 'ready',
    rateLimiter: new MockTokenBucket(),
  };
  return { host, providerPort, childPort };
}

const SAMPLE_REQ: CompletionRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('startStream', () => {
  let rendererPort: MockMessagePort;
  let rendererPairedPort: MockMessagePort;
  let messagesToRenderer: unknown[];

  beforeEach(() => {
    [rendererPort, rendererPairedPort] = MockMessagePort.pair();
    messagesToRenderer = [];
    rendererPairedPort.on('message', (msg) => {
      messagesToRenderer.push(msg);
    });
    rendererPairedPort.start();
  });

  it('启动后向 Provider 发送 stream 消息', async () => {
    const { host, childPort } = createMockHost();
    const providerMessages: unknown[] = [];
    childPort.on('message', (msg) => providerMessages.push(msg));
    childPort.start();

    const handle = startStream(host, SAMPLE_REQ, rendererPort);

    // MockMessagePort.postMessage 用 queueMicrotask 异步投递，需等待 microtask 刷新
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(handle.conversationId).toBeTruthy();
    expect(providerMessages.length).toBe(1);
    const msg = providerMessages[0] as { kind: string; conversationId: string; req: unknown };
    expect(msg.kind).toBe('stream');
    expect(msg.conversationId).toBe(handle.conversationId);
    expect(msg.req).toBeDefined();
  });

  it('使用 req.conversationId 如果提供', () => {
    const { host } = createMockHost();
    const req: CompletionRequest = {
      ...SAMPLE_REQ,
      conversationId: 'fixed-conv-id',
    };

    const handle = startStream(host, req, rendererPort);
    expect(handle.conversationId).toBe('fixed-conv-id');
  });

  it('stream.chunk 透传给 Renderer', async () => {
    const { host, providerPort } = createMockHost();
    const handle = startStream(host, SAMPLE_REQ, rendererPort);

    // 模拟 Provider 发 chunk
    providerPort.emitMessage({
      kind: 'stream.chunk',
      conversationId: handle.conversationId,
      chunk: { content: 'hello' },
    });

    // 等待 queueMicrotask
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(messagesToRenderer.length).toBe(1);
    expect((messagesToRenderer[0] as { kind: string }).kind).toBe('stream.chunk');
  });

  it('stream.end 透传给 Renderer 并标记结束', async () => {
    const { host, providerPort } = createMockHost();
    let endCalled = false;
    let endFinishReason = '';
    let endUsage: unknown;

    const handle = startStream(host, SAMPLE_REQ, rendererPort, {
      onEnd: (finishReason, usage) => {
        endCalled = true;
        endFinishReason = finishReason;
        endUsage = usage;
      },
    });

    providerPort.emitMessage({
      kind: 'stream.end',
      conversationId: handle.conversationId,
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(messagesToRenderer.length).toBe(1);
    expect((messagesToRenderer[0] as { kind: string }).kind).toBe('stream.end');
    expect(handle.ended).toBe(true);
    expect(endCalled).toBe(true);
    expect(endFinishReason).toBe('stop');
    expect(endUsage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('M17 token 直通：stream.end 的 usage 字段透传给 Renderer', async () => {
    const { host, providerPort } = createMockHost();
    const handle = startStream(host, SAMPLE_REQ, rendererPort);

    providerPort.emitMessage({
      kind: 'stream.end',
      conversationId: handle.conversationId,
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(messagesToRenderer.length).toBe(1);
    const forwarded = messagesToRenderer[0] as {
      kind: string;
      usage?: { promptTokens: number; completionTokens: number };
    };
    expect(forwarded.kind).toBe('stream.end');
    expect(forwarded.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });

  it('error 消息透传给 Renderer 并标记结束', async () => {
    const { host, providerPort } = createMockHost();
    let endCalled = false;
    let endReason = '';

    const handle = startStream(host, SAMPLE_REQ, rendererPort, {
      onEnd: (reason) => {
        endCalled = true;
        endReason = reason;
      },
    });

    providerPort.emitMessage({
      kind: 'error',
      conversationId: handle.conversationId,
      error: { code: 'PROVIDER_ERROR', message: 'oops' },
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(messagesToRenderer.length).toBe(1);
    expect((messagesToRenderer[0] as { kind: string }).kind).toBe('error');
    expect(handle.ended).toBe(true);
    expect(endCalled).toBe(true);
    expect(endReason).toBe('error');
  });

  it('其他会话的消息不透传', async () => {
    const { host, providerPort } = createMockHost();
    startStream(host, SAMPLE_REQ, rendererPort);

    // 不同 conversationId 的消息应被忽略
    providerPort.emitMessage({
      kind: 'stream.chunk',
      conversationId: 'other-conv',
      chunk: { content: 'hello' },
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(messagesToRenderer.length).toBe(0);
  });

  it('Renderer abort 转发给 Provider', async () => {
    const { host, childPort } = createMockHost();
    const providerMessages: unknown[] = [];
    childPort.on('message', (msg) => providerMessages.push(msg));
    childPort.start();

    const handle = startStream(host, SAMPLE_REQ, rendererPort);

    // 等待初始 stream 消息投递后再清空（MockMessagePort 异步投递）
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    providerMessages.length = 0;

    // Renderer 发 abort
    rendererPairedPort.postMessage({ kind: 'abort', conversationId: handle.conversationId });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(providerMessages.length).toBe(1);
    const msg = providerMessages[0] as { kind: string; conversationId: string };
    expect(msg.kind).toBe('abort');
    expect(msg.conversationId).toBe(handle.conversationId);
  });

  it('handle.abort() 主动中断', async () => {
    const { host, childPort } = createMockHost();
    const providerMessages: unknown[] = [];
    childPort.on('message', (msg) => providerMessages.push(msg));
    childPort.start();

    const handle = startStream(host, SAMPLE_REQ, rendererPort);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    providerMessages.length = 0;

    handle.abort();

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(providerMessages.length).toBe(1);
    expect((providerMessages[0] as { kind: string }).kind).toBe('abort');
  });

  it('handle.abort() 多次调用不重复发送', async () => {
    const { host, childPort } = createMockHost();
    const providerMessages: unknown[] = [];
    childPort.on('message', (msg) => providerMessages.push(msg));
    childPort.start();

    const handle = startStream(host, SAMPLE_REQ, rendererPort);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    providerMessages.length = 0;

    handle.abort();
    handle.abort();
    handle.abort();

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(providerMessages.length).toBe(1);
  });

  it('流结束后 handle.ended 为 true', async () => {
    const { host, providerPort } = createMockHost();
    const handle = startStream(host, SAMPLE_REQ, rendererPort);

    expect(handle.ended).toBe(false);

    providerPort.emitMessage({
      kind: 'stream.end',
      conversationId: handle.conversationId,
      finishReason: 'stop',
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(handle.ended).toBe(true);
  });

  it('忽略无效消息', async () => {
    const { host, providerPort } = createMockHost();
    startStream(host, SAMPLE_REQ, rendererPort);

    // 各种无效消息都不应抛错
    providerPort.emitMessage(null);
    providerPort.emitMessage('string');
    providerPort.emitMessage(42);
    providerPort.emitMessage({ kind: 'unknown' });
    providerPort.emitMessage({});

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(messagesToRenderer.length).toBe(0);
  });

  it('heartbeat / ready 消息不透传给 Renderer', async () => {
    const { host, providerPort } = createMockHost();
    startStream(host, SAMPLE_REQ, rendererPort);

    providerPort.emitMessage({
      kind: 'heartbeat',
      timestamp: Date.now(),
      stats: { activeStreams: 1, totalRequests: 1 },
    });
    providerPort.emitMessage({
      kind: 'ready',
      manifest: host.manifest,
    });

    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(messagesToRenderer.length).toBe(0);
  });
});
