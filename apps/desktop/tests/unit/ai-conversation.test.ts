/**
 * M13 AI Side Panel · ai-conversation store 单元测试
 *
 * 验证：
 * 1. createConversation 创建对话并设为活跃
 * 2. addUserMessage 添加用户消息
 * 3. startStreaming 设置 streaming 状态并清空 buffer
 * 4. appendToken 追加到 streamingBuffer（SP1）
 * 5. markComplete 合并 buffer 到 messages 并清空状态
 * 6. markError 错误时保留部分响应并标记错误状态
 * 7. markAborted 中止时保留部分响应并标记中止状态
 * 8. removeConversation 删除对话
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAiConversationStore } from '@urchin/ai-extension';

beforeEach(() => {
  // 每个测试前重置 store
  useAiConversationStore.setState({
    conversations: new Map(),
    activeConversationId: null,
  });
});

describe('ai-conversation store', () => {
  it('should create conversation and set as active', () => {
    const store = useAiConversationStore.getState();
    const conv = store.createConversation({
      conversationId: 'conv-1',
      tabId: 1,
      providerId: 'openai',
      model: 'gpt-4o-mini',
    });

    expect(conv.id).toBe('conv-1');
    expect(conv.tabId).toBe(1);
    expect(conv.providerId).toBe('openai');
    expect(conv.model).toBe('gpt-4o-mini');
    expect(conv.messages).toEqual([]);
    expect(conv.streamingState).toBe('idle');
    expect(conv.streamingBuffer).toBe('');
    expect(useAiConversationStore.getState().activeConversationId).toBe('conv-1');
  });

  it('should return existing conversation on duplicate createConversation', () => {
    const store = useAiConversationStore.getState();
    const first = store.createConversation({
      conversationId: 'conv-1',
      tabId: 1,
      providerId: 'openai',
      model: 'gpt-4o-mini',
    });
    const second = useAiConversationStore.getState().createConversation({
      conversationId: 'conv-1',
      tabId: 2,
      providerId: 'anthropic',
      model: 'claude-3',
    });

    expect(second).toBe(first);
    expect(second.tabId).toBe(1);
    expect(second.providerId).toBe('openai');
  });

  it('should add user message to conversation', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });

    useAiConversationStore.getState().addUserMessage('conv-1', 'Hello');

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.role).toBe('user');
    expect(conv.messages[0]!.content).toBe('Hello');
  });

  it('should set streaming state and clear buffer on startStreaming', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });

    useAiConversationStore.getState().startStreaming('conv-1');

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.streamingState).toBe('streaming');
    expect(conv.streamingBuffer).toBe('');
  });

  it('should append tokens to streamingBuffer (SP1)', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.startStreaming('conv-1');

    useAiConversationStore.getState().appendToken('conv-1', 'Hello ');
    useAiConversationStore.getState().appendToken('conv-1', 'world');

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.streamingBuffer).toBe('Hello world');
    expect(conv.messages).toHaveLength(0); // 还在流式中，不写回 messages
  });

  it('should not append token when not in streaming state', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });

    // streamingState 默认是 idle，appendToken 应无效
    useAiConversationStore.getState().appendToken('conv-1', 'Hello');

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.streamingBuffer).toBe('');
  });

  it('should merge buffer into messages on markComplete', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.addUserMessage('conv-1', 'question');
    store.startStreaming('conv-1');
    store.appendToken('conv-1', 'answer part 1 ');
    store.appendToken('conv-1', 'answer part 2');

    useAiConversationStore.getState().markComplete('conv-1', 'stop', {
      promptTokens: 10,
      completionTokens: 20,
    });

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]!.role).toBe('assistant');
    expect(conv.messages[1]!.content).toBe('answer part 1 answer part 2');
    expect(conv.streamingBuffer).toBe('');
    expect(conv.streamingState).toBe('idle');
    expect(conv.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('should preserve partial buffer as message on markError', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.startStreaming('conv-1');
    store.appendToken('conv-1', 'partial response');

    useAiConversationStore.getState().markError('conv-1', {
      code: 'network',
      message: 'Connection lost',
    });

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.streamingState).toBe('error');
    expect(conv.streamingBuffer).toBe('');
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.content).toContain('partial response');
    expect(conv.messages[0]!.content).toContain('Connection lost');
  });

  it('should add error message even without buffer', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.startStreaming('conv-1');

    useAiConversationStore.getState().markError('conv-1', {
      code: 'fatal',
      message: 'Crashed',
    });

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.content).toBe('[Error: Crashed]');
    expect(conv.streamingState).toBe('error');
  });

  it('should preserve partial buffer as message on markAborted', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.startStreaming('conv-1');
    store.appendToken('conv-1', 'partial');

    useAiConversationStore.getState().markAborted('conv-1');

    const conv = useAiConversationStore.getState().conversations.get('conv-1')!;
    expect(conv.streamingState).toBe('aborted');
    expect(conv.streamingBuffer).toBe('');
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]!.role).toBe('assistant');
    expect(conv.messages[0]!.content).toContain('partial');
    expect(conv.messages[0]!.content).toContain('[Aborted by user]');
  });

  it('should remove conversation and clear active id if it was active', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    expect(useAiConversationStore.getState().activeConversationId).toBe('conv-1');

    useAiConversationStore.getState().removeConversation('conv-1');

    expect(useAiConversationStore.getState().conversations.has('conv-1')).toBe(false);
    expect(useAiConversationStore.getState().activeConversationId).toBeNull();
  });

  it('should set active conversation', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });
    store.createConversation({
      conversationId: 'conv-2',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });

    useAiConversationStore.getState().setActiveConversation('conv-1');

    expect(useAiConversationStore.getState().activeConversationId).toBe('conv-1');
  });

  it('should get active conversation', () => {
    const store = useAiConversationStore.getState();
    store.createConversation({
      conversationId: 'conv-1',
      tabId: null,
      providerId: 'p',
      model: 'm',
    });

    const active = useAiConversationStore.getState().getActiveConversation();
    expect(active).toBeDefined();
    expect(active!.id).toBe('conv-1');
  });

  it('should be no-op for non-existent conversation', () => {
    const store = useAiConversationStore.getState();

    // 这些操作不应抛错
    store.addUserMessage('no-such', 'x');
    store.startStreaming('no-such');
    store.appendToken('no-such', 'x');
    store.markComplete('no-such', 'stop');
    store.markError('no-such', { code: 'x', message: 'y' });
    store.markAborted('no-such');
    store.removeConversation('no-such');

    expect(useAiConversationStore.getState().conversations.size).toBe(0);
  });
});
