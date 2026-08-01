// pi package module declarations - type isolation for vendor/pi
//
// 设计理由：pi 源码使用 ES2024 特性（regex v 标志等）与严格类型，
// 与 Urchin 的 ES2023 target 冲突。本声明文件提供必要的类型签名，
// 使 TypeScript 跳过 pi 源码检查，同时通过 Vite alias 在运行时
// 直接打包 pi 的 TS 源码（见 vite.config.ts 的 piAliases）。

// ============================================================================
// @earendil-works/pi-agent-core
// ============================================================================

declare module '@earendil-works/pi-agent-core' {
  import type {
    AssistantMessageEvent,
    Context,
    Message,
    Model,
    SimpleStreamOptions,
    AssistantMessageEventStream,
  } from '@earendil-works/pi-ai';

  /** Agent 消息（联合类型，包含 user/assistant/toolResult 等） */
  export type AgentMessage = Message | { role: 'toolResult'; content: unknown[] };

  /** 工具调用参数 */
  export interface ToolCallParams {
    readonly toolCallId: string;
    readonly params: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly onUpdate?: (update: unknown) => void;
    readonly ctx?: unknown;
  }

  /** Agent 工具接口 */
  export interface AgentTool<S = Record<string, unknown>> {
    readonly name: string;
    readonly description: string;
    readonly schema: S;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
      ctx?: unknown,
    ): Promise<unknown>;
  }

  /** Agent 事件（生命周期 + 消息 + 工具执行） */
  export type AgentEvent =
    | { readonly type: 'agent_start' }
    | { readonly type: 'agent_end'; readonly messages: AgentMessage[] }
    | { readonly type: 'turn_start' }
    | { readonly type: 'turn_end'; readonly message: AgentMessage; readonly toolResults: unknown[] }
    | { readonly type: 'message_start'; readonly message: AgentMessage }
    | {
        readonly type: 'message_update';
        readonly message: AgentMessage;
        readonly assistantMessageEvent: AssistantMessageEvent;
      }
    | { readonly type: 'message_end'; readonly message: AgentMessage }
    | {
        readonly type: 'tool_execution_start';
        readonly toolName: string;
        readonly toolCallId: string;
        readonly args: unknown;
      }
    | {
        readonly type: 'tool_execution_update';
        readonly toolCallId: string;
        readonly toolName: string;
        readonly args: unknown;
        readonly partialResult: unknown;
      }
    | {
        readonly type: 'tool_execution_end';
        readonly toolCallId: string;
        readonly toolName: string;
        readonly result: unknown;
        readonly isError: boolean;
      };

  /** 流式函数签名 */
  export type StreamFn = (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

  /** Agent 构造选项 */
  export interface AgentOptions {
    readonly initialState?: {
      readonly systemPrompt?: string;
      readonly model?: Model;
      readonly thinkingLevel?: string;
      readonly tools?: readonly AgentTool[];
      readonly messages?: AgentMessage[];
    };
    readonly streamFn: StreamFn;
    readonly getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    readonly convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    readonly sessionId?: string;
  }

  /** Agent 类：有状态 agent loop 包装器 */
  export class Agent {
    constructor(options: AgentOptions);
    readonly state: {
      readonly status: 'idle' | 'running' | 'stopped' | 'error';
      readonly model: Model;
      readonly messages: AgentMessage[];
      readonly isStreaming: boolean;
    };
    subscribe(
      handler: (event: AgentEvent, signal?: AbortSignal) => void | Promise<void>,
    ): () => void;
    prompt(input: string): Promise<void>;
    abort(): void;
  }

  export function setDefaultStreamFn(streamFn: StreamFn | undefined): void;
}

// ============================================================================
// @earendil-works/pi-ai
// ============================================================================

declare module '@earendil-works/pi-ai' {
  export type MessageRole = 'system' | 'user' | 'assistant' | 'toolResult';

  export interface TextContent {
    readonly type: 'text';
    readonly text: string;
  }

  export interface ImageContent {
    readonly type: 'image';
    readonly data: unknown;
  }

  export type MessageContent =
    TextContent | ImageContent | { readonly type: string; readonly [k: string]: unknown };

  export interface Message {
    readonly role: MessageRole;
    readonly content: string | readonly MessageContent[];
  }

  export type Api = string;

  export interface Model<TApi extends Api = Api> {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
    readonly api: TApi;
    readonly baseUrl?: string;
    readonly reasoning?: boolean;
    readonly contextWindow?: number;
    readonly maxTokens?: number;
    readonly cost?: {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    };
    readonly input?: readonly string[];
  }

  export interface Context {
    readonly systemPrompt?: string;
    readonly messages: readonly Message[];
    readonly tools?: readonly unknown[];
  }

  export interface StreamOptions {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly signal?: AbortSignal;
    readonly apiKey?: string;
    readonly sessionId?: string;
  }

  export interface SimpleStreamOptions extends StreamOptions {
    readonly reasoning?: string;
    readonly thinkingBudgets?: unknown;
  }

  export interface AssistantMessage {
    readonly role: 'assistant';
    readonly content: readonly MessageContent[];
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly usage?: {
      readonly input: number;
      readonly output: number;
      readonly totalTokens: number;
    };
  }

