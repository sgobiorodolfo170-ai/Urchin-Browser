/**
 * pi Agent 事件桥接 · 方案 A 适配层
 *
 * 职责：
 * 1. 订阅 pi Agent 的 AgentEvent
 * 2. 将 AgentEvent 转换为 Urchin 的 StreamMessage 格式（与现有渲染层契约一致）
 * 3. 通过 MessagePort 推送给渲染进程
 * 4. 监听渲染进程的 abort 信号，转发给 Agent.abort()
 * 5. 流结束后清理监听器，避免泄漏
 *
 * 事件映射：
 * - message_update (text_delta) → stream.chunk { chunk: { content: delta } }
 * - message_update (toolcall_*) → stream.chunk { chunk: { content: '[工具调用...]' } }（提示性）
 * - tool_execution_start → stream.chunk { chunk: { content: '\n[执行工具: name]\n' } }
 * - agent_end → stream.end { finishReason, usage }
 * - error → error { code, message }
 * - abort → abort
 *
 * 设计依据：
 * - 契约 I §6（流式调用链路）+ 与 orchestrator/stream.ts 的 StreamMessage 格式对齐
 * - 渲染层 ai-chat-view.tsx 已实现 StreamMessage 消费，无需改动
 */
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-event-bridge');

/** Urchin StreamMessage 格式（与 orchestrator/stream.ts 对齐，渲染层已消费） */
export interface StreamMessage {
  readonly kind: 'stream.chunk' | 'stream.end' | 'error' | 'abort';
  readonly conversationId: string;
  readonly chunk?: { readonly content?: string; readonly role?: string };
  readonly finishReason?: string;
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

/** MessagePort 最小接口（兼容 Electron MessagePortMain 与 DOM MessagePort） */
export interface BridgePort {
  postMessage(message: unknown): void;
  on(message: 'message', listener: (raw: unknown) => void): unknown;
  start(): void;
  close?(): void;
}

/** 桥接选项 */
export interface BridgeOptions {
  readonly onEnd?: (finishReason: string, usage?: StreamMessage['usage']) => void;
  readonly onError?: (error: { code: string; message: string }) => void;
}

/**
 * 从 AssistantMessageEvent 提取文本增量。
 *
 * text_delta 携带流式文本增量；thinking_delta 是思考过程，
 * 工具调用相关事件不在此提取（由工具执行事件单独提示）。
 */
function extractDeltaFromEvent(event: AssistantMessageEvent): string {
  switch (event.type) {
    case 'text_delta':
      return event.delta ?? '';
    default:
      return '';
  }
}

/**
 * 桥接 pi Agent → Urchin MessagePort。
 *
 * 返回一个 handle，调用 abort() 可主动中断（如 IPC ai.chat.abort）。
 * 流结束（agent_end / error）后自动解绑所有监听器。
 *
 * @param agent pi Agent 实例
 * @param conversationId 会话 ID（用于 StreamMessage 过滤）
 * @param rendererPort 渲染进程 MessagePort（推送 StreamMessage）
 * @param options 可选回调
 */
export function bridgeAgentToPort(
  agent: Agent,
  conversationId: string,
  rendererPort: BridgePort,
  options?: BridgeOptions,
): { abort(): void; readonly ended: boolean } {
  const state = { ended: false };

  /** 发送 StreamMessage 给渲染进程（force=true 时绕过 ended 检查，用于发送终态消息） */
  const send = (msg: StreamMessage, force = false): void => {
    if (state.ended && !force) return;
    try {
      rendererPort.postMessage(msg);
    } catch (e) {
      log.error('failed to post message to renderer', {
        conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /** 结束流并清理 */
  const finish = (finishReason: string, usage?: StreamMessage['usage']): void => {
    if (state.ended) return;
    state.ended = true;
    send({ kind: 'stream.end', conversationId, finishReason, usage }, true);
    options?.onEnd?.(finishReason, usage);
    cleanup();
  };

  /** 清理监听器 */
  const cleanup = (): void => {
    unsubscribe();
    rendererPort.close?.();
  };

  // ── 订阅 Agent 事件 ──
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (state.ended) return;

    switch (event.type) {
      case 'message_update': {
        const delta = extractDeltaFromEvent(event.assistantMessageEvent);
        if (delta) {
          send({ kind: 'stream.chunk', conversationId, chunk: { content: delta } });
        }
        // 思考过程（thinking_delta）可选提示，v0.1 不单独展示，归入 chunk
        if (event.assistantMessageEvent.type === 'thinking_delta') {
          // 思考内容不推送，避免污染输出；后续可单独通道
        }
        break;
      }

      case 'tool_execution_start': {
        // 工具调用提示（让用户感知 agent 在执行操作）
        const hint = `\n[执行工具: ${event.toolName}]\n`;
        send({ kind: 'stream.chunk', conversationId, chunk: { content: hint } });
        log.info('tool execution start', {
          conversationId,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      }

      case 'tool_execution_end': {
        if (event.isError) {
          const hint = `\n[工具 ${event.toolName} 执行失败]\n`;
          send({ kind: 'stream.chunk', conversationId, chunk: { content: hint } });
        }
        log.info('tool execution end', {
          conversationId,
          toolName: event.toolName,
          isError: event.isError,
        });
        break;
      }

      case 'agent_end': {
        // 从最后一条 assistant 消息提取 usage 和错误信息
        const messages = event.messages;
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
        let usage: StreamMessage['usage'] | undefined;
        if (lastAssistant && typeof lastAssistant === 'object' && 'usage' in lastAssistant) {
          const rawUsage = (
            lastAssistant as { usage?: { input?: number; output?: number; totalTokens?: number } }
          ).usage;
          if (rawUsage && typeof rawUsage === 'object') {
            usage = {
              promptTokens: rawUsage.input ?? 0,
              completionTokens: rawUsage.output ?? 0,
            };
          }
        }
        // 检查是否有错误：handleRunFailure 会设置 stopReason='error' 和 errorMessage
        const failureMessage = lastAssistant as
          { stopReason?: string; errorMessage?: string } | undefined;
        if (failureMessage?.errorMessage && failureMessage.stopReason === 'error') {
          const errorMsg = failureMessage.errorMessage;
          log.error('agent ended with error', { conversationId, error: errorMsg });
          state.ended = true;
          send(
            {
              kind: 'error',
              conversationId,
              error: { code: 'agent_error', message: errorMsg, retryable: false },
            },
            true,
          );
          options?.onError?.({ code: 'agent_error', message: errorMsg });
          options?.onEnd?.('error', usage);
          cleanup();
        } else {
          finish('stop', usage);
        }
        break;
      }

      default:
        // turn_start / turn_end / message_start / message_end / agent_start / tool_execution_update
        // 不产生 StreamMessage，仅日志
        break;
    }
  });

  // ── 监听渲染进程 abort 信号 ──
  const rendererListener = (raw: unknown): void => {
    if (state.ended) return;
    const msg = raw as { kind?: string; conversationId?: string };
    if (!msg || typeof msg !== 'object' || msg.kind !== 'abort') return;
    if (msg.conversationId !== undefined && msg.conversationId !== conversationId) return;

    log.info('abort received from renderer', { conversationId });
    agent.abort();
    state.ended = true;
    send({ kind: 'abort', conversationId }, true);
    options?.onEnd?.('aborted');
    cleanup();
  };

  rendererPort.on('message', rendererListener);
  rendererPort.start();

  log.info('agent bridge started', { conversationId });

  return {
    abort(): void {
      if (state.ended) return;
      agent.abort();
      state.ended = true;
      send({ kind: 'abort', conversationId }, true);
      options?.onEnd?.('aborted');
      cleanup();
    },
    get ended(): boolean {
      return state.ended;
    },
  };
}
