/**
 * M11 AI Orchestrator · 重试策略（OR5 决策）
 *
 * 依据：契约 I §5 / 契约 A §5
 *
 * 对 NETWORK_ERROR / RATE_LIMITED 自动重试，指数退避 1s/2s/4s，最多 3 次。
 * 对 AUTH_INVALID / CONTEXT_TOO_LONG / CONTENT_FILTERED 直接上报，不重试。
 *
 * 设计：
 * - callWithRetry：高阶函数，包装 Provider 调用
 * - 注入 sleep 便于测试
 * - 透传 ProviderError 的 code/retryable 字段
 */
import { ProviderError } from '@urchin/ai-provider-contract';
import { createLogger } from '@urchin/logger';
import type { ProviderHost } from './types';

const log = createLogger('orchestrator-retry');

/** OR5 决策：最多 3 次重试 */
export const MAX_RETRIES = 3;

/** OR5 决策：指数退避基数 1s（1s, 2s, 4s） */
export const BACKOFF_BASE_MS = 1000;

/** Sleep 函数类型，便于测试注入 */
export type SleepFn = (ms: number) => Promise<void>;

const DEFAULT_SLEEP: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 计算第 attempt 次重试的退避时间（attempt 从 0 开始）。
 *
 * attempt=0 → 1000ms（1s）
 * attempt=1 → 2000ms（2s）
 * attempt=2 → 4000ms（4s）
 */
export function computeBackoff(attempt: number, baseMs: number = BACKOFF_BASE_MS): number {
  return Math.pow(2, attempt) * baseMs;
}

/**
 * OR5 决策：带重试的调用包装。
 *
 * - 对 retryable=true 的 ProviderError 指数退避重试，最多 MAX_RETRIES 次
 * - 不可重试的错误或达到上限后直接抛出
 * - 取 1 个请求 token 后执行 fn
 *
 * @param host Provider Host（用于取 rate limiter token）
 * @param fn 实际调用（返回 Promise）
 * @param options 可选配置（注入 sleep / 自定义 maxRetries 便于测试）
 */
export async function callWithRetry<T>(
  host: ProviderHost,
  fn: () => Promise<T>,
  options?: {
    readonly sleep?: SleepFn;
    readonly maxRetries?: number;
  },
): Promise<T> {
  const sleep = options?.sleep ?? DEFAULT_SLEEP;
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  let attempt = 0;

  while (true) {
    try {
      // 取限流 token（OR4 决策）
      await host.rateLimiter.acquireRequestToken();
      return await fn();
    } catch (err) {
      const providerError = ProviderError.from(err);

      // 不可重试或已达上限
      if (!providerError.retryable || attempt >= maxRetries) {
        log.warn(`call failed (no retry): ${providerError.code} ${providerError.message}`, {
          providerId: host.providerId,
          attempt,
          maxRetries,
          retryable: providerError.retryable,
        });
        throw providerError;
      }

      const backoff = computeBackoff(attempt);
      log.warn(
        `call attempt ${attempt + 1} failed, retrying in ${backoff}ms: ${providerError.message}`,
        {
          providerId: host.providerId,
          attempt,
          code: providerError.code,
          backoff,
        },
      );
      await sleep(backoff);
      attempt++;
    }
  }
}
