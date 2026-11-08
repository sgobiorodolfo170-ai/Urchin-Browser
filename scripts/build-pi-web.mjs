/**
 * pi 阶段 2 · 构建集成脚本
 *
 * 三件事（都必须在 desktop `build:main` 之后运行——那是 emptyOutDir:true 会清空
 * dist/main，本脚本再写入以避开清空窗口）：
 *
 * 1. bundle packages/pi-web-host/src/entry.ts → apps/desktop/dist/main/pi-web-host.js
 *    —— utilityProcess.fork 的加载目标（CJS、Node 平台、内联 ws，仅保留可选原生
 *    扩展 external）。dev/打包同构。
 * 2. bundle packages/pi-web-host/src/pi-server/urchin-entry.ts → apps/desktop/dist/main/pi-server.mjs
 *    —— P4 接线骨架：把上游 pi-server（Express + WebSocket）包成 **ESM** utility 入口。
 *    默认不启用（入口自身靠 PI_HOST_PI_SERVER=1 / --pi-server=1 决定是否 listen），
 *    构建也不会影响 entry.ts 的既有 CJS 产物。可用 PI_WEB_SKIP_PI_SERVER=1 跳过本步。
 * 3. 构建 apps/pi-web 前端并把产物复制到 apps/desktop/dist/pi-web
 *    —— pi-web-host 在运行时以 dist/pi-web 为 wwwDir 静态托管。
 *
 * 用法：node scripts/build-pi-web.mjs（由 @urchin/desktop build / package:win 调用）
 * 前置：pnpm install 完成（ws/esbuild 已装）、apps/pi-web 依赖可解析。
 */
import { mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const hostPkg = join(repoRoot, 'packages', 'pi-web-host');
const frontApp = join(repoRoot, 'apps', 'pi-web');
const desktop = join(repoRoot, 'apps', 'desktop');
const piRoot = join(repoRoot, 'vendor', 'pi', 'packages');

const entryOut = join(desktop, 'dist', 'main', 'pi-web-host.js');
const piServerEntryOut = join(desktop, 'dist', 'main', 'pi-server.mjs');
const frontendDistOut = join(desktop, 'dist', 'pi-web');

/**
 * pi 仓库包别名（与 apps/desktop/vite.config.ts 的 piAliases 同源）：
 * vendored pi 只有 src 源码（无 dist/），必须别名指向 src 才能被 esbuild 打包。
 * M2B 起 pi-web-host import pi-agent-core + pi-ai（浏览器安全子集）；
 * pi-server 额外用 pi-mcp（oauth）、pi-coding-agent、pi-tui。
 */
const piAliases = {
  '@earendil-works/pi-ai': resolve(piRoot, 'ai', 'src'),
  '@earendil-works/pi-agent-core': resolve(piRoot, 'agent', 'src'),
  '@earendil-works/pi-coding-agent': resolve(piRoot, 'coding-agent', 'src'),
  '@earendil-works/pi-tui': resolve(piRoot, 'tui', 'src'),
  '@earendil-works/pi-mcp': resolve(piRoot, 'mcp', 'src'),
};

/** 原生 / 可选加速模块：不打包，运行时从 node_modules 解析（缺失时上层有回退逻辑） */
const nativeExternals = ['bufferutil', 'utf-8-validate', 'node-pty', 'ssh2'];

async function main() {
  // 1) bundle pi-web-host utility 入口
  await build({
    entryPoints: [join(hostPkg, 'src', 'entry.ts')],
    outfile: entryOut,
    bundle: true,
    platform: 'node',
    // CJS 格式（utilityProcess.fork 加载；ESM 格式与 pi 源码的动态 require 冲突）。
    // import.meta.url 垫片：pi-coding-agent config.ts 用 import.meta.url，CJS 中为 undefined；
    // 用 banner 注入 pathToFileURL(__filename) + define 替换。
    format: 'cjs',
    banner: {
      js: 'const __import_meta_url = require("url").pathToFileURL(__filename).toString();',
    },
    define: {
      'import.meta.url': '__import_meta_url',
    },
    target: 'es2022',
    sourcemap: false,
    // bufferutil / utf-8-validate 是 ws 的可选原生加速，缺失时 ws 自动回退纯 JS；
    // pi 依赖的原生/wasm 模块在 utility 进程内 lazy 加载，external 化避免打包失败
    external: nativeExternals,
    alias: piAliases,
    // codemode/mcp/telemetry 等包 exports 带 source 条件 → src；pi-tui 别名已覆盖
    conditions: ['source', 'node', 'import'],
    logLevel: 'info',
  });

  // 2) bundle pi-server 集成入口（ESM）
  if (process.env.PI_WEB_SKIP_PI_SERVER === '1') {
    console.log('[build-pi-web] skip pi-server bundle (PI_WEB_SKIP_PI_SERVER=1)');
  } else {
    await build({
      entryPoints: [join(hostPkg, 'src', 'pi-server', 'urchin-entry.ts')],
      outfile: piServerEntryOut,
      bundle: true,
      platform: 'node',
      // ESM 目标：上游 pi-server/index.ts 的 top-level await 已收敛进 startPiServer()，
      // 因此可以出 ESM 产物（CJS 目标无法表达 TLA，且 utilityProcess 支持 .mjs 入口）。
      format: 'esm',
      // ESM 产物里 CJS 依赖仍走 esbuild 的 __require 兜底；没有真实 require 时会在
      // 运行时抛 "Dynamic require of \"child_process\" is not supported"。
      // 用 createRequire 在 banner 注入真实的 require（冒烟已验证）。
      banner: {
        js: [
          'import { createRequire as __pi_createRequire } from "node:module";',
          'const require = __pi_createRequire(import.meta.url);',
        ].join('\n'),
      },
      target: 'es2022',
      sourcemap: false,
      external: nativeExternals,
      alias: piAliases,
      // ⚠ 不要加 'import' 条件：它会让 CJS 层的 require() 也命中 ESM 构建，
      // express 5 依赖的 is-promise 会变成命名空间对象，运行时炸
      // "isPromise2 is not a function"。source 条件仍需保留（vendored pi 包 exports）。
      conditions: ['source', 'node'],
      logLevel: 'info',
    });
  }

  // 3) 构建 + 复制前端产物
  const frontend = spawnSync('pnpm', ['--filter', '@urchin/pi-web', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (frontend.status !== 0) {
    process.exit(frontend.status ?? 1);
  }
  rmSync(frontendDistOut, { recursive: true, force: true });
  mkdirSync(dirname(frontendDistOut), { recursive: true });
  cpSync(join(frontApp, 'dist'), frontendDistOut, { recursive: true });
  // 主题文件：/themes/*.css → dist/pi-web/themes/
  const themesSrc = join(frontApp, 'themes');
  if (existsSync(themesSrc)) {
    cpSync(themesSrc, join(frontendDistOut, 'themes'), { recursive: true });
  }

  console.log(
    `[build-pi-web] ok\n  host bundle  -> ${entryOut}\n` +
      `  pi-server    -> ${piServerEntryOut}\n  frontend     -> ${frontendDistOut}`,
  );
}

main().catch((err) => {
  console.error('[build-pi-web] failed', err);
  process.exit(1);
});
