/**
 * W5-D3 端到端集成测试 · Orchestrator ↔ Provider SDK
 *
 * 验证完整流程：
 * 1. ProviderRegistry 扫描 mock-echo fixture
 * 2. Orchestrator.ensureProviderLoaded 触发 spawn
 * 3. SDK runner 接管 child port，处理 init → ready
 * 4. startStream 发送 stream 消息，SDK 消费 AsyncIterable 并逐 chunk 转发
 * 5. Renderer port 接收 stream.chunk + stream.end
 *
 * 不依赖真实 Electron utility process：用 MockMessagePort 配对模拟双向通信。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  UrchinAIProvider,
  ProviderManifest,
  CompletionRequest,
  CompletionResponse,
  CompletionChunk,
} from '@urchin/ai-provider-contract';
import { runProvider } from '@urchin/provider-sdk';
import { Orchestrator } from '../../src/main/orchestrator/orchestrator';
import { ProviderRegistry } from '../../src/main/orchestrator/provider-registry';
import { startStream } from '../../src/main/orchestrator/stream';
import {
  MockMessagePort,
  MockTimers,
  createMockProcessFactory,
} from '../helpers/mock-orchestrator';
import type { ParentPortLike, ParentPortMessageEvent, MessagePortLike } from '@urchin/provider-sdk';

/** mock-echo Provider 的 TypeScript 实现（用于集成测试，与 fixtures/mock-echo-provider/index.js 行为一致） */
class MockEchoProvider implements UrchinAIProvider {
  readonly manifest: ProviderManifest = {
    id: 'mock-echo',
    name: 'Mock Echo Provider',
    version: '1.0.0',
    apiVersion: 'urchin-ai-provider/v1',
    capabilities: ['chat.completion', 'chat.completion.streaming'],
    configSchema: z.object({}),
    authMethod: 'none',
    rateLimit: { requestsPerMin: 120 },
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async initialize(_ctx: unknown): Promise<void> {
    // mock-echo 不需要初始化
  }

  async dispose(): Promise<void> {
    // noop
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const lastUser = getLastUserContent(req.messages);
    const output = 'Echo: ' + reverseString(lastUser);
    return {
      content: output,
      role: 'assistant',
      finishReason: 'stop',
      usage: { promptTokens: lastUser.length, completionTokens: output.length },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async generator
  async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
    const lastUser = getLastUserContent(req.messages);
    const output = 'Echo: ' + reverseString(lastUser);
    // 按字符 chunk 输出
    for (const ch of Array.from(output)) {
      yield { content: ch };
    }
  }
}

/** Mock parentPort：模拟 Electron utility process 的 process.parentPort */
class MockParentPort implements ParentPortLike {
  private readonly listeners: ((event: ParentPortMessageEvent) => void)[] = [];

  on(_event: 'message', listener: (event: ParentPortMessageEvent) => void): this {
    this.listeners.push(listener);
    return this;
  }

  postMessage(): void {
    // noop（SDK 不通过 parentPort 发消息给 Orchestrator）
  }

  /** 模拟 Orchestrator 把 port transferred 给 child */
  emitOrchInit(port: MessagePortLike): void {
    for (const l of this.listeners) {
      l({ data: { kind: 'orch.init' }, ports: [port] });
    }
  }
}

// ─── 工具函数 ───

function getLastUserContent(messages: readonly { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return m.content;
  }
  return '';
}

function reverseString(s: string): string {
  return Array.from(s).reverse().join('');
}

/** 创建临时 providers 目录并复制 mock-echo fixture */
function setupMockEchoProviderDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'urchin-e2e-'));
  const providerDir = join(dir, 'mock-echo');
  mkdirSync(providerDir, { recursive: true });
  // 复制 fixture
  const fixtureDir = join(__dirname, '..', 'fixtures', 'mock-echo-provider');
  copyFileSync(join(fixtureDir, 'manifest.json'), join(providerDir, 'manifest.json'));
  copyFileSync(join(fixtureDir, 'index.js'), join(providerDir, 'index.js'));
  return dir;
}

// ─── 测试 ───

