/**
 * M11 Orchestrator · 重试策略单元测试
 *
 * 依据：契约 I §5 / OR5 决策 / 契约 A §5
 */
import { describe, it, expect, vi } from 'vitest';
import { ProviderError } from '@urchin/ai-provider-contract';
import {
  callWithRetry,
  computeBackoff,
  MAX_RETRIES,
  BACKOFF_BASE_MS,
} from '../../src/main/orchestrator/retry';
import type { ProviderHost } from '../../src/main/orchestrator/types';
import { MockTokenBucket } from '../helpers/mock-orchestrator';

/** 创建一个 mock ProviderHost 仅供 retry 测试使用 */
function createMockHost(providerId = 'test'): ProviderHost {
  const bucket = new MockTokenBucket();
  // 提供最小必要的字段（其他字段在 retry 中未使用）
  return {
    providerId,
    manifest: {
      id: providerId,
      name: 'Test',
      version: '1.0.0',
      apiVersion: 'urchin-ai-provider/v1',
      capabilities: [],
      configSchema: {} as never,
      authMethod: 'api_key',
    },
    process: {} as never,
    port: {} as never,
    lastHeartbeat: Date.now(),
    state: 'ready',
    rateLimiter: bucket,
  };
}

describe('computeBackoff', () => {
  it('attempt 0 = 1s', () => {
    expect(computeBackoff(0)).toBe(1000);
  });

  it('attempt 1 = 2s', () => {
    expect(computeBackoff(1)).toBe(2000);
  });

  it('attempt 2 = 4s', () => {
    expect(computeBackoff(2)).toBe(4000);
  });

  it('自定义 baseMs', () => {
    expect(computeBackoff(0, 500)).toBe(500);
    expect(computeBackoff(1, 500)).toBe(1000);
    expect(computeBackoff(2, 500)).toBe(2000);
  });
});

describe('callWithRetry', () => {
  it('成功调用不重试', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockResolvedValue('ok');
    const sleep = vi.fn();

    const result = await callWithRetry(host, fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect((host.rateLimiter as MockTokenBucket).acquireCalls).toBe(1);
  });

  it('retryable 错误触发重试', async () => {
    const host = createMockHost();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('NETWORK_ERROR', 'net err'))
      .mockRejectedValueOnce(new ProviderError('RATE_LIMITED', '429'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await callWithRetry(host, fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('不可重试错误立即抛出', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new ProviderError('AUTH_INVALID', 'bad key'));
    const sleep = vi.fn();

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('bad key');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('达到 maxRetries 上限后抛出', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new ProviderError('NETWORK_ERROR', 'always fail'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('always fail');
    // 1 次初始 + MAX_RETRIES 次重试 = 4 次
    expect(fn).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    expect(sleep).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(sleep).toHaveBeenNthCalledWith(3, 4000);
  });

  it('非 ProviderError 被装箱为 UNKNOWN（不可重试）', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new Error('plain error'));
    const sleep = vi.fn();

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('plain error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('自定义 maxRetries', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new ProviderError('NETWORK_ERROR', 'fail'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(callWithRetry(host, fn, { sleep, maxRetries: 1 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(2); // 1 次初始 + 1 次重试
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('CONTENT_FILTERED 不重试', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new ProviderError('CONTENT_FILTERED', 'filtered'));
    const sleep = vi.fn();

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('filtered');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('CONTEXT_TOO_LONG 不重试', async () => {
    const host = createMockHost();
    const fn = vi.fn().mockRejectedValue(new ProviderError('CONTEXT_TOO_LONG', 'too long'));
    const sleep = vi.fn();

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('too long');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retryable=true 但显式标记 retryable=false 时不重试', async () => {
    const host = createMockHost();
    // NETWORK_ERROR 默认 retryable=true，这里强制覆盖为 false
    const fn = vi
      .fn()
      .mockRejectedValue(
        new ProviderError('NETWORK_ERROR', 'forced no retry', { retryable: false }),
      );
    const sleep = vi.fn();

    await expect(callWithRetry(host, fn, { sleep })).rejects.toThrow('forced no retry');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('BACKOFF_BASE_MS 常量是 1000', () => {
    expect(BACKOFF_BASE_MS).toBe(1000);
  });

  it('MAX_RETRIES 常量是 3', () => {
    expect(MAX_RETRIES).toBe(3);
  });
});
