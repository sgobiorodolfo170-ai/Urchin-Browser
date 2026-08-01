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
