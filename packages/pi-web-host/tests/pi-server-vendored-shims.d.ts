/* eslint-disable @typescript-eslint/no-explicit-any -- vendored pi 边界 ambient shim，宽松类型合并 */
/**
 * 测试侧 ambient 声明补充（仅类型，不影响运行时）。
 *
 * 背景：`src/pi-server/serialize.ts`、`context-budget.ts`、`context-usage.ts`、
 * `session-branch.ts`、`soft-cap.ts` 从 `@earendil-works/pi-coding-agent` 取
 * `AgentSession` / `estimateTokens` / `SessionEntry` / `DEFAULT_COMPACTION_SETTINGS`。
 * 该包是 vendored 依赖（构建期由 esbuild 别名解析），仓库内既无 node_modules
 * 实体也无完整 ambient 声明。
 *
 * `src/pi-server/**` 本被 tsconfig `exclude` 排除，但只要测试 import 其中任一
 * 模块，tsc 就会连带检查被引用的文件，缺少导出即报 TS2305，并让类型退化成
 * error 类型（eslint 会连锁报 no-unsafe-* / no-unnecessary-type-assertion）。
 *
 * 这里只补齐测试实际触达的导出，形状按源码用法最小化：
 * - `AgentMessage` 用真实 SDK 的 role/content 判别式结构，保证 `content.map(...)`
 *   的回调参数有上下文类型（否则 TS7006）；
 * - `SessionEntry` / `estimateTokens` 用宽松签名（这两个模块本身只做透传，
 *   收紧类型反而会与 `Record<string, unknown>` 的调用方冲突）。
 *
 * 不改变任何运行时行为；待 `src/pi-shims.d.ts` 补齐同名导出后可删除。
 */
declare module '@earendil-works/pi-coding-agent' {
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
        usage?: { cost?: { total?: number } } | null;
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
    | { role: 'branchSummary'; summary: string; timestamp?: number; [key: string]: unknown }
    | { role: 'compactionSummary'; summary: string; timestamp?: number; [key: string]: unknown };

  export interface AgentSession {
    messages: AgentMessage[];
    /**
     * 其余成员（sendCustomMessage / modelRuntime / sessionManager …）由真实 SDK
     * 提供，这里不逐一建模；用具名 any 索引签名保持"可访问但不再约束"，
     * 否则 `Parameters<AgentSession["sendCustomMessage"]>` 这类取型会退化成 unknown。
     */
    [key: string]: any;
  }

  /**
   * 注：`SessionEntry` 由同目录其他测试侧 shim（session-pipeline-shims.d.ts）声明，
   * 这里不重复声明，避免两个声明合并后把可选字段收紧成必填。
   */

  /** 与真实 SDK 一致的字符数估算入口（按消息整体估算 token）。 */
  export function estimateTokens(message: any): number;

  export const DEFAULT_COMPACTION_SETTINGS: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}