  /** 流式事件（文本增量、工具调用、思考、结束等） */
  export type AssistantMessageEvent =
    | { readonly type: 'start'; readonly partial: AssistantMessage }
    | {
        readonly type: 'text_start';
        readonly contentIndex: number;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'text_delta';
        readonly contentIndex: number;
        readonly delta: string;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'text_end';
        readonly contentIndex: number;
        readonly content: string;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'thinking_start';
        readonly contentIndex: number;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'thinking_delta';
        readonly contentIndex: number;
        readonly delta: string;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'thinking_end';
        readonly contentIndex: number;
        readonly content: string;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'toolcall_start';
        readonly contentIndex: number;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'toolcall_delta';
        readonly contentIndex: number;
        readonly delta: string;
        readonly partial: AssistantMessage;
      }
    | {
        readonly type: 'toolcall_end';
        readonly contentIndex: number;
        readonly toolCall: unknown;
        readonly partial: AssistantMessage;
      }
    | { readonly type: 'done'; readonly reason: string; readonly message: AssistantMessage }
    | { readonly type: 'error'; readonly reason: string; readonly error: AssistantMessage };

  /** 流式结果（可订阅事件、可 await 最终结果） */
  export interface AssistantMessageEventStream {
    on(handler: (event: AssistantMessageEvent) => void): unknown;
    result(): Promise<AssistantMessage>;
  }

  /** 从消息内容中提取纯文本 */
  export function contentText(content: string | readonly MessageContent[]): string;
}

// ============================================================================
// @earendil-works/pi-ai/compat —— streamSimple + 模型目录
// ============================================================================

declare module '@earendil-works/pi-ai/compat' {
  import type {
    Api,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
  } from '@earendil-works/pi-ai';

  /** 流式调用：根据 model.provider 解析内置 Provider 并流式返回 */
  export function streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;

  /** 内置 Provider 名称联合 */
  export type BuiltinProvider = string;

  /** @deprecated 从内置目录获取模型（compat.ts 别名，原名为 getBuiltinModel） */
  export function getModel<TProvider extends BuiltinProvider>(
    provider: TProvider,
    modelId: string,
  ): Model | undefined;

  /** @deprecated 列出内置 Provider（compat.ts 别名，原名为 getBuiltinProviders） */
  export function getProviders(): readonly BuiltinProvider[];

  /** @deprecated 列出某 Provider 的所有模型（compat.ts 别名，原名为 getBuiltinModels） */
  export function getModels<TProvider extends BuiltinProvider>(
    provider: TProvider,
  ): readonly Model[];

  export function clampThinkingLevel(model: Model, level: string): string;
  export type {
    Api,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
  } from '@earendil-works/pi-ai';
}

// ============================================================================
// @earendil-works/pi-coding-agent —— 工具工厂（方案 A 核心）
// ============================================================================

declare module '@earendil-works/pi-coding-agent' {
  import type { AgentTool } from '@earendil-works/pi-agent-core';

  export function createBashTool(
    cwd: string,
    options?: {
      operations?: unknown;
      commandPrefix?: string;
      shellPath?: string;
    },
  ): AgentTool;

  export function createReadTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createEditTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createWriteTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createGrepTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createFindTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createLsTool(
    cwd: string,
    options?: {
      operations?: unknown;
    },
  ): AgentTool;

  export function createCodingTools(
    cwd: string,
    options?: Record<string, unknown>,
  ): Record<string, AgentTool>;

  export function createReadOnlyTools(
    cwd: string,
    options?: Record<string, unknown>,
  ): Record<string, AgentTool>;

  export function createAllTools(
    cwd: string,
    options?: Record<string, unknown>,
  ): Record<string, AgentTool>;

  export function generateDiffString(
    original: string,
    modified: string,
  ): {
    readonly unifiedDiff: string;
    readonly stats: { readonly additions: number; readonly deletions: number };
  };

  export function generateUnifiedPatch(
    original: string,
    modified: string,
    filePath: string,
  ): string;

  export interface CreateAgentSessionOptions {
    readonly cwd?: string;
    readonly agentDir?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
  }

  export interface CreateAgentSessionResult {
    readonly session: {
      subscribe(handler: (event: unknown) => void): () => void;
      send(input: string): Promise<void>;
      abort(): void;
      readonly state: unknown;
    };
  }

  export function createAgentSession(
    options: CreateAgentSessionOptions,
  ): Promise<CreateAgentSessionResult>;
}

// ============================================================================
// @earendil-works/pi-tui —— 仅声明，不在主进程运行时调用渲染函数
// ============================================================================

declare module '@earendil-works/pi-tui' {
  export class Container {
    constructor(..._args: unknown[]);
  }
  export class Text {
    constructor(..._args: unknown[]);
  }
  export class Box {
    constructor(..._args: unknown[]);
  }
  export class Spacer {
    constructor(..._args: unknown[]);
  }
  export function truncateToWidth(_text: string, _width: number, _ellipsis?: string): string;
  export function hyperlink(_text: string, _url: string): string;
  export function getCapabilities(): Record<string, unknown>;
  export function getImageDimensions(_data: unknown): { width: number; height: number };
  export function imageFallback(_data: unknown): string;
}
