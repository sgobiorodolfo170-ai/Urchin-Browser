/**
 * @urchin/provider-sdk · 核心运行器
 *
 * 依据：契约 I §2 / OR1-OR9 / 04-模块全景 M11/M12
 *
 * 职责：
 * 1. 监听 parentPort，接收 Orchestrator 转发的 MessagePort
 * 2. 处理 Orchestrator → Provider 消息（init/stream/complete/abort/dispose）
 * 3. 调用 Provider 实现的 UrchinAIProvider 接口
 * 4. 包装响应为 ProviderToOrchMessage 发回 Orchestrator
 * 5. 启动心跳定时器（OR3 决策：5s 间隔）
 *
 * 设计要点：
 * - Provider 实现只需实现 UrchinAIProvider 接口，消息协议由 SDK 处理
 * - 流式调用：SDK 消费 AsyncIterable，逐 chunk 转发为 stream.chunk 消息
 * - abort：SDK 在迭代层检查 AbortSignal，aborted 时停止迭代
 * - dispose：调用 Provider.dispose() 后退出进程
 */
import type { Logger } from '@urchin/logger';
import { createLogger } from '@urchin/logger';
import type {
  CompletionRequest,
  ProviderConfig,
  ProviderManifest,
  UrchinAIProvider,
} from '@urchin/ai-provider-contract';
import { ProviderError } from '@urchin/ai-provider-contract';
import { buildProviderContext } from './context';
import type {
  MessagePortLike,
  ParentPortLike,
  ParentPortMessageEvent,
  TimerProvider,
} from './types';
import { DEFAULT_TIMERS } from './types';

const log = createLogger('provider-sdk');

/** OR3 决策：心跳间隔 5s */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/** Orchestrator → Provider 消息（与 orchestrator/types.ts 对齐） */
type OrchToProviderMessage =
  | { readonly kind: 'init'; readonly providerId: string; readonly config: unknown }
  | {
      readonly kind: 'complete';
      readonly conversationId?: string;
      readonly req: CompletionRequest;
    }
  | {
      readonly kind: 'stream';
      readonly conversationId?: string;
      readonly req: CompletionRequest;
    }
  | { readonly kind: 'abort'; readonly conversationId?: string }
  | { readonly kind: 'dispose' };

/** Provider → Orchestrator 消息（与 orchestrator/types.ts 对齐） */
type ProviderToOrchMessage =
  | { readonly kind: 'ready'; readonly manifest: ProviderManifest }
  | {
      readonly kind: 'heartbeat';
      readonly timestamp: number;
      readonly stats: { readonly activeStreams: number; readonly totalRequests: number };
    }
  | {
      readonly kind: 'complete.response';
      readonly conversationId?: string;
      readonly response: unknown;
    }
  | {
      readonly kind: 'stream.chunk';
      readonly conversationId?: string;
      readonly chunk: unknown;
    }
  | {
      readonly kind: 'stream.end';
      readonly conversationId?: string;
      readonly finishReason: string;
      readonly usage?: unknown;
    }
  | { readonly kind: 'error'; readonly conversationId?: string; readonly error: unknown };

/** SDK 运行选项 */
export interface ProviderSdkOptions {
  readonly parentPort: ParentPortLike;
  readonly log?: Logger;
  readonly heartbeatIntervalMs?: number;
  readonly timers?: TimerProvider;
  /**
   * 退出进程的函数，默认 `process.exit(0)`。
   * 测试中传 `() => {}` 跳过，由 `handle.stop()` 控制清理。
   */
  readonly exitProcess?: () => void;
}

/** SDK 运行句柄（用于测试） */
export interface ProviderSdkHandle {
  /** 主动停止 SDK（清理心跳、调用 Provider.dispose） */
  stop(): Promise<void>;
  /** SDK 是否已就绪（收到 init 并发送 ready） */
  readonly ready: boolean;
  /** 当前活跃流数量 */
  readonly activeStreamCount: number;
}

