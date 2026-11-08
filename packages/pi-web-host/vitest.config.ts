import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 超时放宽（2026-11-08）：本包含真实 git / 子进程与「300 份随机转录」类重算法用例，
    // 默认 5s 在 `pnpm test:coverage`（7 个 workspace 并发 + v8 覆盖率插桩）下会因 CPU 争抢
    // 偶发超时，属测试基础设施不稳定而非产品缺陷。放宽到 30s 让慢用例拿到应得的时间，
    // 同时保留超时保护（真死循环仍会失败）。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
    },
  },
});
