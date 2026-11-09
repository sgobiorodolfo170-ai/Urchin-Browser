/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-definitions -- vendored pi 边界的 ambient shim：`any` 是刻意的宽松锚点，`type` 用于联合/条件类型 */
/**
 * vendored pi 的 ambient 类型 shim（`src` 侧正式版）。
 *
 * 背景：`@earendil-works/pi-coding-agent` 等包是 vendored 依赖——`node_modules` 里没有实体，
 * 构建期由 `scripts/build-pi-web.mjs` 的 `alias` 指向 `vendor/pi/packages/<pkg>/src`。因此 `tsc`
 * 找不到任何 `.d.ts`（vendor 侧 `package.json` 的 `types` 指向未构建的 `dist/index.d.ts`）。
 *
 * 为什么不用 `paths` 指向 vendor 源码：上游用 `.ts` 后缀导入（需 `allowImportingTsExtensions`）、
 * 自带一套 strict 配置，与本项目 `tsconfig.base.json` 不兼容（详见 `src/pi-shims.d.ts` 同款说明）。
 *
 * 与 `src/pi-shims.d.ts` 的分工：
 * - `src/pi-shims.d.ts` 是 legacy 时期的最小宽签名（`any`），承担 `agent-bridge.ts` 的四个工具工厂；
 * - 本文件按包拆分，为 `src/pi-server` 提供**按 vendor 源码核对过的精确形状**，
 *   逐批补全（见 docs/pi-server-typecheck-清单-2026-11-09.md 的 B1–B3）。
 * 两者是合并关系（`declare module` 声明合并），互不覆盖。
 *
 * 形状来源（逐字核对，勿凭记忆改）：
 * - `vendor/pi/packages/coding-agent/src/core/model-runtime.ts:759` `completeSimple`
 * - `vendor/pi/packages/ai/src/types.ts`（`AssistantMessage` / `Context` / `Model` / 内容块）
 *
 * 只声明类型，不改变任何运行时行为（运行时由 esbuild 打真实 vendor 源码）。
 */
declare module '@earendil-works/pi-coding-agent' {
  /** `vendor/pi/packages/ai/src/types.ts:482` */
  export type StopReason =
    'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';

  /** 助手消息内容块（`types.ts:422` / `:428` / `:444`）。 */
  export interface TextContent {
    type: 'text';
    text: string;
    textSignature?: string;
  }

  export interface ThinkingContent {
    type: 'thinking';
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
  }

  export interface ToolCallContent {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
    namespace?: string;
    argumentsError?: string;
  }

  export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

