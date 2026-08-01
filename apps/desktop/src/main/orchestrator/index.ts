/**
 * M11 AI Orchestrator · 模块入口
 *
 * 依据：04-模块全景 M11 v0.1
 *
 * 公开 Orchestrator 核心 API、Provider 注册表与生产环境工厂。
 */
export { Orchestrator } from './orchestrator';
export type { OrchestratorOptions, TimerProvider } from './orchestrator';
export { TokenBucket } from './token-bucket';
export type { TimeProvider, SleepProvider } from './token-bucket';
export { ProviderRegistry } from './provider-registry';
export type { ProviderRegistration, SerializedManifest } from './provider-registry';
export { electronProcessFactory } from './electron-factory';
export { callWithRetry, computeBackoff, MAX_RETRIES, BACKOFF_BASE_MS } from './retry';
export type { SleepFn } from './retry';
export { startStream } from './stream';
export type { StreamHandle, RendererToOrchMessage } from './stream';
export type {
  ITokenBucket,
  IMessagePort,
  IUtilityProcess,
  IMessageChannel,
  ProviderHost,
  ProviderHostState,
  ProviderStats,
  ProviderToOrchMessage,
  OrchToProviderMessage,
  UtilityProcessFactory,
  OrchestratorEvents,
} from './types';
