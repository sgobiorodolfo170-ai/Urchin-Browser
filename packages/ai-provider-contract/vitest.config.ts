import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      /**
       * 分层门槛（agents.md §八.2：AI Provider 抽象层 v0.1/v0.2 ≥80%，v1.0 ≥90%）
       *
       * 2026-10-27 接入。实测 lines 90.09% / branch 88.23% / funcs 91.66%，
       * 门槛按阶梯值 80 设，为后续新增契约字段留出余量。
       */
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