  /** 用户消息内容块（`types.ts:438` 的 `ImageContent` + `TextContent`）。 */
  export interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
  }

  /** `types.ts:572` */
  export interface UserMessage {
    role: 'user';
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
  }

  /** `types.ts:578`：只建模本项目实际读取的字段，其余由调用方按需扩展。 */
  export interface AssistantMessage {
    role: 'assistant';
    content: AssistantContent[];
    stopReason: StopReason;
    errorMessage?: string;
    model?: string;
    provider?: string;
    timestamp?: number;
    [key: string]: unknown;
  }

  /** `types.ts:554` */
  export interface SystemMessage {
    role: 'system';
    content: string | TextContent[];
    sections?: Record<string, string | null>;
    toolsAdded?: Tool[];
    toolsRemoved?: { name: string }[];
    timestamp: number;
  }

  /** `types.ts:633`（`JsonRepresentation` 简化成 `unknown`，不影响调用方） */
  export interface ToolResultMessage {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: unknown;
    usage?: unknown;
    isError: boolean;
    timestamp: number;
    durationMs?: number;
  }

  /** `types.ts:652` */
  export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

  /** `types.ts:762`：`parameters` 是 typebox `TSchema`，这里退化成 `unknown` 以免把 typebox 拉进 shim。 */
  export interface Tool {
    name: string;
    description: string;
    parameters: unknown;
  }

  /** `types.ts:779`：`completeSimple` 的第二参。 */
  export interface Context {
    systemPrompt?: string;
    messages: Message[];
    tools?: Tool[];
  }

  /** `types.ts:847`（`BaseModel` 子集）：本项目只用到 id / 名称 / API / 能力字段。 */
  export interface Model {
    id: string;
    provider: string;
    /** provider API 标识（model-admin 的模型表按它分组）。 */
    api: string;
    name: string;
    reasoning: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    [key: string]: unknown;
  }

  /** `ModelRuntime.getProviders()` 的元素（model-admin 读取 `auth` / `baseUrl`）。 */
  export interface ModelProvider {
    id: string;
    name: string;
    baseUrl?: string;
    auth: {
      apiKey?: unknown;
      oauth?: { name?: string; [key: string]: any } | undefined;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  /**
   * `ModelRuntime.completeSimple`——D8 的根因就在这里：
   * 旧 shim 只有一个 `[key: string]: any` 索引签名，于是返回值是 `any`，
   * `msg.content.filter((b) => …)` 的 `b` 失去全部编译期保护。
   */
  export interface ModelRuntime {
    completeSimple(
      model: Model,
      context: Context,
      options?: { signal?: AbortSignal; maxTokens?: number; [key: string]: unknown },
    ): Promise<AssistantMessage>;

    // ---- 目录读取（model-admin / 设置页 / 视觉桥使用）----
    getProviders(): ModelProvider[];
    getProvider(providerId: string): ModelProvider | undefined;
    getModels(providerId: string): Model[];
    getModel(providerId: string, modelId: string): Model | undefined;
    getAvailable(...args: any[]): Promise<Model[]>;
    hasConfiguredAuth(providerId: string): boolean;
    isUsingOAuth(providerId: string): boolean;
    refresh(options?: {
      allowNetwork?: boolean;
      force?: boolean;
      signal?: AbortSignal;
      [key: string]: unknown;
    }): Promise<{ errors: Map<string, Error>; [key: string]: unknown }>;
    dispose(): void;
  }

  // ==========================================================================
  // 工具定义与工具工厂（`core/extensions/types.ts` / `core/tools/*`）
  // ==========================================================================

  /** `agent/src/types.ts:424`（`@earendil-works/pi-agent-core`，由 coding-agent 再导出） */
  export interface AgentToolResult<TDetails = unknown> {
    content: (TextContent | ImageContent)[];
    details?: TDetails;
    isError?: boolean;
    [key: string]: unknown;
  }

  /** `agent/src/types.ts:463` */
  export type AgentToolUpdateCallback<TDetails = unknown> = (
    partialResult: AgentToolResult<TDetails>,
  ) => void;

  /**
   * `core/extensions/types.ts` 的 `ExtensionToolContext` 子集。
   *
   * `tools` / `executeTool` 声明为可选：本项目 src 侧从不访问这两个成员，而上游
   * `tests/pi-server/{tool-guards,context-evidence}.test.ts` 习惯把 `{}` 直接当 ctx
   * 传入（共 30 处）。把它们设成必填只会强迫测试改 30 个调用点，收益为零；
   * 其余成员按需访问（索引签名）。
   */
  export interface ExtensionToolContext {
    readonly tools?: readonly unknown[];
    executeTool?(name: string, args: unknown, options?: unknown): Promise<unknown>;
    [key: string]: any;
  }

  /**
   * `core/extensions/types.ts:579`。
   *
   * `TParams` 默认 `any`：真实签名是 `TParams extends TSchema`（typebox schema）。
   * 把 typebox 整套泛型拉进 shim 得不偿失——这里的唯一用途是给
   * `defineTool({ ... })` 的对象字面量提供上下文类型（`execute` 五个参数），
   * 参数形状仍由各工具自己的 typebox schema 描述。
   */
  export interface ToolDefinition<TParams = any, TDetails = unknown, TState = any> {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    /** TypeBox schema。`Static<TParams>` 决定 `execute` 的 `params` 形状。 */
    parameters?: TParams;
    prepareArguments?: (args: unknown) => import('typebox').Static<TParams>;
    executionMode?: 'sequential' | 'parallel';
    exposure?: string;
    namespace?: { name?: string; [key: string]: any };
    defaultActive?: boolean;
    execute(
      toolCallId: string,
      params: import('typebox').Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<TDetails>>;
    /** 仅用于消费泛型参数（与真实 SDK 的泛型形参对齐），运行时不存在。 */
    readonly __genericParams?: [TParams, TDetails, TState];
  }

  /** `core/agent-session.ts:1514` 的 `ToolInfo`（`getAllTools()` 的元素）。 */
  export interface ToolInfo {
    name: string;
    description?: string;
    parameters?: unknown;
    promptGuidelines?: string[];
    exposure?: string;
    namespace?: { name?: string; [key: string]: any };
    annotations?: Record<string, unknown>;
    [key: string]: unknown;
  }

  /** `core/extensions/types.ts:690` */
  export function defineTool<TParams = any, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails, TState>;

  /** `core/tools/bash.ts:75` */
  export interface BashOperations {
    exec(
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number | null }>;
  }

  /** `core/tools/read.ts:48` */
  export interface ReadOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    access: (absolutePath: string) => Promise<void>;
    detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
  }

  /** `core/tools/write.ts:27` */
  export interface WriteOperations {
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    mkdir: (dir: string) => Promise<void>;
  }

  /** `core/tools/edit.ts:83` */
  export interface EditOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    access: (absolutePath: string) => Promise<void>;
  }

  /** `core/tools/ls.ts:34` */
  export interface LsOperations {
    exists: (absolutePath: string) => Promise<boolean> | boolean;
    stat: (
      absolutePath: string,
    ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
    readdir: (absolutePath: string) => Promise<string[]> | string[];
  }

  /** `core/tools/find.ts:52` */
  export interface FindOperations {
    exists: (absolutePath: string) => Promise<boolean> | boolean;
    glob: (
      pattern: string,
      cwd: string,
      options: { ignore: string[]; limit: number },
    ) => Promise<string[]> | string[];
  }

  /** `core/tools/grep.ts:53` */
  export interface GrepOperations {
    isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
    readFile: (absolutePath: string) => Promise<string> | string;
  }

  /** `core/tools/bash.ts:174` */
  export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations;

  export function createBashToolDefinition(
    cwd: string,
    options?: { operations?: BashOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createReadToolDefinition(
    cwd: string,
    options?: { operations?: ReadOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createWriteToolDefinition(
    cwd: string,
    options?: { operations?: WriteOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createEditToolDefinition(
    cwd: string,
    options?: { operations?: EditOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createLsToolDefinition(
    cwd: string,
    options?: { operations?: LsOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createFindToolDefinition(
    cwd: string,
    options?: { operations?: FindOperations; [key: string]: unknown },
  ): ToolDefinition;

  export function createGrepToolDefinition(
    cwd: string,
    options?: { operations?: GrepOperations; [key: string]: unknown },
  ): ToolDefinition;

  /** `core/tools/edit-diff.ts:365` */
  export function generateUnifiedPatch(
    path: string,
    oldContent: string,
    newContent: string,
    contextLines?: number,
  ): string;

  /** `core/tools/edit-diff.ts:376` */
  export function generateDiffString(
    oldContent: string,
    newContent: string,
    contextLines?: number,
  ): { diff: string; firstChangedLine: number | undefined };

  /** `core/tools/file-mutation-queue.ts` */
  export function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T>;

  // ==========================================================================
  // 会话消息与会话对象（`types.ts` / `core/agent-session.ts`）
  // ==========================================================================

  /**
   * 会话转录里的内容块。
   *
   * 与 `AssistantContent` 的区别：这里还包含 `image`，并且每个块都留了
   * `[key: string]: unknown`——上游不同 provider 会往块里塞额外字段，
   * 业务侧按 `type` 判别后读取已知字段即可。
   */
  export interface AgentTextBlock {
    type: 'text';
    text: string;
    [key: string]: unknown;
  }

  export interface AgentThinkingBlock {
    type: 'thinking';
    thinking: string;
    [key: string]: unknown;
  }

  export interface AgentToolCallBlock {
    type: 'toolCall';
    id: string;
    name: string;
    arguments?: unknown;
    [key: string]: unknown;
  }

  export interface AgentImageBlock {
    type: 'image';
    data?: string;
    mimeType?: string;
    source?: { type?: string; data?: string; mediaType?: string; url?: string } | null;
    [key: string]: unknown;
  }

  export type AgentContentBlock =
    AgentTextBlock | AgentThinkingBlock | AgentToolCallBlock | AgentImageBlock;

  /** 会话转录消息（`types.ts` 的 `Message` 加上 bash / custom / summary 等记录型条目）。 */
  export type AgentMessage =
    | {
        role: 'system';
        content: string | AgentContentBlock[];
        timestamp?: number;
        [key: string]: unknown;
      }
    | {
        role: 'user';
        content: string | AgentContentBlock[];
        timestamp?: number;
        [key: string]: unknown;
      }
    | {
        role: 'assistant';
        content: AgentContentBlock[];
        timestamp?: number;
        model?: string;
        provider?: string;
        /** `types.ts` 的 `Usage`：上下文统计页按 input / output / totalTokens 分摊。 */
        usage?: {
          input?: number;
          output?: number;
          totalTokens?: number;
          cost?: { total?: number; [key: string]: unknown } | null;
          [key: string]: unknown;
        } | null;
        stopReason?: string;
        errorMessage?: string;
        [key: string]: unknown;
      }
    | {
        role: 'toolResult';
        content: AgentContentBlock[];
        toolCallId: string;
        toolName: string;
        isError?: boolean;
        details?: unknown;
        timestamp?: number;
        [key: string]: unknown;
      }
    | {
        role: 'bashExecution';
        output: string;
        command?: string;
        exitCode?: number;
        cancelled?: boolean;
        timestamp?: number;
        [key: string]: unknown;
      }
    | {
        role: 'custom';
        content: string | AgentContentBlock[];
        timestamp?: number;
        customType?: string;
        [key: string]: unknown;
      }
    | { role: 'branchSummary'; summary: any; timestamp?: number; [key: string]: unknown }
    | {
        role: 'compactionSummary';
        summary: any;
        tokensBefore?: any;
        timestamp?: number;
        [key: string]: unknown;
      };

  /**
   * `core/agent-session.ts:196` 的事件联合。
   *
   * 上游有 20+ 个带精确载荷的变体；这里只保留「`type` 是字符串 + 载荷自取」的公共形状。
   * 精确建模每个载荷会把整条 extension/event 类型链拉进 shim，收益远小于成本；
   * 事件处理器的参数类型仍由 `ExtensionAPI.on` 提供（不是隐式 any）。
   */
  export type AgentSessionEvent = { type: string; [key: string]: any };

  export interface AgentSession {
    messages: AgentMessage[];
    /** 内部 Agent 实例：`state.messages` 是转录（goal-service 回溯错误结果时读它）。 */
    agent: {
      state: {
        messages: AgentMessage[];
        tools: { name: string; [key: string]: any }[];
        [key: string]: any;
      };
      steeringMode: any;
      followUpMode: any;
      [key: string]: any;
    };
    /** 会话级资源加载器（技能 / 扩展 / AGENTS 文件）。 */
    resourceLoader: ResourceLoader;
    /** 会话级设置与转录存储（`applyOverrides` / `getEntries` 等）。 */
    settingsManager: any;
    sessionManager: SessionManager;
    /** 当前模型与上下文统计（`contextWindowOf` / `modelKeyOf` 读取）。 */
    model?: any;
    setModel(model: any): Promise<void>;
    getSessionStats(): any;
    isStreaming: boolean;
    /** 订阅会话事件，返回取消订阅函数。 */
    subscribe(listener: (event: AgentSessionEvent) => void): () => void;
    bindExtensions(options: any): Promise<void>;
    /** 当前活动工具名（与 `setActiveToolsByName` 配对，供 tool-manager 的 `ActiveToolSet` 使用）。 */
    getActiveToolNames(): string[];
    getAllTools(): ToolInfo[];
    getToolDefinition(name: string): ToolDefinition | undefined;
    setActiveToolsByName(toolNames: string[]): void;
    sendUserMessage(
      content: string | (TextContent | ImageContent)[],
      options?: { deliverAs?: 'steer' | 'followUp'; expandPromptTemplates?: boolean },
    ): Promise<void>;
    sendCustomMessage(
      message: {
        customType: string;
        content?: string | (TextContent | ImageContent)[];
        display?: boolean;
        details?: unknown;
        [key: string]: unknown;
      },
      options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
    ): Promise<void>;
    /** 其余成员（model / settingsManager / sessionManager / abort …）由真实 SDK 提供。 */
    [key: string]: any;
  }

  /** `core/agent-session.ts` 的 `SessionEntry`；形状按本项目读取方式最小化。 */
  export interface SessionEntry {
    type: string;
    id: string;
    parentId?: string | null;
    timestamp?: string | number;
    customType?: string;
    /** context_edit 记录的目标条目（源码在 type === "context_edit" 分支读取） */
    targetId: string;
    replacement?: unknown;
    /** compaction 条目（type === "compaction"）读取的两个字段。 */
    summary?: any;
    tokensBefore?: any;
    message: {
      role: string;
      content: any[];
      toolCallId?: string;
      customType?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  /** `core/agent-session-services.ts:25` 附近的会话列表条目（session-parser / session-search 使用）。 */
  export interface SessionInfo {
    path: string;
    id: string;
    cwd: string;
    name?: string;
    parentSessionPath?: string;
    created: Date;
    modified: Date;
    messageCount: number;
    firstMessage: string;
    allMessagesText?: string;
  }

  /** `core/session-manager.ts` */
  export interface SessionManager {
    getSessionDir(): string;
    getSessionFile(): string | undefined;
    setSessionFile(path: string): void;
    newSession(options?: NewSessionOptions): string | undefined;
    getSessionId(): string;
    getCwd(): string;
    getLeafId(): string | null;
    getEntry(id: string): SessionEntry | undefined;
    getBranch(leafId?: string): SessionEntry[];
    createBranchedSession(leafId: string): string | undefined;
    getEntries(): SessionEntry[];
    getHeader(): SessionHeader | null;
    buildSessionProjection(): { messages: AgentMessage[]; [key: string]: unknown };
    buildSessionContext(): { messages: AgentMessage[]; [key: string]: unknown };
    isPersisted(): boolean;
    appendMessage(message: unknown): SessionEntry;
    appendSessionInfo(name: string): void;
    appendCustomEntry(customType: string, data?: unknown): SessionEntry;
    appendContextEdit(targetId: string, replacement: unknown): SessionEntry;
    buildContextEntries(): SessionEntry[];
    branch(id: string): void;
    [key: string]: any;
  }

  /** `new SessionManager(...)` / `create()` 的选项（本项目只用到 `parentSession`）。 */
  export interface NewSessionOptions {
    id?: string;
    parentSession?: string;
    [key: string]: unknown;
  }

  /** 会话头（`session-manager.ts` 的 `SessionHeader`）。 */
  export interface SessionHeader {
    type?: 'session';
    cwd?: string;
    id?: string;
    version?: number;
    timestamp?: string;
    [key: string]: unknown;
  }

  export type SessionListProgress = (
    loaded: number,
    total: number,
    sessions?: SessionInfo[],
  ) => void;

  export const SessionManager: {
    create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;
    open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;
    continueRecent(cwd: string, sessionDir?: string): SessionManager;
    inMemory(cwd?: string, options?: NewSessionOptions, entries?: unknown[]): SessionManager;
    findById(id: string, sessionDir?: string): SessionManager | undefined;
    list(
      cwd: string,
      sessionDir?: string,
      onProgress?: SessionListProgress,
      signal?: AbortSignal,
    ): Promise<SessionInfo[]>;
    listAll(
      sessionDirOrOnProgress?: string | SessionListProgress,
      onProgressOrSignal?: SessionListProgress | AbortSignal,
      signal?: AbortSignal,
    ): Promise<SessionInfo[]>;
    new (
      cwd: string,
      sessionDir: string,
      sessionFile?: string,
      persist?: boolean,
      newSessionOptions?: NewSessionOptions,
      preloadedFileEntries?: unknown[],
    ): SessionManager;
  };

  /** `core/compaction/compaction.ts:298` */
  export function estimateTokens(message: AgentMessage): number;

  /** `core/compaction/compaction.ts:126` */
  export const DEFAULT_COMPACTION_SETTINGS: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    [key: string]: unknown;
  };

  // ==========================================================================
  // 会话运行时与装配（`core/agent-session-runtime.ts` / `core/agent-session-services.ts`）
  // ==========================================================================

  /** `core/agent-session-services.ts:2719` */
  export interface AgentSessionServices {
    cwd: string;
    agentDir: string;
    modelRuntime: ModelRuntime;
    settingsManager: SettingsManager;
    resourceLoader: ResourceLoader;
    diagnostics: AgentSessionRuntimeDiagnostic[];
  }

  export interface AgentSessionRuntimeDiagnostic {
    type: 'error' | 'warning' | 'info';
    message: string;
    [key: string]: unknown;
  }

  /** `core/resource-loader.ts` 里本项目实际读取的集合（skills / extensions / agents 文件）。 */
  export interface LoadedSkill {
    name: string;
    description: string;
    [key: string]: unknown;
  }

  export interface LoadedExtension {
    path: string;
    hidden?: boolean;
    sourceInfo?: { origin?: string; source?: string; path?: string; [key: string]: unknown };
    [key: string]: unknown;
  }

  export interface ResourceLoader {
    getSkills(): { skills: LoadedSkill[]; [key: string]: unknown };
    getExtensions(): { extensions: LoadedExtension[]; [key: string]: unknown };
    getAgentsFiles(): {
      agentsFiles: { path: string; content: string; [key: string]: unknown }[];
      [key: string]: unknown;
    };
    [key: string]: any;
  }

  /**
   * `createAgentSessionServices({ resourceLoaderOptions })` 的覆盖回调。
   *
   * 这几个回调的**参数**形状决定了业务侧 callback 是否有上下文类型
   * （例如 `skillsOverride: (res) => …` 里的 `res.skills`）。
   */
  export interface ResourceLoaderOptions {
    systemPromptOverride?: (base: string) => string | undefined;
    appendSystemPromptOverride?: (lines: string[]) => string[];
    skillsOverride?: (current: { skills: LoadedSkill[]; [key: string]: unknown }) => {
      skills: LoadedSkill[];
      [key: string]: unknown;
    };
    extensionsOverride?: (current: { extensions: LoadedExtension[]; [key: string]: unknown }) => {
      extensions: LoadedExtension[];
      [key: string]: unknown;
    };
    promptsOverride?: (current: any) => any;
    themesOverride?: (current: any) => any;
    /** 扩展工厂列表：`{ name, hidden, factory(pi) }`，也允许直接传工厂函数。 */
    extensionFactories?: (
      | ExtensionFactory
      | { name?: string; hidden?: boolean; factory: ExtensionFactory; [key: string]: any }
    )[];
    disabledBuiltinExtensions?: string[];
    [key: string]: any;
  }

  /** `core/agent-session-runtime.ts:2543` */
  export class AgentSessionRuntime {
    constructor(
      session: AgentSession,
      services: AgentSessionServices,
      createRuntime: CreateAgentSessionRuntimeFactory,
      diagnostics?: AgentSessionRuntimeDiagnostic[],
      modelFallbackMessage?: string,
    );
    readonly services: AgentSessionServices;
    readonly session: AgentSession;
    readonly cwd: string;
    readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
    readonly modelFallbackMessage: string | undefined;
    setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
    [key: string]: any;
  }

  /** `core/agent-session-runtime.ts:35` */
  export type CreateAgentSessionRuntimeFactory = (options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    [key: string]: unknown;
  }) => Promise<unknown>;

  /** `core/agent-session-runtime.ts` */
  export function createAgentSessionRuntime(
    createRuntime: CreateAgentSessionRuntimeFactory,
    options: {
      cwd: string;
      agentDir?: string;
      sessionManager?: SessionManager;
      [key: string]: unknown;
    },
  ): Promise<AgentSessionRuntime>;

  /** `core/agent-session-services.ts:135` */
  export function createAgentSessionServices(options: {
    cwd: string;
    agentDir?: string;
    modelRuntime?: ModelRuntime;
    settingsManager?: SettingsManager;
    resourceLoaderOptions?: ResourceLoaderOptions;
    [key: string]: unknown;
  }): Promise<AgentSessionServices>;

  /** `core/agent-session-services.ts:214` */
  export function createAgentSessionFromServices(options: {
    services: AgentSessionServices;
    sessionManager: SessionManager;
    [key: string]: unknown;
  }): Promise<{ session: AgentSession; [key: string]: unknown }>;

  // ==========================================================================
  // 设置 / 包管理 / 技能（`core/settings-manager.ts` 等）
  // ==========================================================================

  /** `core/settings-manager.ts:272` */
  export class SettingsManager {
    static create(cwd: string, agentDir?: string): SettingsManager;
    [key: string]: any;
  }

  /** `core/package-manager.ts` 的 `ResolvedResource`（路径 + 是否启用）。 */
  export interface ResolvedResource {
    path: string;
    enabled: boolean;
    metadata?: unknown;
    [key: string]: unknown;
  }

  export interface ResolvedPaths {
    extensions: ResolvedResource[];
    skills: ResolvedResource[];
    prompts: ResolvedResource[];
    themes: ResolvedResource[];
  }

  export type MissingSourceAction = 'install' | 'skip' | 'error';

  /** `core/package-manager.ts:818` */
  export class DefaultPackageManager {
    constructor(options: {
      cwd: string;
      agentDir: string;
      settingsManager: SettingsManager;
      [key: string]: unknown;
    });
    resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
    [key: string]: any;
  }

  /** `core/skills.ts:414` */
  export function loadSkills(options: {
    cwd: string;
    agentDir: string;
    skillPaths: string[];
    includeDefaults: boolean;
  }): {
    skills: { name: string; description?: string; filePath?: string; [key: string]: unknown }[];
    diagnostics?: unknown[];
  };

  // ==========================================================================
  // 扩展（`core/extensions/types.ts`）
  // ==========================================================================

  /** `core/extensions/types.ts:114` */
  export interface ExtensionUIDialogOptions {
    signal?: AbortSignal;
    timeout?: number;
  }

  export type WidgetPlacement = 'aboveEditor' | 'belowEditor';

  /**
   * `core/extensions/types.ts:149`。
   *
   * 只建模本项目实现处（`webui-context.ts`）用到的成员：`setWidget` 的
   * `content` 联合类型决定了实现端能否安全地把 `string[]` 直接交给渲染器；
   * 其余成员通过索引签名放行（由真实 SDK 定义，不会因此放宽业务代码）。
   */
  export interface ExtensionUIContext {
    theme: Theme;
    setWidget(
      key: string,
      content?: string[] | ((tui: any, theme: Theme) => unknown),
      options?: { placement?: WidgetPlacement },
    ): void;
    select(
      title: string,
      options: string[],
      opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined>;
    confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
    input(
      title: string,
      placeholder?: string,
      opts?: ExtensionUIDialogOptions,
    ): Promise<string | undefined>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    setStatus(key: string, text: string | undefined): void;
    [key: string]: any;
  }

  /** `core/extensions/types.ts:1592` */
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    registerTool(tool: ToolDefinition): void;
    getAllTools(): ToolInfo[];
    getActiveTools(): string[];
    getActiveToolsByName?(): string[];
    [key: string]: any;
  }

  /** 扩展工厂：`createCodemodeExtension()` / `createToolSearchExtension()` 的返回类型。 */
  export type ExtensionFactory = (pi: ExtensionAPI) => void;

  /** `core/extensions/types.ts` 的 `ExtensionError`（携带扩展来源路径）。 */
  export interface ExtensionError extends Error {
    extensionPath?: string;
    [key: string]: any;
  }

  /** `extensions/codemode/index.ts:32` */
  export function createCodemodeExtension(options?: Record<string, any>): ExtensionFactory;

  /** `extensions/tool-search/index.ts:12` */
  export function createToolSearchExtension(): ExtensionFactory;

  // ==========================================================================
  // 主题与模型作用域
  // ==========================================================================

  /**
   * 交互主题对象（颜色/样式函数集合）。
   *
   * 本项目只把它当不透明值传递（`mockThemeProxy` 用 `as unknown as Theme` 铸造，
   * `webui-context` 读取 `.name`），因此留索引签名而不逐一建模上百个颜色方法。
   */
  export interface Theme {
    name?: string;
    [key: string]: any;
  }

  /** `modes/interactive/theme/theme.ts:682` */
  export function initTheme(themeName?: string, enableWatcher?: boolean): void;

  /** `core/model-resolver.ts:403` */
  export function resolveModelScopeWithDiagnostics(
    patterns: string[],
    modelRuntime: ModelRuntime,
    options?: unknown,
  ): Promise<{
    scopedModels: { model: Model; thinkingLevel?: string; [key: string]: unknown }[];
    diagnostics: unknown[];
  }>;

  // ==========================================================================
  // 版本与目录
  // ==========================================================================

  /** `config.ts:582` */
  export const VERSION: string;

  /** `config.ts:605` */
  export function getAgentDir(): string;
}
