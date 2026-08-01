/**
 * M12 Provider Contract · Provider 核心接口
 *
 * 依据：契约 A §2
 *
 * 这是第三方 LLM 提供方必须实现的接口。
 * Provider 以独立子进程加载，crash 不影响主浏览器。
 *
 * 关键设计：
 * - 流式用 AsyncIterable（IP1 决策）：背压自然、跨进程转译不需新协议层
 * - embed 与 tools 是可选能力，由 manifest.capabilities 声明
 * - initialize 时收到 ProviderContext，包含 secrets/storage/abort/log
 */

import type { ProviderManifest } from './manifest.js';
import type { ProviderContext } from './context.js';
import type {
  CompletionRequest,
  CompletionResponse,
  CompletionChunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ToolCallRequest,
  ToolCallResponse,
} from './messages.js';

/**
 * Urchin AI Provider 插件接口。
 *
 * 第三方 Provider 实现此类并通过 ESM 导出。
 * 命名导出 `UrchinAIProvider` 或 default 导出均可。
 */
export interface UrchinAIProvider {
  /** 元数据：能力声明、版本、id */
  readonly manifest: ProviderManifest;

  /** 生命周期：初始化（接收上下文） */
  initialize(ctx: ProviderContext): Promise<void>;

  /** 生命周期：释放资源 */
  dispose(): Promise<void>;

  /** 核心调用：非流式补全 */
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /** 核心调用：流式补全（AsyncIterator）— IP1 决策 */
  stream(req: CompletionRequest): AsyncIterable<CompletionChunk>;

  /** 可选：embedding 向量化（v0.2+ 用） */
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** 可选：工具调用（function calling） */
  tools?(req: ToolCallRequest): Promise<ToolCallResponse>;
}
