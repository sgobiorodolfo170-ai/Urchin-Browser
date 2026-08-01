/**
 * M12 Provider Contract · 消息类型
 *
 * 依据：契约 A §2 / 契约 B §6.2
 *
 * 定义 CompletionRequest / CompletionResponse / CompletionChunk 等核心消息类型，
 * 以及可选的 Embedding 和 ToolCall 类型。
 * 这些类型同时被 Provider 实现和 Orchestrator 使用。
 */

// ─── 角色 ───

export type MessageRole = 'system' | 'user' | 'assistant';

// ─── 对话消息 ───

/** 对话中的一条消息 */
export interface ChatMessage {
  readonly role: MessageRole;
  readonly content: string;
}

// ─── 补全请求 / 响应 ───

/** 补全请求（complete / stream 通用） */
export interface CompletionRequest {
  /** 关联的会话 ID（可选，流式场景由 Orchestrator 注入） */
  readonly conversationId?: string;
  /** 对话消息列表 */
  readonly messages: readonly ChatMessage[];
  /** 模型名称（如 'gpt-4o' / 'claude-3-5-sonnet'） */
  readonly model: string;
  /** 采样温度，0-2，默认由 Provider 决定 */
  readonly temperature?: number;
  /** 最大生成 token 数 */
  readonly maxTokens?: number;
  /** 生成停止标记 */
  readonly stop?: readonly string[];
  /** 透传给 Provider 的额外参数（Provider 私有，不跨 Provider 共享） */
  readonly extra?: Record<string, unknown>;
}

/** 补全响应（非流式 complete() 返回） */
export interface CompletionResponse {
  /** 生成的文本内容 */
  readonly content: string;
  /** 消息角色（通常为 'assistant'） */
  readonly role: MessageRole;
  /** 完成原因 */
  readonly finishReason: CompletionFinishReason;
  /** token 用量统计 */
  readonly usage?: TokenUsage;
}

/** 流式 chunk（stream() 逐个 yield） */
export interface CompletionChunk {
  /** 增量内容（可能为空字符串，表示仅有 role 变化） */
  readonly content?: string;
  /** 角色变化（首个 chunk 通常携带 role） */
  readonly role?: MessageRole;
}

/** 完成原因 */
export type CompletionFinishReason =
  | 'stop' // 正常停止
  | 'length' // 达到 maxTokens
  | 'tool_call' // 触发工具调用
  | 'content_filter' // 内容被过滤
  | 'aborted'; // 用户取消

/** token 用量统计 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

// ─── Embedding（可选能力，v0.2+ 用） ───

export interface EmbeddingRequest {
  /** 需要向量化的文本列表 */
  readonly inputs: readonly string[];
  /** 模型名称 */
  readonly model: string;
}

export interface EmbeddingResponse {
  /** 向量列表，与 inputs 一一对应 */
  readonly embeddings: readonly (readonly number[])[];
  /** token 用量 */
  readonly usage?: TokenUsage;
}

// ─── Tool Calling（可选能力） ───

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  /** 对话消息列表（含历史 + 工具调用结果） */
  readonly messages: readonly ChatMessage[];
  /** 可用工具定义 */
  readonly tools: readonly ToolDefinition[];
  /** 模型名称 */
  readonly model: string;
}

export interface ToolCall {
  /** 工具名称 */
  readonly name: string;
  /** 调用参数（JSON 反序列化后的对象） */
  readonly arguments: Record<string, unknown>;
}

export interface ToolCallResponse {
  /** 模型决定调用的工具列表 */
  readonly toolCalls: readonly ToolCall[];
  /** 完成原因（通常为 'tool_call'） */
  readonly finishReason: CompletionFinishReason;
}
