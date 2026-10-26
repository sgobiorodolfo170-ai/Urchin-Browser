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
       * 基线实测（2026-10-27，v0.2.0 stable 收口后，119 测试文件 / 1393 用例全绿）：
       * lines 66.79% / statements 66.79% / branches 79.36% / functions 75.89%
       * 距 65% 门槛仅 1.79pp 余量——新代码请自带测试，否则门禁会先于评审拦下。
       * 逐版本提升时只改这四个数字，并同步 docs/03-技术栈 §4（唯一真源）。
       */
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 65,
        branches: 65,
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
