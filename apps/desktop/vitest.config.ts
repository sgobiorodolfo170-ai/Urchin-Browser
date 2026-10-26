import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * pi 仓库包别名（与 vite.config.ts 保持一致）
 *
 * 测试环境必须配置与构建相同的别名，否则 vitest 无法解析
 * `@earendil-works/pi-agent-core` 等 pi 包导入。
 *
 * 别名指向 `src` 目录以支持 subpath imports（如 `@earendil-works/pi-ai/compat`）。
 */
const piRoot = resolve(__dirname, '..', '..', 'vendor', 'pi', 'packages');
const piAliases: Record<string, string> = {
  '@earendil-works/pi-ai': resolve(piRoot, 'ai', 'src'),
  '@earendil-works/pi-agent-core': resolve(piRoot, 'agent', 'src'),
  '@earendil-works/pi-coding-agent': resolve(piRoot, 'coding-agent', 'src'),
  '@earendil-works/pi-tui': resolve(piRoot, 'tui', 'src'),
};

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/types.ts',
        'src/**/index.ts',
        'src/main/index.ts',
        'src/preload/**',
        'src/renderer/main.tsx',
      ],
      /**
       * 覆盖率门禁（agents.md §八.2 / docs/03-技术栈 §4）
       *
       * 门槛取 v0.2 阶梯值 ≥65%。没有 thresholds 时 `--coverage` 只出报告、
       * 低于门槛也退出码 0，等于「门禁」名存实亡——此处补上后才真正阻断。
       *
       * 基线实测（2026-10-27，v0.2.0 stable 收口后，120 个测试文件全量收集）：
       * lines 69.18% / statements 69.18% / branches 79.57% / functions 77.12%
       * 距 65% 门槛约 4pp 余量——新代码请自带测试，否则门禁会先于评审拦下。
       * 逐版本提升时只改这四个数字，并同步 docs/03-技术栈 §4（唯一真源）。
       *
       * ⚠ 采集不全时会失真：本机若只收集到 117~119 个文件（宿主 fs 限制导致个别
       * 测试文件加载失败，伴随 Unhandled Error），整体覆盖率会掉到 56~66%，
       * 此时报的是**收集问题**不是代码退化。判断方法：看 `Test Files` 是否为 120。
       */
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 65,
        branches: 65,
        /**
         * 分层门槛（agents.md §八.2 分层目标的项目化，2026-10-27 接入）
         *
         * 核心业务模块 Tab Manager（M2）阶梯要求 v0.2 ≥75%。全量收集（120 个测试
         * 文件）时实测 lines 90.02% / branch 77.23% / funcs 87.75%，故行/语句/函数
         * 按阶梯值 75 设，分支留余量设 70。
         *
         * ⚠ 已知环境差异：若测试文件未被完整收集（见下方 note），tabs 覆盖率会掉到
         * 67% 左右并触发本门槛。这是**保护性失败**——覆盖率数据以 CI 为准，本机出现
         * 该失败时先看 `Test Files` 是否为 120，不是 120 则属收集不全而非代码退化。
         */
        'src/main/tabs/**': {
          lines: 75,
          statements: 75,
          functions: 75,
          branches: 70,
        },
      },
    },
  },
  resolve: {
    alias: {
      ...piAliases,
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@preload': resolve(__dirname, 'src/preload'),
    },
  },
});
