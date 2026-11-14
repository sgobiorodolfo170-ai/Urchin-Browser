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
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { isLaunchReady, isPidAlive } from './launch-health.mjs';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronBinary } from './electron-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(__dirname, '..');

const review = process.argv.includes('--review');
const reviewKey = createHash('sha256').update(appRoot.toLowerCase()).digest('hex').slice(0, 12);
if (review) {
  process.env.URCHIN_NATIVE_EXIT_GUARD = '1';
  if (Boolean(process.env.URCHIN_TEST_USER_DATA) !== Boolean(process.env.URCHIN_TEST_DATA_DIR)) {
    throw new Error('验收实例必须同时设置 URCHIN_TEST_USER_DATA 与 URCHIN_TEST_DATA_DIR');
  }
  process.env.URCHIN_TEST_USER_DATA ??= join(tmpdir(), `urchin-review-${reviewKey}`);
  process.env.URCHIN_TEST_DATA_DIR ??= join(process.env.URCHIN_TEST_USER_DATA, 'data');
}
const profileKey = createHash('sha256')
  .update(process.env.URCHIN_TEST_USER_DATA ?? appRoot)
  .digest('hex')
  .slice(0, 12);
const readyFile = join(
  tmpdir(),
  review ? `urchin-review-${profileKey}.json` : `urchin-launch-${randomUUID()}.json`,
);
if (review) {
  let previous;
  try {
    previous = JSON.parse(await readFile(readyFile, 'utf8'));
  } catch {
    /* 首次启动 */
  }
  if (previous && isPidAlive(previous.pid)) {
    if (isLaunchReady(previous, previous.pid, 0)) {
      console.log(`[launch] 已有就绪验收实例（PID ${previous.pid}），复用固定档案，不重复创建。`);
      process.exit(0);
    }
    console.error(
      `[launch] 验收实例 PID ${previous.pid} 心跳已过期；请先关闭或排查该实例，停止重复启动。`,
    );
    process.exit(1);
  }
}

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

const electronBinary = resolveElectronBinary();
if (!existsSync(electronBinary)) {
  console.error('[launch] 未找到 Electron 可执行文件（pnpm install 是否完成？）:', electronBinary);
  process.exit(1);
}

// 启动日志落盘（应用崩溃/白屏时便于排查；不占用终端）
const logPath = join(tmpdir(), 'urchin-launch.log');
const logFd = openSync(logPath, 'a');
const startedAt = Date.now();
let spawnError;
const child = spawn(electronBinary, ['.'], {
  cwd: appRoot,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, NODE_ENV: 'production', URCHIN_LAUNCH_READY_FILE: readyFile },
});
closeSync(logFd);
child.on('error', (error) => {
  spawnError = error;
});
let ready = false;
const deadline = startedAt + 30_000;
while (
  Date.now() < deadline &&
  !spawnError &&
  child.exitCode === null &&
  child.signalCode === null
) {
  try {
    ready = isLaunchReady(JSON.parse(await readFile(readyFile, 'utf8')), child.pid, startedAt);
  } catch {
    /* 等待主窗口回执 */
  }
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) {
  console.error(
    `[launch] 启动未就绪：${spawnError?.message ?? (child.exitCode !== null ? `提前退出 code=${child.exitCode}（请检查单实例锁/日志）` : '等待主窗口或事件循环心跳超时')}，日志：${logPath}`,
  );
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          killer.kill();
          killer.unref();
          resolve();
        }, 5000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        killer.once('exit', done);
        killer.once('error', done);
      });
    } else child.kill('SIGKILL');
  }
  await rm(readyFile, { force: true });
  process.exitCode = 1;
} else {
  child.unref();
  console.log(`[launch] Urchin 主窗口已就绪（生产模式）（PID ${child.pid}，日志：${logPath}）`);
}

// 失败路径同样不能被已卡死子进程的进程句柄拖住 CLI。
child.unref();
