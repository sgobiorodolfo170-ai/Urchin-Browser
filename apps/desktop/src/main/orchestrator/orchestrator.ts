/**
 * M11 AI Orchestrator · 核心
 *
 * 依据：契约 I §2 / OR1-OR7 决策
 *
 * 职责：
 * 1. 管理 ProviderHost 生命周期（按需 spawn / 心跳监控 / 空闲回收 / crash 恢复）
 * 2. 调度用户请求到对应 Provider Child
 * 3. 限流（每 Provider 独立令牌桶，OR4 决策）
 *
 * 设计要点：
 * - OR1：1 主 Orchestrator + N Provider 子进程
 * - OR2：按需 spawn（首次调用时启动）
 * - OR3：5s 心跳 / 15s 超时
 * - OR6：5 分钟空闲回收
 * - OR7：crash 后下次调用时重建
 *
 * 不在本文件实现的职责（W3-D4）：
 * - 流式调用链路（startStream）
 * - 重试策略（callWithRetry，指数退避）
 */
import { createLogger } from '@urchin/logger';
import type { ProviderManifest } from '@urchin/ai-provider-contract';
import type { ProviderRegistry } from './provider-registry';
import { TokenBucket } from './token-bucket';
import type {
  ITokenBucket,
  OrchestratorEvents,
  ProviderHost,
  ProviderHostState,
  ProviderToOrchMessage,
  UtilityProcessFactory,
} from './types';

const log = createLogger('orchestrator');

/** OR3 决策：心跳超时 15s */
const HEARTBEAT_TIMEOUT_MS = 15_000;
/** OR3 决策：心跳检测间隔 5s */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** OR6 决策：空闲回收 5 分钟 */
const IDLE_RECYCLE_MS = 5 * 60_000;
/** Provider 默认速率限制（当 manifest 未声明时） */
const DEFAULT_RATE_LIMIT_RPM = 60;

/** 定时器抽象，便于测试注入 */
export interface TimerProvider {
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMERS: TimerProvider = {
  setInterval: (h, ms) => setInterval(h, ms),
  setTimeout: (h, ms) => setTimeout(h, ms),
  clearInterval: (h) => clearInterval(h),
  clearTimeout: (h) => clearTimeout(h),
};

/**
 * Orchestrator 选项。
 */
export interface OrchestratorOptions {
  readonly registry: ProviderRegistry;
  readonly processFactory: UtilityProcessFactory;
  readonly timers?: TimerProvider;
  readonly events?: OrchestratorEvents;
  /** 创建令牌桶的工厂（可选，便于测试注入 mock） */
  readonly tokenBucketFactory?: (capacityPerMin: number) => ITokenBucket;
  /**
   * 读取 Provider 用户配置（W5-D2）。
   * 返回 null 表示无配置，Orchestrator 会以空对象 {} 注入 init 消息。
   * 默认实现返回 null（向后兼容）。
   */
  readonly configProvider?: (providerId: string) => Promise<unknown>;
  /** 覆盖默认配置（仅测试用） */
  readonly heartbeatTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly idleRecycleMs?: number;
}

/**
 * AI Orchestrator 核心。
 *
 * 管理 N 个 Provider 子进程，按需 spawn、心跳监控、空闲回收、crash 自动恢复。
 * 不直接跑第三方代码，只做调度与限流。
 */
export class Orchestrator {
  private readonly hosts = new Map<string, ProviderHost>();
  private readonly registry: ProviderRegistry;
  private readonly processFactory: UtilityProcessFactory;
  private readonly timers: TimerProvider;
  private readonly events?: OrchestratorEvents;
  private readonly tokenBucketFactory: (capacityPerMin: number) => ITokenBucket;
  private readonly configProvider: (providerId: string) => Promise<unknown>;
  private readonly heartbeatTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly idleRecycleMs: number;

  constructor(options: OrchestratorOptions) {
    this.registry = options.registry;
    this.processFactory = options.processFactory;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.events = options.events;
    this.tokenBucketFactory = options.tokenBucketFactory ?? ((rpm: number) => new TokenBucket(rpm));
    this.configProvider = options.configProvider ?? (() => Promise.resolve(null));
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.idleRecycleMs = options.idleRecycleMs ?? IDLE_RECYCLE_MS;
  }