/**
 * 启动 Provider SDK。
 *
 * @param createProvider 创建 Provider 实例的工厂函数
 * @param options SDK 选项（parentPort 必填）
 * @returns SDK 运行句柄
 *
 * 使用示例（在 Provider 的 index.js 中）：
 * ```ts
 * import { runProvider } from '@urchin/provider-sdk';
 * import type { UrchinAIProvider } from '@urchin/ai-provider-contract';
 *
 * const provider: UrchinAIProvider = { ... };
 * void runProvider(() => provider, { parentPort: process.parentPort! });
 * ```
 */
export function runProvider(
  createProvider: () => UrchinAIProvider,
  options: ProviderSdkOptions,
): ProviderSdkHandle {
  const logger = options.log ?? log;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const exitProcess = options.exitProcess ?? defaultExitProcess;

  let provider: UrchinAIProvider | null = null;
  let orchPort: MessagePortLike | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let totalRequests = 0;
  let isReady = false;

  // conversationId → AbortController，用于中止流式调用
  const abortControllers = new Map<string, AbortController>();
  // 无 conversationId 的流（边缘情况），用单一 AbortController
  let defaultAbortController: AbortController | null = null;

  // ── 监听 parentPort：等待 orch.init 消息（含 transferred port） ──
  options.parentPort.on('message', (event: ParentPortMessageEvent) => {
    const data = event.data as { kind?: string } | null;
    if (!data || typeof data !== 'object') return;

    if (data.kind === 'orch.init') {
      const port = event.ports[0];
      if (!port) {
        logger.error('orch.init received but no port transferred');
        return;
      }
      orchPort = port;
      orchPort.on('message', (msg) => {
        void handleOrchMessage(msg);
      });
      orchPort.start();
      logger.info('provider sdk port received, waiting for init');
    }
  });

  /**
   * 处理 Orchestrator → Provider 消息。
   */
  async function handleOrchMessage(raw: unknown): Promise<void> {
    const msg = raw as OrchToProviderMessage | null;
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') {
      logger.warn('invalid message from orchestrator', { raw });
      return;
    }

    switch (msg.kind) {
      case 'init':
        await handleInit(msg);
        break;
      case 'stream':
        await handleStream(msg);
        break;
      case 'complete':
        await handleComplete(msg);
        break;
      case 'abort':
        handleAbort(msg);
        break;
      case 'dispose':
        await handleDispose();
        break;
    }
  }

  /** 处理 init：创建 Provider、初始化、发送 ready、启动心跳 */
  async function handleInit(msg: Extract<OrchToProviderMessage, { kind: 'init' }>): Promise<void> {
    try {
      provider = createProvider();
      const config = (msg.config as ProviderConfig) ?? {};
      // 全局 AbortSignal（占位，每个 stream 用独立 controller）
      const ctxAbort = new AbortController();
      const ctx = buildProviderContext(config, ctxAbort.signal, `provider:${msg.providerId}`);
      await provider.initialize(ctx);
      isReady = true;

      send({ kind: 'ready', manifest: provider.manifest });
      startHeartbeat();
      logger.info('provider ready', {
        providerId: msg.providerId,
        capabilities: provider.manifest.capabilities,
      });
    } catch (err) {
      logger.error('provider init failed', { error: errorMessage(err) });
      send({
        kind: 'error',
        error: { message: errorMessage(err), code: errorCode(err) },
      });
    }
  }

  /** 处理 stream：消费 AsyncIterable，转发 chunk */
  async function handleStream(
    msg: Extract<OrchToProviderMessage, { kind: 'stream' }>,
  ): Promise<void> {
    if (!provider) {
      send({
        kind: 'error',
        conversationId: msg.conversationId,
        error: { message: 'provider not initialized' },
      });
      return;
    }

    const conversationId = msg.conversationId;
    const ac = new AbortController();
    if (conversationId !== undefined) {
      abortControllers.set(conversationId, ac);
    } else {
      defaultAbortController = ac;
    }
    totalRequests++;

    try {
      const iter = provider.stream({ ...msg.req, conversationId });
      let finishReason = 'stop';

      for await (const chunk of iter) {
        if (ac.signal.aborted) {
          finishReason = 'aborted';
          break;
        }
        send({ kind: 'stream.chunk', conversationId, chunk });
      }

      // 流结束（正常或 abort）
      send({
        kind: 'stream.end',
        conversationId,
        finishReason,
        // M17 token 直通：从 Provider 流结束中提取 usage（如 Provider 在 chunk 中携带）
        // v0.1 mock-echo 不上报 usage，留空
      });
    } catch (err) {
      logger.warn('stream failed', { conversationId, error: errorMessage(err) });
      const providerError = ProviderError.from(err);
      send({
        kind: 'error',
        conversationId,
        error: {
          message: providerError.message,
          code: providerError.code,
          retryable: providerError.retryable,
        },
      });
    } finally {
      if (conversationId !== undefined) {
        abortControllers.delete(conversationId);
      } else {
        defaultAbortController = null;
      }
    }
  }

  /** 处理 complete：非流式调用 */
  async function handleComplete(
    msg: Extract<OrchToProviderMessage, { kind: 'complete' }>,
  ): Promise<void> {
    if (!provider) {
      send({
        kind: 'error',
        conversationId: msg.conversationId,
        error: { message: 'provider not initialized' },
      });
      return;
    }

    totalRequests++;
    try {
      const response = await provider.complete(msg.req);
      send({ kind: 'complete.response', conversationId: msg.conversationId, response });
    } catch (err) {
      logger.warn('complete failed', {
        conversationId: msg.conversationId,
        error: errorMessage(err),
      });
      const providerError = ProviderError.from(err);
      send({
        kind: 'error',
        conversationId: msg.conversationId,
        error: {
          message: providerError.message,
          code: providerError.code,
          retryable: providerError.retryable,
        },
      });
    }
  }

  /** 处理 abort：触发对应 conversationId 的 AbortController */
  function handleAbort(msg: Extract<OrchToProviderMessage, { kind: 'abort' }>): void {
    if (msg.conversationId !== undefined) {
      const ac = abortControllers.get(msg.conversationId);
      if (ac) {
        ac.abort();
        logger.info('abort signal sent', { conversationId: msg.conversationId });
      } else {
        logger.warn('abort: conversation not found', { conversationId: msg.conversationId });
      }
    } else {
      defaultAbortController?.abort();
    }
  }

  /** 处理 dispose：清理资源并退出 */
  async function handleDispose(): Promise<void> {
    logger.info('dispose received, cleaning up');
    if (provider) {
      try {
        await provider.dispose();
      } catch (err) {
        logger.warn('provider.dispose failed', { error: errorMessage(err) });
      }
    }
    if (heartbeatTimer !== undefined) {
      timers.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    orchPort?.close();
    exitProcess();
  }

  /** 启动心跳定时器 */
  function startHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      timers.clearInterval(heartbeatTimer);
    }
    heartbeatTimer = timers.setInterval(() => {
      send({
        kind: 'heartbeat',
        timestamp: Date.now(),
        stats: {
          activeStreams: abortControllers.size + (defaultAbortController ? 1 : 0),
          totalRequests,
        },
      });
    }, heartbeatIntervalMs);
  }

  /** 发送消息给 Orchestrator */
  function send(msg: ProviderToOrchMessage): void {
    if (!orchPort) {
      logger.warn('cannot send message, port not ready', { kind: msg.kind });
      return;
    }
    try {
      orchPort.postMessage(msg);
    } catch (err) {
      logger.error('postMessage failed', { kind: msg.kind, error: errorMessage(err) });
    }
  }

  // 返回运行句柄（主要用于测试）
  return {
    async stop(): Promise<void> {
      if (heartbeatTimer !== undefined) {
        timers.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (provider) {
        try {
          await provider.dispose();
        } catch {
          // ignore
        }
      }
      orchPort?.close();
    },
    get ready(): boolean {
      return isReady;
    },
    get activeStreamCount(): number {
      return abortControllers.size + (defaultAbortController ? 1 : 0);
    },
  };
}

/** 提取错误消息 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 提取错误码 */
function errorCode(err: unknown): string {
  if (err instanceof ProviderError) return err.code;
  return 'UNKNOWN';
}

/** 默认退出进程函数（生产环境） */
function defaultExitProcess(): void {
  if (typeof process !== 'undefined' && typeof process.exit === 'function') {
    process.exit(0);
  }
}
