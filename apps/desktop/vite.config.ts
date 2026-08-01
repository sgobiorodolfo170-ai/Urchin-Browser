/**
 * Vite 多入口配置（SC1 决策：单 vite.config.ts 多入口）
 *
 * 三个构建目标（通过 --mode 传入）：
 * 1. main：主进程，CommonJS + Node 环境
 * 2. preload：preload 脚本，CommonJS + Node 环境（沙箱限制）
 * 3. renderer：渲染进程，ESM + 浏览器环境（React）
 *
 * 开发模式（vite 不带 build）启动 renderer dev server。
 *
 * 注意：根 package.json 含 "type": "module"，但 main/preload 构建为 CJS，
 * 因此通过 cjsMarker 插件在输出目录写入 {"type":"commonjs"} 的 package.json，
 * 确保 Node.js 以 CJS 模式加载主进程与 preload。
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

/** Node.js 内置模块列表（用于 external 化，避免 Vite 当作浏览器模块处理） */
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'electron',
  'better-sqlite3',
].filter((m) => m !== 'sqlite' && m !== 'node:sqlite'); // node:sqlite 由桩模块替代（见 stubAliases）

/**
 * 运行时桩模块别名（覆盖 nodeBuiltins 中的 external 项）。
 *
 * `node:sqlite` 是 Node.js 22.5+ 才加入的内置模块，Urchin 的 Electron 32.3.3
 * （Node.js 20.x）没有该模块。undici 的 SqliteCacheStore 在模块顶层执行
 * `require("node:sqlite")`，若不处理会导致主进程启动即崩溃
 * （ERR_UNKNOWN_BUILTIN_MODULE）。Urchin 不使用 SqliteCacheStore，因此用桩模块
 * 顶替：顶层 require 成功，DatabaseSync 仅在实例化时抛错（永远不会触发）。
 *
 * 必须放在 resolve.alias 中且优先级高于 rollupOptions.external，才能让 rollup
 * 真正打包桩模块而不是保留 `require("node:sqlite")`。
 */
const stubAliases: Record<string, string> = {
  'node:sqlite': resolve(__dirname, 'src', 'main', 'stubs', 'node-sqlite-stub.ts'),
};

/**
 * pi 仓库包别名（git subtree 引入，直接指向 src 源码，跳过 dist build）
 *
 * 方案 A：安装 pi-tui 作为依赖，但不在运行时调用其终端渲染函数。
 * pi-tui 的原生扩展是懒加载的，顶层 import 不会触发 .node 文件加载。
 *
 * 别名让 vite/rollup 直接打包 pi 的 TS 源码，无需预先 build。
 *
 * 注意：别名指向 `src` 目录而非 `index.ts`，以便 subpath imports（如
 * `@earendil-works/pi-ai/compat`）能正确解析为 `src/compat.ts`。
 * Vite 的 index resolution 会自动处理 bare import → `src/index.ts`。
 */
const piRoot = resolve(__dirname, '..', '..', 'vendor', 'pi', 'packages');
const piAliases: Record<string, string> = {
  '@earendil-works/pi-ai': resolve(piRoot, 'ai', 'src'),
  '@earendil-works/pi-agent-core': resolve(piRoot, 'agent', 'src'),
  '@earendil-works/pi-coding-agent': resolve(piRoot, 'coding-agent', 'src'),
  '@earendil-works/pi-tui': resolve(piRoot, 'tui', 'src'),
};

/** 合并所有别名（stub + pi），用于 resolve.alias */
const allAliases: Record<string, string> = { ...stubAliases, ...piAliases };

/** 在输出目录写入 {"type":"commonjs"} 标记文件，使 CJS 产物可被 Node.js 正确加载 */
function cjsMarker(outDir: string): Plugin {
  return {
    name: 'cjs-marker',
    closeBundle() {
      try {
        writeFileSync(resolve(__dirname, outDir, 'package.json'), '{"type":"commonjs"}\n');
      } catch {
        // 忽略写入错误（目录可能尚未创建）
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // 开发模式：启动 renderer dev server
  if (mode === 'development') {
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
  if (mode === 'main') {
    return {
      plugins: [cjsMarker('dist/main')],
      build: {
        outDir: 'dist/main',
        emptyOutDir: true,
        lib: {
          entry: resolve(__dirname, 'src/main/index.ts'),
          formats: ['cjs'],
          fileName: () => 'index.js',
        },
        rollupOptions: {
          external: nodeBuiltins,
        },
      },
      resolve: {
        conditions: ['node'],
        alias: allAliases,
      },
    };
  }

  // preload 构建
  if (mode === 'preload') {
    return {
      plugins: [cjsMarker('dist/preload')],
      build: {
        outDir: 'dist/preload',
        emptyOutDir: true,
        lib: {
          entry: resolve(__dirname, 'src/preload/index.ts'),
          formats: ['cjs'],
          fileName: () => 'index.js',
        },
        rollupOptions: {
          external: nodeBuiltins,
        },
      },
    };
  }

  // renderer 生产构建（mode === 'renderer' 或 'production'）
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