  /**
   * OR2 决策：按需 spawn。
   * - 已 ready：直接返回，并重置空闲回收计时器
   * - 已 crashed：先 dispose 旧的，再重新 spawn
   * - 不存在：spawn 新的
   */
  async ensureProviderLoaded(providerId: string): Promise<ProviderHost> {
    const existing = this.hosts.get(providerId);
    if (existing) {
      if (existing.state === 'ready') {
        this.resetIdleRecycle(existing);
        return existing;
      }
      if (existing.state === 'crashed' || existing.state === 'disposed') {
        // OR7 决策：crash 后下次调用时重建
        await this.disposeHost(providerId);
      } else if (existing.state === 'initializing') {
        // 并发调用：等待 ready 或超时
        return existing;
      }
    }
    return this.spawnProvider(providerId);
  }

  /**
   * Spawn 一个 Provider 子进程。
   */
  private async spawnProvider(providerId: string): Promise<ProviderHost> {
    const reg = this.registry.get(providerId);
    if (!reg) {
      throw new Error(`Provider "${providerId}" is not registered`);
    }

    log.info('spawning provider', { providerId, entryPath: reg.entryPath });

    const { process: proc, port } = this.processFactory({
      providerId,
      serviceModulePath: reg.entryPath,
    });

    // 临时 manifest（在收到 child 'ready' 前使用注册表数据）
    const manifest: ProviderManifest = {
      id: reg.id,
      name: reg.name,
      version: reg.version,
      apiVersion: reg.apiVersion,
      capabilities: reg.capabilities as ProviderManifest['capabilities'],
      configSchema: {} as never,
      authMethod: reg.authMethod as ProviderManifest['authMethod'],
      rateLimit: reg.rateLimit,
    };

    const rateLimiter = this.tokenBucketFactory(
      reg.rateLimit?.requestsPerMin ?? DEFAULT_RATE_LIMIT_RPM,
    );

    const host: ProviderHost = {
      providerId,
      manifest,
      process: proc,
      port,
      lastHeartbeat: Date.now(),
      state: 'initializing',
      rateLimiter,
    };

    // 监听 child → orchestrator 消息
    port.on('message', (msg) => {
      this.handleProviderMessage(host, msg);
    });
    port.start();

    // OR3 决策：心跳超时检测
    host.heartbeatChecker = this.timers.setInterval(() => {
      const elapsed = Date.now() - host.lastHeartbeat;
      if (elapsed > this.heartbeatTimeoutMs) {
        this.markCrashed(host, `heartbeat timeout (${elapsed}ms)`);
      }
    }, this.heartbeatIntervalMs);

    // OR6 决策：空闲回收
    this.resetIdleRecycle(host);

    // 进程退出监听（保存 listener 引用，disposeHost 时显式移除）
    host.exitListener = (code: unknown) => {
      if (host.state !== 'disposed') {
        this.markCrashed(host, `unexpected exit code=${String(code)}`);
      }
    };
    proc.on('exit', host.exitListener);

    this.hosts.set(providerId, host);

    // W5-D2：读取 per-provider 用户配置（API key 等），注入 init 消息
    const storedConfig = await this.configProvider(providerId);
    const config = storedConfig ?? {};
    port.postMessage({ kind: 'init', providerId, config });

    return host;
  }

  /**
   * 重置空闲回收计时器（每次调用时触发）。
   */
  private resetIdleRecycle(host: ProviderHost): void {
    if (host.idleRecycler !== undefined) {
      this.timers.clearTimeout(host.idleRecycler);
    }
    host.idleRecycler = this.timers.setTimeout(() => {
      if (host.state === 'ready') {
        log.info('provider idle recycled', { providerId: host.providerId });
        void this.disposeHost(host.providerId);
      }
    }, this.idleRecycleMs);
  }

