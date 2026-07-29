/**
 * Vite 多入口配置（SC1 决策：单 vite.config.ts 多入口）
 *
 * 三个构建目标：
 * 1. main：主进程，CommonJS + Node 环境
 * 2. preload：preload 脚本，CommonJS + Node 环境（沙箱限制）
 * 3. renderer：渲染进程，ESM + 浏览器环境（React）
 *
 * 通过 build.rollupOptions.input 多入口 + 环境变量选择构建模式。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 当前构建目标，通过 --mode 传入（main/preload/renderer）
const target = process.env.VITE_BUILD_TARGET ?? 'renderer';

export default defineConfig(({ mode }) => {
  // 开发模式：启动 renderer dev server + electron
  if (mode === 'development' && target === 'renderer') {
    return {
      root: 'src/renderer',
      plugins: [react()],
      server: {
        port: 5173,
        strictPort: true,
      },
      build: {
        outDir: '../../dist/renderer',
        emptyOutDir: true,
      },
    };
  }

  // 主进程构建
  if (target === 'main') {
    return {
      build: {
        outDir: 'dist/main',
        emptyOutDir: true,
        lib: {
          entry: resolve(__dirname, 'src/main/index.ts'),
          formats: ['cjs'],
          fileName: () => 'index.js',
        },
        rollupOptions: {
          external: ['electron', 'better-sqlite3'],
        },
      },
      resolve: {
        conditions: ['node'],
      },
    };
  }

  // preload 构建
  if (target === 'preload') {
    return {
      build: {
        outDir: 'dist/preload',
        emptyOutDir: true,
        lib: {
          entry: resolve(__dirname, 'src/preload/index.ts'),
          formats: ['cjs'],
          fileName: () => 'index.js',
        },
        rollupOptions: {
          external: ['electron'],
        },
      },
    };
  }

  // renderer 生产构建
  return {
    root: 'src/renderer',
    plugins: [react()],
    base: './',
    build: {
      outDir: '../../dist/renderer',
      emptyOutDir: true,
    },
  };
});