describe('W5-D3: Orchestrator ↔ Provider SDK 端到端', () => {
  let tempDir: string;
  let registry: ProviderRegistry;
  let mockFactory: ReturnType<typeof createMockProcessFactory>;
  let timers: MockTimers;
  let sdkParentPort: MockParentPort;
  let sdkHandle: ReturnType<typeof runProvider> | null;

  beforeEach(() => {
    tempDir = setupMockEchoProviderDir();
    registry = new ProviderRegistry(tempDir);
    registry.scan();
    mockFactory = createMockProcessFactory();
    timers = new MockTimers();
    sdkParentPort = new MockParentPort();
    sdkHandle = null;
  });

  afterEach(async () => {
    if (sdkHandle) {
      await sdkHandle.stop();
      sdkHandle = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('ProviderRegistry 应扫描到 mock-echo', () => {
    expect(registry.has('mock-echo')).toBe(true);
    const reg = registry.get('mock-echo');
    expect(reg).toBeDefined();
    expect(reg!.id).toBe('mock-echo');
    expect(reg!.authMethod).toBe('none');
    expect(reg!.capabilities).toContain('chat.completion.streaming');
  });

  it('完整流程：spawn → init → ready → stream → chunks → end', async () => {
    // 1. 创建 Orchestrator（注入 configProvider）
    const orchestrator = new Orchestrator({
      registry,
      processFactory: mockFactory.factory,
      timers,
      configProvider: () => Promise.resolve({ apiKey: 'test-key' }),
    });

    // 2. 创建 SDK runner（等待 orch.init）
    sdkHandle = runProvider(() => new MockEchoProvider(), {
      parentPort: sdkParentPort,
      heartbeatIntervalMs: 60_000, // 测试中不触发心跳
      exitProcess: () => undefined, // 测试中不退出进程
    });

    // 3. 触发 ensureProviderLoaded
    const host = await orchestrator.ensureProviderLoaded('mock-echo');
    expect(host.state).toBe('initializing');
    expect(mockFactory.childPorts.length).toBe(1);

    // 4. 模拟 Electron 把 port2 transferred 给 child SDK
    sdkParentPort.emitOrchInit(mockFactory.childPorts[0]!);

    // 5. 等待 SDK 收到 init 并响应 ready
    await waitFor(50);
    expect(host.state).toBe('ready');
    expect(sdkHandle.ready).toBe(true);

    // 6. 创建 renderer port，启动 stream
    // rendererPort = Renderer 端（test 在此监听），orchSidePort = Orchestrator 端（传给 startStream）
    const [rendererPort, orchSidePort] = MockMessagePort.pair();
    const receivedMessages: unknown[] = [];
    rendererPort.on('message', (msg) => {
      receivedMessages.push(msg);
    });
    rendererPort.start();

    const req: CompletionRequest = {
      conversationId: 'conv-e2e-1',
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'mock-model',
    };

    startStream(host, req, orchSidePort);

    // 7. 等待 stream 完成（SDK 逐字符输出 'Echo: olleH' 共 11 个字符）
    await waitFor(100);

    // 8. 验证 renderer 收到 chunks + end
    const chunkMsgs = receivedMessages.filter(
      (m) => (m as { kind?: string }).kind === 'stream.chunk',
    );
    const endMsg = receivedMessages.find((m) => (m as { kind?: string }).kind === 'stream.end');

    expect(chunkMsgs.length).toBe(11); // 'Echo: olleH' 长度
    expect(endMsg).toBeDefined();
    expect((endMsg as { finishReason: string }).finishReason).toBe('stop');

    // 9. 验证 chunk 内容拼起来是 'Echo: olleH'
    const assembled = chunkMsgs
      .map((m) => (m as { chunk: { content?: string } }).chunk.content ?? '')
      .join('');
    expect(assembled).toBe('Echo: olleH');

    // 清理
    await orchestrator.disposeHost('mock-echo');
  });

  it('完整流程：complete（非流式）', async () => {
    const orchestrator = new Orchestrator({
      registry,
      processFactory: mockFactory.factory,
      timers,
    });

    sdkHandle = runProvider(() => new MockEchoProvider(), {
      parentPort: sdkParentPort,
      heartbeatIntervalMs: 60_000,
      exitProcess: () => undefined,
    });

    const host = await orchestrator.ensureProviderLoaded('mock-echo');
    sdkParentPort.emitOrchInit(mockFactory.childPorts[0]!);
    await waitFor(50);
    expect(host.state).toBe('ready');

    // 在 orchestrator port 上监听 complete.response（Orchestrator 不转发 complete.response，
    // 但 EventEmitter 支持多 listener，此处追加一个监听器捕获消息）
    const orchMessages: unknown[] = [];
    mockFactory.orchestratorPorts[0]!.on('message', (msg: unknown) => {
      orchMessages.push(msg);
    });

    // 发送 complete 消息
    const req: CompletionRequest = {
      conversationId: 'conv-e2e-2',
      messages: [{ role: 'user', content: 'World' }],
      model: 'mock-model',
    };
    host.port.postMessage({ kind: 'complete', conversationId: 'conv-e2e-2', req });

    await waitFor(50);

    const response = orchMessages.find(
      (m) => (m as { kind?: string }).kind === 'complete.response',
    );
    expect(response).toBeDefined();
    expect((response as { response: CompletionResponse }).response.content).toBe('Echo: dlroW');

    await orchestrator.disposeHost('mock-echo');
  });

  it('完整流程：abort 中止流式调用', async () => {
    // 创建一个慢速 Provider
    class SlowEchoProvider extends MockEchoProvider {
      override async *stream(req: CompletionRequest): AsyncIterable<CompletionChunk> {
        const lastUser = getLastUserContent(req.messages);
        const output = 'Echo: ' + reverseString(lastUser);
        for (const ch of Array.from(output)) {
          yield { content: ch };
          await new Promise((r) => setTimeout(r, 20)); // 每个 chunk 延迟 20ms
        }
      }
    }

    const orchestrator = new Orchestrator({
      registry,
      processFactory: mockFactory.factory,
      timers,
    });

    sdkHandle = runProvider(() => new SlowEchoProvider(), {
      parentPort: sdkParentPort,
      heartbeatIntervalMs: 60_000,
      exitProcess: () => undefined,
    });

    const host = await orchestrator.ensureProviderLoaded('mock-echo');
    sdkParentPort.emitOrchInit(mockFactory.childPorts[0]!);
    await waitFor(50);
    expect(host.state).toBe('ready');

    // rendererPort = Renderer 端（test 监听），orchSidePort = Orchestrator 端（传给 startStream）
    const [rendererPort, orchSidePort] = MockMessagePort.pair();
    const receivedMessages: unknown[] = [];
    rendererPort.on('message', (msg) => receivedMessages.push(msg));
    rendererPort.start();

    const req: CompletionRequest = {
      conversationId: 'conv-abort-e2e',
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'mock-model',
    };
    const handle = startStream(host, req, orchSidePort);

    // 等待第一个 chunk 到达
    await waitFor(30);

    // 触发 abort
    handle.abort();
    await waitFor(100);

    // 应该收到 stream.end with finishReason='aborted'
    const endMsg = receivedMessages.find((m) => (m as { kind?: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();
    // abort 后 SDK 应停止迭代
    expect(handle.ended).toBe(true);

    await orchestrator.disposeHost('mock-echo');
  });

  it('configProvider 注入的 config 应传递到 Provider.initialize', async () => {
    let receivedConfig: unknown = null;
    class CapturingProvider extends MockEchoProvider {
      // eslint-disable-next-line @typescript-eslint/require-await -- 接口要求 async
      override async initialize(ctx: { config: unknown }): Promise<void> {
        receivedConfig = ctx.config;
      }
    }

    const orchestrator = new Orchestrator({
      registry,
      processFactory: mockFactory.factory,
      timers,
      configProvider: () => Promise.resolve({ apiKey: 'injected-key', model: 'custom' }),
    });

    sdkHandle = runProvider(() => new CapturingProvider(), {
      parentPort: sdkParentPort,
      heartbeatIntervalMs: 60_000,
      exitProcess: () => undefined,
    });

    await orchestrator.ensureProviderLoaded('mock-echo');
    sdkParentPort.emitOrchInit(mockFactory.childPorts[0]!);
    await waitFor(50);

    expect(receivedConfig).toEqual({ apiKey: 'injected-key', model: 'custom' });

    await orchestrator.disposeHost('mock-echo');
  });
});

/** 等待指定毫秒，确保异步消息传递完成 */
async function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
