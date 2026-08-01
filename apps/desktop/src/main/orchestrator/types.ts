/**
 * M11 AI Orchestrator · 类型定义
 *
 * 依据：契约 I §2 / OR1-OR9 决策
 *
 * 职责：定义 Orchestrator 的核心类型抽象，便于单元测试解耦 Electron 原生依赖。
 *
 * 设计要点：
 * - IUtilityProcessFactory：抽象 utilityProcess.fork，便于测试注入 mock
 * - IMessagePort：抽象 MessagePortMain，便于测试 mock 双向通信
 * - ProviderHost：单个 Provider 子进程的运行时状态
 */
import type { ProviderManifest, TokenUsage } from '@urchin/ai-provider-contract';

/** Provider 子进程运行时状态 */
export type ProviderHostState =
  | 'initializing' // 子进程已 fork，等待 handshake
  | 'ready' // 心跳正常，可接受调用
  | 'crashed' // 心跳超时或异常退出，待重建
  | 'disposed'; // 已主动释放

/** Provider 子进程心跳统计 */
export interface ProviderStats {
  readonly activeStreams: number;
  readonly totalRequests: number;
}

/**
 * Provider Child → Orchestrator 消息。
 *
 * M17 token 直通：stream.end 消息携带 usage 字段，
 * 由 Orchestrator 透传给 Renderer 用于显示 token 用量。
 */
export type ProviderToOrchMessage =
  | { readonly kind: 'ready'; readonly manifest: ProviderManifest }
  | {
      readonly kind: 'heartbeat';
      readonly timestamp: number;
      readonly stats: ProviderStats;
    }
  | {
      readonly kind: 'complete.response';
      readonly conversationId?: string;
      readonly response: unknown;
    }
  | {
      readonly kind: 'stream.chunk';
      readonly conversationId?: string;
      readonly chunk: unknown;
    }
  | {
      readonly kind: 'stream.end';
      readonly conversationId?: string;
      readonly finishReason: string;
      /** M17 token 直通：流结束时上报 token 用量 */
      readonly usage?: TokenUsage;
    }
  | { readonly kind: 'error'; readonly conversationId?: string; readonly error: unknown };

/** Orchestrator → Provider Child 消息 */
export type OrchToProviderMessage =
  | { readonly kind: 'init'; readonly providerId: string; readonly config: unknown }
  | { readonly kind: 'complete'; readonly conversationId?: string; readonly req: unknown }
  | { readonly kind: 'stream'; readonly conversationId?: string; readonly req: unknown }
  | { readonly kind: 'abort'; readonly conversationId?: string }
  | { readonly kind: 'dispose' };

/**
 * 抽象 MessagePort（参考 Electron MessagePortMain 子集）。
 *
 * 用于解耦 Electron 原生 MessagePortMain，便于测试注入 mock。
 * 实现需要支持 transferred 后的 on/postMessage/start/close。
 *
 * removeListener 用于流结束时精确移除指定 listener（避免累积），
 * 与 Node EventEmitter / Electron MessagePortMain.removeListener 签名一致。
 */
export interface IMessagePort {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  /** 移除指定事件上的指定 listener（用于流结束清理） */
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  start(): void;
  close(): void;
}

/**
 * 抽象 utilityProcess.fork 的产物（参考 Electron.UtilityProcess 子集）。
 *
 * 注意：on() 用单一签名（事件名 + 通用 listener），
 * 实现端负责按事件名分发到具体的 listener 类型。
 */
export interface IUtilityProcess {
  readonly pid?: number;
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  on(event: 'exit' | 'message', listener: (arg: unknown) => void): this;
  /** 移除指定事件上的指定 listener（用于 disposeHost 清理） */
  removeListener(event: 'exit' | 'message', listener: (arg: unknown) => void): this;
  kill(): boolean;
}

/**
 * 抽象 MessageChannelMain 的两端。
 */
export interface IMessageChannel {
  readonly port1: IMessagePort;
  readonly port2: IMessagePort;
}

/**
 * Utility 进程工厂函数类型，用于解耦 Electron utilityProcess.fork。
 *
 * 实现需要：
 * 1. fork 出一个 IUtilityProcess
 * 2. 创建一对 MessageChannel，把 port2 transferred 给子进程
 * 3. 返回 { process, port }，port 是 port1（留给 Orchestrator）
 */
export type UtilityProcessFactory = (options: {
  readonly providerId: string;
  readonly serviceModulePath: string;
}) => { readonly process: IUtilityProcess; readonly port: IMessagePort };

/**
 * Provider Host 运行时句柄（契约 I §2）。
 *
 * 注意：manifest 字段在 ready 消息到达前用临时数据，ready 后会被替换。
 */
export interface ProviderHost {
  readonly providerId: string;
  /** 临时 manifest；收到 child 上报的 ready 后被替换为真实 manifest */
  manifest: ProviderManifest;
  readonly process: IUtilityProcess;
  readonly port: IMessagePort;
  lastHeartbeat: number;
  state: ProviderHostState;
  readonly rateLimiter: ITokenBucket;
  heartbeatChecker?: ReturnType<typeof setInterval>;
  idleRecycler?: ReturnType<typeof setTimeout>;
  /** proc.on('exit') 的 listener，disposeHost 时显式移除（避免 listener 累积） */
  exitListener?: (code: unknown) => void;
}

/**
 * 令牌桶接口（OR4 决策）。
 *
 * 每分钟容量上限按 manifest.rateLimit.requestsPerMin 自报，
 * 可选 tokensPerMin 用于 token 级限速。
 */
export interface ITokenBucket {
  /** 取 1 个请求 token，无可用则阻塞等待 */
  acquireRequestToken(): Promise<void>;
  /** 当前可用 token 数（用于测试） */
  readonly availableTokens: number;
}

/** Orchestrator 事件回调 */
export interface OrchestratorEvents {
  /** Provider 状态变更 */
  onProviderStateChanged?(providerId: string, state: ProviderHostState): void;
  /** Provider 崩溃 */
  onProviderCrashed?(providerId: string, reason: string): void;
}
