/**
 * pi 阶段 2 · 构建集成脚本
 *
 * 两件事（都必须在 desktop `build:main` 之后运行——那是 emptyOutDir:true 会清空
 * dist/main，本脚本再写入以避开清空窗口）：
 *
 * 1. bundle packages/pi-web-host/src/entry.ts → apps/desktop/dist/main/pi-web-host.js
 *    —— utilityProcess.fork 的加载目标（CJS、Node 平台、内联 ws，仅保留可选原生
 *    原生扩展 external）。dev/打包同构。
 * 2. 构建 apps/pi-web 前端并把产物复制到 apps/desktop/dist/pi-web
 *    —— pi-web-host 在运行时以 dist/pi-web 为 wwwDir 静态托管。
 *
 * 用法：node scripts/build-pi-web.mjs（由 @urchin/desktop build / package:win 调用）
 * 前置：pnpm install 完成（ws/esbuild 已装）、apps/pi-web 依赖可解析。
 */
import { mkdirSync, cpSync, rmSync } from 'node:fs';
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
const frontendDistOut = join(desktop, 'dist', 'pi-web');

/**
 * pi 仓库包别名（与 apps/desktop/vite.config.ts 的 piAliases 同源）：
 * vendored pi 只有 src 源码（无 dist/），必须别名指向 src 才能被 esbuild 打包。
 * M2B 起 pi-web-host import pi-agent-core + pi-ai（浏览器安全子集）。
 */
const piAliases = {
  '@earendil-works/pi-ai': resolve(piRoot, 'ai', 'src'),
  '@earendil-works/pi-agent-core': resolve(piRoot, 'agent', 'src'),
  '@earendil-works/pi-coding-agent': resolve(piRoot, 'coding-agent', 'src'),
  '@earendil-works/pi-tui': resolve(piRoot, 'tui', 'src'),
};

async function main() {
  // 1) bundle pi-web-host utility 入口
  await build({
    entryPoints: [join(hostPkg, 'src', 'entry.ts')],
    outfile: entryOut,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    sourcemap: false,
    // bufferutil / utf-8-validate 是 ws 的可选原生加速，缺失时 ws 自动回退纯 JS；
    // pi 依赖的原生/wasm 模块在 utility 进程内 lazy 加载，external 化避免打包失败
    external: ['bufferutil', 'utf-8-validate'],
    alias: piAliases,
    // codemode/mcp/telemetry 等包 exports 带 source 条件 → src；pi-tui 别名已覆盖
    conditions: ['source', 'node', 'import'],
    logLevel: 'info',
  });

  // 2) 构建 + 复制前端产物
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

  console.log(
    `[build-pi-web] ok\n  host bundle -> ${entryOut}\n  frontend     -> ${frontendDistOut}`,
  );
}

main().catch((err) => {
  console.error('[build-pi-web] failed', err);
  process.exit(1);
});
