/**
 * M13 AI 编排 · pi-event-bridge 单元测试
 *
 * 验证 pi Agent 事件 → Urchin StreamMessage 桥接的完整映射：
 * 1. text_delta → stream.chunk
 * 2. thinking_delta 不推送
 * 3. tool_execution_start → chunk 提示
 * 4. tool_execution_end 成功/失败提示
 * 5. agent_end → stream.end（含 usage 提取）
 * 6. agent_end 带错误 → error
 * 7. renderer abort 信号 → agent.abort + stream.end(aborted)
 * 8. handle.abort() 主动中断
 * 9. 结束后不再发送（ended 守卫）
 */

import { describe, it, expect, vi } from 'vitest';
import { bridgeAgentToPort } from '../../src/main/ai/pi-event-bridge';
import type { BridgePort } from '../../src/main/ai/pi-event-bridge';
import type { Agent, AgentEvent } from '@earendil-works/pi-agent-core';

/** 将 mock Agent 断言为 Agent 类型（仅鸭子类型，运行时同构） */
function asAgent(mock: MockAgent): Agent {
  return mock as unknown as Agent;
}

/** mock Agent 结构（含 _emit 辅助方法） */
interface MockAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  abort: ReturnType<typeof vi.fn>;
  _emit(event: AgentEvent): void;
}

/** 创建 mock Agent（subscribe / abort） */
function createMockAgent(): MockAgent {
  const listeners: ((event: AgentEvent) => void)[] = [];
  const abort = vi.fn();
  const agent: MockAgent = {
    subscribe(listener: (event: AgentEvent) => void): () => void {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    abort,
    _emit(event: AgentEvent): void {
      for (const l of [...listeners]) l(event);
    },
  };
  return agent;
}

/** 创建 mock BridgePort，记录 postMessage 与 abort 监听 */
function createMockPort(): BridgePort & {
  messages: unknown[];
  abortListeners: ((raw: unknown) => void)[];
  emitAbort(raw: unknown): void;
  closed: boolean;
} {
  const messages: unknown[] = [];
  const abortListeners: ((raw: unknown) => void)[] = [];
  const mock: BridgePort & {
    messages: unknown[];
    abortListeners: ((raw: unknown) => void)[];
    emitAbort(raw: unknown): void;
    closed: boolean;
  } = {
    messages,
    abortListeners,
    closed: false,
    postMessage(msg: unknown): void {
      messages.push(msg);
    },
    on(_event: 'message', listener: (raw: unknown) => void) {
      abortListeners.push(listener);
      return mock;
    },
    start(): void {
      // noop
    },
    close(): void {
      mock.closed = true;
    },
    emitAbort(raw: unknown): void {
      for (const l of abortListeners) l(raw);
    },
  };
  return mock;
}

function makeTextDelta(delta: string): AgentEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: delta },
    assistantMessageEvent: { type: 'text_delta', delta, contentIndex: 0, partial: '' },
  } as never;
}

function makeThinkingDelta(): AgentEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: 'thinking' },
    assistantMessageEvent: {
      type: 'thinking_delta',
      delta: 'thinking',
      contentIndex: 0,
      partial: '',
    },
  } as never;
}

