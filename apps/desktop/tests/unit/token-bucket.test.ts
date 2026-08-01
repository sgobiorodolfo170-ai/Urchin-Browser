/**
 * M11 Orchestrator · TokenBucket 单元测试
 *
 * 依据：契约 I §4 / OR4 决策
 */
import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/main/orchestrator/token-bucket';

describe('TokenBucket', () => {
  it('初始化为满桶', () => {
    const bucket = new TokenBucket(60);
    expect(bucket.availableTokens).toBe(60);
  });

  it('custom initialTokens', () => {
    const bucket = new TokenBucket(60, { initialTokens: 10 });
    expect(bucket.availableTokens).toBe(10);
  });

  it('拒绝 capacityPerMin <= 0', () => {
    expect(() => new TokenBucket(0)).toThrow();
    expect(() => new TokenBucket(-1)).toThrow();
  });

  it('acquireRequestToken 成功扣 1 个 token', async () => {
    const bucket = new TokenBucket(60);
    await bucket.acquireRequestToken();
    expect(bucket.availableTokens).toBe(59);
  });

  it('连续 acquire 多次扣多个 token', async () => {
    const bucket = new TokenBucket(60);
    await bucket.acquireRequestToken();
    await bucket.acquireRequestToken();
    await bucket.acquireRequestToken();
    expect(bucket.availableTokens).toBe(57);
  });

  it('耗尽 token 后阻塞等待', async () => {
    const bucket = new TokenBucket(2, { initialTokens: 2 });
    await bucket.acquireRequestToken();
    await bucket.acquireRequestToken();
    expect(bucket.availableTokens).toBe(0);

    // 第三次 acquire 应阻塞：用 mock sleep 限制循环次数避免无限等待
    const sleepCalls: number[] = [];
    let sleepCallCount = 0;
    const sleep = {
      // eslint-disable-next-line @typescript-eslint/require-await -- mock sleep 不需要真 await
      sleep: async (ms: number): Promise<void> => {
        sleepCalls.push(ms);
        sleepCallCount++;
        if (sleepCallCount > 5) {
          throw new Error('test: would block forever');
        }
      },
    };
    const time = { now: () => 0 }; // 时间冻结，refill 不会补充
    const bucket2 = new TokenBucket(2, {
      initialTokens: 0,
      time,
      sleep,
    });

    // acquire 应在 6 次 sleep 后抛出
    await expect(bucket2.acquireRequestToken()).rejects.toThrow('test: would block forever');
    expect(sleepCalls.length).toBe(6);
    expect(sleepCalls[0]).toBe(100);
  });

  it('refill 按时间补充 token', async () => {
    let currentTime = 0;
    const time = { now: () => currentTime };
    const sleep = {
      sleep: async (): Promise<void> => {
        // no-op：此测试不依赖 sleep（acquire 立即可用，不会阻塞）
      },
    };

    const bucket = new TokenBucket(60, {
      initialTokens: 0,
      time,
      sleep,
    });
    expect(bucket.availableTokens).toBe(0);

    // 经过 30 秒（半个分钟），应该补 30 个 token
    currentTime = 30_000;
    await bucket.acquireRequestToken();
    // 30 秒补 30 个，acquire 扣 1 个 = 29 个
    expect(bucket.availableTokens).toBe(29);
  });

  it('refill 上限不超过 capacityPerMin', async () => {
    let currentTime = 0;
    const time = { now: () => currentTime };

    const bucket = new TokenBucket(60, { initialTokens: 50, time });
    // 经过 1 小时，理论上应补 60 个，但上限是 60
    currentTime = 60 * 60_000;
    await bucket.acquireRequestToken();
    // 60 - 1 = 59（acquire 后）
    expect(bucket.availableTokens).toBe(59);
  });

  it('阻塞后补充 token 会解除阻塞', async () => {
    let currentTime = 0;
    const sleepCalls: number[] = [];
    const time = { now: () => currentTime };
    const sleep = {
      // eslint-disable-next-line @typescript-eslint/require-await -- mock sleep 不需要真 await
      sleep: async (ms: number): Promise<void> => {
        sleepCalls.push(ms);
        // 每次 sleep 时推进 1 分钟，模拟时间流逝
        currentTime += 60_000;
      },
    };

    const bucket = new TokenBucket(60, {
      initialTokens: 0,
      time,
      sleep,
    });

    // 应该立即解除阻塞（第一次 refill 就补满 60 个）
    const start = Date.now();
    await bucket.acquireRequestToken();
    expect(Date.now() - start).toBeLessThan(1000);
    // 1 分钟补 60 个，acquire 扣 1 个 = 59 个
    expect(bucket.availableTokens).toBe(59);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('并发 acquire 互不影响', async () => {
    const bucket = new TokenBucket(100);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(bucket.acquireRequestToken());
    }
    await Promise.all(promises);
    expect(bucket.availableTokens).toBe(90);
  });
});
