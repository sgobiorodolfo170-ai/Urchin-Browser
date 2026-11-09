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

  /** `types.ts:847`（`BaseModel` 子集）：本项目只用到 id / 名称 / 输入能力。 */
  export interface Model {
    id: string;
    provider: string;
    name?: string;
    input?: string[];
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
  }
}
