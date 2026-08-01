/**
 * M11 AI Orchestrator · 流式调用链路（契约 I §6）+ M17 token 直通
 *
 * 职责：
 * 1. 桥接 Renderer Port ↔ Provider Child Port
 * 2. 透传 stream.chunk / stream.end 消息（含 token usage）
 * 3. 监听 Renderer abort 信号，转发给 Provider Child
 * 4. 流结束后清理监听器，避免泄漏
 *
 * 设计要点：
 * - 单向流：Provider → Orchestrator → Renderer
 * - abort 双向：Renderer → Orchestrator → Provider
 * - 流结束（stream.end / error）后自动解绑监听器
 */
import { createLogger } from '@urchin/logger';
import type { IMessagePort, ProviderHost, ProviderToOrchMessage } from './types';
import type { CompletionRequest } from '@urchin/ai-provider-contract';

const log = createLogger('orchestrator-stream');

/** Renderer → Orchestrator 消息（仅 abort 一种） */
export interface RendererToOrchMessage {
  readonly kind: 'abort';
  readonly conversationId?: string;
}

/**
 * 流式调用结果。
 *
 * startStream 不返回数据本身，而是通过 rendererPort 推送消息。
 * 返回的 cleanup 函数用于在流结束前主动中断（如 renderer 关闭）。
 */
export interface StreamHandle {
  /** 流的会话 ID */
  readonly conversationId: string;
  /** 主动中断流（向 Provider 发 abort） */
  abort(): void;
  /** 流是否已结束 */
  readonly ended: boolean;
}

/**
 * 启动一次流式调用。
 *
 * 1. 向 Provider Child 发 stream 消息
 * 2. 监听 Provider Port 的 stream.chunk / stream.end / error 消息
 * 3. 透传给 Renderer Port（含 token usage，M17 直通）
 * 4. 监听 Renderer Port 的 abort 消息，转发给 Provider
 * 5. 流结束后清理所有监听器
 *
 * @param host Provider Host（已 ready）
 * @param req 补全请求
 * @param rendererPort Renderer 端的 MessagePort（用于推送 chunk）
 * @param options 可选配置（注入标记结束的回调便于测试）
 */
export function startStream(
  host: ProviderHost,
  req: CompletionRequest,
  rendererPort: IMessagePort,
  options?: {
    readonly onEnd?: (finishReason: string, usage?: unknown) => void;
  },
): StreamHandle {
  const conversationId = req.conversationId ?? generateConversationId();

  // 创建一个可变状态对象，便于闭包内修改
  // - ended: 流是否已结束（abort 或 stream.end/error），用于 abort 幂等
  // - cleaned: 资源是否已清理（port/listener 移除），用于 cleanup 幂等
  //   分离两个标志：abort 时设 ended=true 但不 cleanup（等 Provider 发回 stream.end 再 cleanup）
  const state = { ended: false, cleaned: false };

  /** 清理监听器与端口（stream.end/error 到达时调用） */
  const cleanup = (): void => {
    if (state.cleaned) return;
    state.cleaned = true;
    // 精确移除当前流注册的 provider 端 listener（不影响 host.port 上其他流）
    host.port.removeListener('message', providerListener);
    // 关闭 renderer port：流结束后 port2 不再需要，close 会移除其所有监听器
    // 并释放底层 MessagePortMain 原生资源
    rendererPort.close();
  };

  /** Provider 端消息处理 */
  const providerListener = (raw: unknown): void => {
    const msg = raw as ProviderToOrchMessage;
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;

    // 仅处理当前会话的消息（按 conversationId 过滤）
    if (
      'conversationId' in msg &&
      msg.conversationId !== undefined &&
      msg.conversationId !== conversationId
    ) {
      return;
    }

    switch (msg.kind) {
      case 'stream.chunk':
      case 'stream.end':
      case 'error':
        // M17 token 直通：直接透传给 Renderer（含 usage 字段）
        rendererPort.postMessage(msg);
        break;
      default:
        // 其他消息（heartbeat / ready）由 Orchestrator 主循环处理，不转发
        break;
    }

    // 流结束信号
    if (msg.kind === 'stream.end' || msg.kind === 'error') {
      const finishReason = msg.kind === 'stream.end' ? msg.finishReason : 'error';
      const usage = msg.kind === 'stream.end' ? msg.usage : undefined;
      state.ended = true;
      options?.onEnd?.(finishReason, usage);
      cleanup();
    }
  };

  /** Renderer 端 abort 监听 */
  const rendererListener = (raw: unknown): void => {
    const msg = raw as RendererToOrchMessage;
    if (!msg || typeof msg !== 'object' || msg.kind !== 'abort') return;
    if (msg.conversationId !== undefined && msg.conversationId !== conversationId) return;
    // 转发 abort 给 Provider
    host.port.postMessage({ kind: 'abort', conversationId });
    log.info('stream aborted', { providerId: host.providerId, conversationId });
  };

  // 注册监听
  host.port.on('message', providerListener);
  rendererPort.on('message', rendererListener);
  host.port.start();
  rendererPort.start();

  // 启动流
  host.port.postMessage({ kind: 'stream', conversationId, req: { ...req, conversationId } });

  log.info('stream started', {
    providerId: host.providerId,
    conversationId,
    model: req.model,
  });

  return {
    conversationId,
    abort: () => {
      if (state.ended) return;
      // 标记结束，防止重复 abort，但不立即 cleanup port：
      // Provider 收到 abort 后会发回 stream.end，由 providerListener 触发 cleanup。
      // 若立即 cleanup 会移除 providerListener 并 close rendererPort，
      // 导致 Provider 发回的 stream.end 无法到达 renderer。
      state.ended = true;
      host.port.postMessage({ kind: 'abort', conversationId });
    },
    get ended(): boolean {
      return state.ended;
    },
  };
}

/** 生成会话 ID（不依赖 uuid，简单时间戳 + 随机） */
function generateConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
