/**
 * AI 对话状态管理（Zustand store）
 *
 * 从 apps/desktop 迁移至 ai-extension，逻辑保持一致。
 * 依据：契约 E §2 Conversation 数据结构 / SP1-SP7 决策
 */
import { create } from 'zustand';

// ─── 类型定义 ───

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
}

export type StreamingState = 'idle' | 'streaming' | 'error' | 'aborted';

export interface Conversation {
  readonly id: string;
  readonly tabId: number | null;
  readonly providerId: string;
  readonly model: string;
  messages: ChatMessage[];
  streamingState: StreamingState;
  streamingBuffer: string;
  readonly usage?: { promptTokens: number; completionTokens: number };
  readonly createdAt: number;
  updatedAt: number;
}

interface AiConversationStore {
  conversations: Map<string, Conversation>;
  activeConversationId: string | null;
  createConversation(params: {
    conversationId: string;
    tabId: number | null;
    providerId: string;
    model: string;
  }): Conversation;
  getActiveConversation(): Conversation | undefined;
  setActiveConversation(conversationId: string | null): void;
  addUserMessage(conversationId: string, content: string): void;
  startStreaming(conversationId: string): void;
  appendToken(conversationId: string, delta: string): void;
  markComplete(
    conversationId: string,
    finishReason: string,
    usage?: { promptTokens: number; completionTokens: number },
  ): void;
  markError(conversationId: string, error: { code: string; message: string }): void;
  markAborted(conversationId: string): void;
  removeConversation(conversationId: string): void;
}

function generateMessageId(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const useAiConversationStore = create<AiConversationStore>((set, get) => ({
  conversations: new Map(),
  activeConversationId: null,

  createConversation({ conversationId, tabId, providerId, model }) {
    const existing = get().conversations.get(conversationId);
    if (existing) return existing;

    const now = Date.now();
    const conversation: Conversation = {
      id: conversationId,
      tabId,
      providerId,
      model,
      messages: [],
      streamingState: 'idle',
      streamingBuffer: '',
      createdAt: now,
      updatedAt: now,
    };

    set((state) => {
      const conversations = new Map(state.conversations);
      conversations.set(conversationId, conversation);
      return { conversations, activeConversationId: conversationId };
    });

    return conversation;
  },

  getActiveConversation() {
    const { conversations, activeConversationId } = get();
    if (!activeConversationId) return undefined;
    return conversations.get(activeConversationId);
  },

  setActiveConversation(conversationId) {
    set({ activeConversationId: conversationId });
  },

  addUserMessage(conversationId, content) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (!conv) return state;

      const message: ChatMessage = {
        id: generateMessageId(),
        role: 'user',
        content,
        createdAt: Date.now(),
      };

      const updated: Conversation = {
        ...conv,
        messages: [...conv.messages, message],
        updatedAt: Date.now(),
      };
      conversations.set(conversationId, updated);
      return { conversations };
    });
  },

  startStreaming(conversationId) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (!conv) return state;

      conversations.set(conversationId, {
        ...conv,
        streamingState: 'streaming',
        streamingBuffer: '',
        updatedAt: Date.now(),
      });
      return { conversations };
    });
  },

  appendToken(conversationId, delta) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (conv?.streamingState !== 'streaming') return state;

      conversations.set(conversationId, {
        ...conv,
        streamingBuffer: conv.streamingBuffer + delta,
        updatedAt: Date.now(),
      });
      return { conversations };
    });
  },

  markComplete(conversationId, _finishReason, usage) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (!conv) return state;

      const assistantMessage: ChatMessage = {
        id: generateMessageId(),
        role: 'assistant',
        content: conv.streamingBuffer,
        createdAt: Date.now(),
      };

      conversations.set(conversationId, {
        ...conv,
        messages: [...conv.messages, assistantMessage],
        streamingBuffer: '',
        streamingState: 'idle',
        usage,
        updatedAt: Date.now(),
      });
      return { conversations };
    });
  },

  markError(conversationId, error) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (!conv) return state;

      const errorMessage = error?.message ?? 'Unknown error';
      const messages = conv.streamingBuffer
        ? [
            ...conv.messages,
            {
              id: generateMessageId(),
              role: 'assistant' as const,
              content: `${conv.streamingBuffer}\n\n[Error: ${errorMessage}]`,
              createdAt: Date.now(),
            },
          ]
        : [
            ...conv.messages,
            {
              id: generateMessageId(),
              role: 'assistant' as const,
              content: `[Error: ${errorMessage}]`,
              createdAt: Date.now(),
            },
          ];

      conversations.set(conversationId, {
        ...conv,
        messages,
        streamingBuffer: '',
        streamingState: 'error',
        updatedAt: Date.now(),
      });
      return { conversations };
    });
  },

  markAborted(conversationId) {
    set((state) => {
      const conversations = new Map(state.conversations);
      const conv = conversations.get(conversationId);
      if (!conv) return state;

      const messages = conv.streamingBuffer
        ? [
            ...conv.messages,
            {
              id: generateMessageId(),
              role: 'assistant' as const,
              content: conv.streamingBuffer + '\n\n[Aborted by user]',
              createdAt: Date.now(),
            },
          ]
        : conv.messages;

      conversations.set(conversationId, {
        ...conv,
        messages,
        streamingBuffer: '',
        streamingState: 'aborted',
        updatedAt: Date.now(),
      });
      return { conversations };
    });
  },

  removeConversation(conversationId) {
    set((state) => {
      const conversations = new Map(state.conversations);
      conversations.delete(conversationId);
      const activeConversationId =
        state.activeConversationId === conversationId ? null : state.activeConversationId;
      return { conversations, activeConversationId };
    });
  },
}));
