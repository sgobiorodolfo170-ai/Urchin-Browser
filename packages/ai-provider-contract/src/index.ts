/**
 * @urchin/ai-provider-contract · M12 AI Provider 插件契约
 *
 * 依据：契约 A-提供方接口
 *
 * 定义稳定的 Provider 插件契约，使第三方 LLM 提供方能以独立进程加载。
 * API 演进靠版本号协商而非破坏性变更（IP2 决策）。
 */

// 核心 Provider 接口
export type { UrchinAIProvider } from './provider.js';

// 能力声明
export type {
  ProviderManifest,
  ProviderCapability,
  AuthMethod,
  ProviderRateLimit,
} from './manifest.js';
export { hasCapability, validateManifest, getManifestValidationError } from './manifest.js';

// 生命周期与上下文
export type { ProviderContext, ProviderConfig, SecretStore, ProviderStorage } from './context.js';

// 错误协议
export { ProviderError, isRetryable, RETRYABLE_ERROR_CODES } from './errors.js';
export type { ProviderErrorCode } from './errors.js';

// 消息类型
export type {
  MessageRole,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  CompletionChunk,
  CompletionFinishReason,
  TokenUsage,
  EmbeddingRequest,
  EmbeddingResponse,
  ToolDefinition,
  ToolCallRequest,
  ToolCall,
  ToolCallResponse,
} from './messages.js';

// 版本常量
export { SUPPORTED_API_VERSIONS, CURRENT_API_VERSION, isSupportedApiVersion } from './version.js';
