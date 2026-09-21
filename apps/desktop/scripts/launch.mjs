/**
 * 以生产模式启动已构建应用（人工验收用）
 *
 * 背景：主进程 create-window 以 `NODE_ENV !== 'production'` 判定 dev 模式，
 * dev 模式会去连 http://localhost:5173（vite dev server）；直接 `electron .`
 * 而未设 NODE_ENV 时会白屏。本脚本统一入口：校验构建产物 → 带
 * NODE_ENV=production 脱离终端后台启动，供用户直接测试。
 *
 * 用法：pnpm start（根或 apps/desktop）
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..');

const required = [
  join(appRoot, 'dist', 'main', 'index.js'),
  join(appRoot, 'dist', 'preload', 'index.js'),
  join(appRoot, 'dist', 'renderer', 'index.html'),
];
const missing = required.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('[launch] 构建产物缺失，请先执行 pnpm run build：');
  for (const p of missing) console.error('  -', p);
  process.exit(1);
}

const electronBinary = join(
  appRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
if (!existsSync(electronBinary)) {
  console.error('[launch] 未找到 Electron 可执行文件（pnpm install 是否完成？）:', electronBinary);
  process.exit(1);
}

// 启动日志落盘（应用崩溃/白屏时便于排查；不占用终端）
const logPath = join(tmpdir(), 'urchin-launch.log');
const logFd = openSync(logPath, 'a');
const child = spawn(electronBinary, ['.'], {
  cwd: appRoot,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, NODE_ENV: 'production' },
});
closeSync(logFd);
child.unref();
console.log(`[launch] Urchin 已以生产模式启动（PID ${child.pid}，日志：${logPath}）`);