describe('pi-event-bridge', () => {
  it('should bridge text_delta to stream.chunk', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit(makeTextDelta('Hello'));
    agent._emit(makeTextDelta(' world'));

    const chunks = port.messages.filter((m) => (m as { kind: string }).kind === 'stream.chunk');
    expect(chunks).toHaveLength(2);
    expect((chunks[0] as { chunk: { content: string } }).chunk.content).toBe('Hello');
    expect((chunks[1] as { chunk: { content: string } }).chunk.content).toBe(' world');
    expect(handle.ended).toBe(false);
  });

  it('should not push thinking_delta as chunk', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit(makeThinkingDelta());

    const chunks = port.messages.filter((m) => (m as { kind: string }).kind === 'stream.chunk');
    expect(chunks).toHaveLength(0);
  });

  it('should bridge tool_execution_start to chunk hint', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: {},
    } as never);

    const chunks = port.messages.filter((m) => (m as { kind: string }).kind === 'stream.chunk');
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { chunk: { content: string } }).chunk.content).toContain('[');
    expect((chunks[0] as { chunk: { content: string } }).chunk.content).toContain('read');
  });

  it('should bridge tool_execution_end error to chunk hint', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      isError: true,
    } as never);

    const chunks = port.messages.filter((m) => (m as { kind: string }).kind === 'stream.chunk');
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { chunk: { content: string } }).chunk.content).toContain('[工具');
    expect((chunks[0] as { chunk: { content: string } }).chunk.content).toContain('read');
  });

  it('should bridge tool_execution_end success without chunk', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      isError: false,
    } as never);

    const chunks = port.messages.filter((m) => (m as { kind: string }).kind === 'stream.chunk');
    expect(chunks).toHaveLength(0);
  });

  it('should bridge agent_end to stream.end with stop reason', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const onEnd = vi.fn();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port, { onEnd });

    agent._emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'done' }],
    } as never);

    const endMsg = port.messages.find((m) => (m as { kind: string }).kind === 'stream.end');
    expect(endMsg).toBeDefined();
    expect((endMsg as { finishReason: string }).finishReason).toBe('stop');
    expect(onEnd).toHaveBeenCalledWith('stop', undefined);
    expect(handle.ended).toBe(true);
    expect(port.closed).toBe(true);
  });

  it('should extract usage from agent_end messages', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit({
      type: 'agent_end',
      messages: [
        { role: 'assistant', content: 'done', usage: { input: 10, output: 5, totalTokens: 15 } },
      ],
    } as never);

    const endMsg = port.messages.find((m) => (m as { kind: string }).kind === 'stream.end');
    expect((endMsg as { usage: { promptTokens: number; completionTokens: number } }).usage).toEqual(
      { promptTokens: 10, completionTokens: 5 },
    );
  });

  it('should send error when agent_end has errorMessage and stopReason error', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const onError = vi.fn();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port, { onError });

    agent._emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: '',
          stopReason: 'error',
          errorMessage: 'upstream 500',
        },
      ],
    } as never);

    const errMsg = port.messages.find((m) => (m as { kind: string }).kind === 'error');
    expect(errMsg).toBeDefined();
    expect((errMsg as { error: { message: string } }).error.message).toBe('upstream 500');
    expect(onError).toHaveBeenCalledWith({ code: 'agent_error', message: 'upstream 500' });
    expect(handle.ended).toBe(true);
  });

  it('should forward renderer abort to agent.abort', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const onEnd = vi.fn();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port, { onEnd });

    port.emitAbort({ kind: 'abort', conversationId: 'conv-1' });

    expect(agent.abort).toHaveBeenCalledTimes(1);
    const abortMsg = port.messages.find((m) => (m as { kind: string }).kind === 'abort');
    expect(abortMsg).toBeDefined();
    expect(onEnd).toHaveBeenCalledWith('aborted');
    expect(handle.ended).toBe(true);
  });

  it('should ignore renderer abort for different conversation', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    port.emitAbort({ kind: 'abort', conversationId: 'other-conv' });

    expect(agent.abort).not.toHaveBeenCalled();
    expect(handle.ended).toBe(false);
  });

  it('should ignore non-abort renderer messages', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    port.emitAbort({ kind: 'stream.chunk' });
    port.emitAbort(null);
    port.emitAbort('garbage');

    expect(agent.abort).not.toHaveBeenCalled();
    expect(handle.ended).toBe(false);
  });

  it('should abort via returned handle', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    handle.abort();

    expect(agent.abort).toHaveBeenCalledTimes(1);
    const abortMsg = port.messages.find((m) => (m as { kind: string }).kind === 'abort');
    expect(abortMsg).toBeDefined();
    expect(handle.ended).toBe(true);
  });

  it('should not send after ended (ended guard)', () => {
    const port = createMockPort();
    const agent = createMockAgent();
    const handle = bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'done' }],
    } as never);
    const before = port.messages.length;

    agent._emit(makeTextDelta('after end'));
    expect(port.messages.length).toBe(before);
    handle.abort();
    expect(handle.ended).toBe(true);
  });

  it('should tolerate postMessage throwing', () => {
    const port = createMockPort();
    port.postMessage = () => {
      throw new Error('port closed');
    };
    const agent = createMockAgent();
    bridgeAgentToPort(asAgent(agent), 'conv-1', port);

    agent._emit(makeTextDelta('Hello'));
    agent._emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'done' }],
    } as never);
    expect(true).toBe(true);
  });
});
