/**
 * M11 AI Orchestrator · 令牌桶限流（OR4 决策）
 *
 * 依据：契约 I §4
 *
 * 每 Provider 独立桶，按 manifest.rateLimit 自报。
 * - requestsPerMin：每分钟最大请求数，决定桶容量
 * - tokensPerMin（可选）：每分钟最大 token 数，token 级限速（v0.2+ 用）
 *
 * 否决全局共享桶：会与 Provider 自限速失配，可能造成 Provider 被 429。
 *
 * 设计：
 * - 漏桶算法：以 capacityPerMin/60 的速率持续补充 token
 * - acquireRequestToken：取 1 个请求 token，无可用则 sleep 100ms 后重试
 * - 注入 now() 和 sleep() 便于测试
 */
import type { ITokenBucket } from './types';

export interface TimeProvider {
  now(): number;
}

export interface SleepProvider {
  sleep(ms: number): Promise<void>;
}

const DEFAULT_TIME: TimeProvider = { now: () => Date.now() };
const DEFAULT_SLEEP: SleepProvider = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** 默认 acquire 等待间隔（ms） */
const ACQUIRE_RETRY_INTERVAL_MS = 100;

/**
 * 令牌桶实现。
 *
 * 用漏桶算法（token bucket）按时间补充 token：
 *   tokens = min(capacity, tokens + elapsedMin * capacityPerMin)
 *
 * 注意：request-level 与 token-level 是两个独立桶（v0.1 仅启用 request-level）。
 */
export class TokenBucket implements ITokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacityPerMin: number;
  private readonly time: TimeProvider;
  private readonly sleep: SleepProvider;

  constructor(
    capacityPerMin: number,
    options?: {
      readonly initialTokens?: number;
      readonly time?: TimeProvider;
      readonly sleep?: SleepProvider;
    },
  ) {
    if (capacityPerMin <= 0) {
      throw new Error(`TokenBucket capacityPerMin must be > 0, got ${capacityPerMin}`);
    }
    this.capacityPerMin = capacityPerMin;
    this.time = options?.time ?? DEFAULT_TIME;
    this.sleep = options?.sleep ?? DEFAULT_SLEEP;
    this.tokens = options?.initialTokens ?? capacityPerMin;
    this.lastRefill = this.time.now();
  }

  /** 取 1 个请求 token，无可用则阻塞等待直到有可用 */
  async acquireRequestToken(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep.sleep(ACQUIRE_RETRY_INTERVAL_MS);
    }
  }

  /** 当前可用 token 数（含未 refill 的过期值，仅用于测试观测） */
  get availableTokens(): number {
    return this.tokens;
  }

  /** 按经过时间补充 token */
  private refill(): void {
    const now = this.time.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const elapsedMin = elapsedMs / 60_000;
    this.tokens = Math.min(this.capacityPerMin, this.tokens + elapsedMin * this.capacityPerMin);
    this.lastRefill = now;
  }
}