  /**
   * 处理 Provider Child → Orchestrator 消息。
   */
  private handleProviderMessage(host: ProviderHost, raw: unknown): void {
    const msg = raw as ProviderToOrchMessage;
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') {
      log.warn(`Invalid message from provider "${host.providerId}"`, { raw });
      return;
    }

    switch (msg.kind) {
      case 'ready':
        // 收到 ready：用 child 上报的真实 manifest 替换临时数据
        host.manifest = (msg as { manifest: ProviderManifest }).manifest;
        host.state = 'ready';
        host.lastHeartbeat = Date.now();
        this.events?.onProviderStateChanged?.(host.providerId, 'ready');
        log.info('provider ready', {
          providerId: host.providerId,
          capabilities: host.manifest.capabilities,
        });
        break;

      case 'heartbeat':
        host.lastHeartbeat = Date.now();
        break;

      case 'error':
        log.warn(`Provider "${host.providerId}" reported error`, {
          error: (msg as { error: unknown }).error,
        });
        break;

      default:
        // complete.response / stream.chunk / stream.end 由流式调用层处理（W3-D4）
        break;
    }
  }

  /**
   * 标记 Provider 已崩溃。
   */
  private markCrashed(host: ProviderHost, reason: string): void {
    if (host.state === 'disposed' || host.state === 'crashed') return;
    host.state = 'crashed';
    log.warn(`Provider "${host.providerId}" crashed: ${reason}`);
    this.events?.onProviderCrashed?.(host.providerId, reason);
    this.events?.onProviderStateChanged?.(host.providerId, 'crashed');

    // 清理定时器
    if (host.heartbeatChecker !== undefined) {
      this.timers.clearInterval(host.heartbeatChecker);
      host.heartbeatChecker = undefined;
    }
    if (host.idleRecycler !== undefined) {
      this.timers.clearTimeout(host.idleRecycler);
      host.idleRecycler = undefined;
    }

    // 尝试 kill 残留进程
    try {
      host.process.kill();
    } catch {
      // ignore
    }
  }

  /**
   * 释放 Provider Host 资源。
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async 签名为了接口一致性，未来 dispose 可能需要 await
  async disposeHost(providerId: string): Promise<void> {
    const host = this.hosts.get(providerId);
    if (!host) return;

    log.info('disposing provider', { providerId, state: host.state });

    // 清理定时器
    if (host.heartbeatChecker !== undefined) {
      this.timers.clearInterval(host.heartbeatChecker);
      host.heartbeatChecker = undefined;
    }
    if (host.idleRecycler !== undefined) {
      this.timers.clearTimeout(host.idleRecycler);
      host.idleRecycler = undefined;
    }

    // 发送 dispose 消息
    if (host.state !== 'crashed') {
      try {
        host.port.postMessage({ kind: 'dispose' });
      } catch {
        // ignore
      }
    }

    // kill 进程
    try {
      host.process.kill();
    } catch {
      // ignore
    }

    // 显式移除 exit listener（避免 listener 残留）
    if (host.exitListener) {
      try {
        host.process.removeListener('exit', host.exitListener);
      } catch {
        // ignore
      }
      host.exitListener = undefined;
    }

    host.port.close();
    host.state = 'disposed';
    this.events?.onProviderStateChanged?.(host.providerId, 'disposed');
    this.hosts.delete(providerId);
  }

  /**
   * 释放所有 Provider Host。
   */
  async disposeAll(): Promise<void> {
    const ids = Array.from(this.hosts.keys());
    await Promise.all(ids.map((id) => this.disposeHost(id)));
    log.info('all providers disposed');
  }

  /** 获取 Provider Host（仅测试用，生产代码不直接访问） */
  getHost(providerId: string): ProviderHost | undefined {
    return this.hosts.get(providerId);
  }

  /** 获取所有已加载 Provider 的状态 */
  getStates(): readonly { readonly providerId: string; readonly state: ProviderHostState }[] {
    return Array.from(this.hosts.entries()).map(([id, h]) => ({
      providerId: id,
      state: h.state,
    }));
  }

  /** 已加载 Provider 数量 */
  get size(): number {
    return this.hosts.size;
  }
}
