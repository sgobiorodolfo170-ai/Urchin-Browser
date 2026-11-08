/**
 * pi 阶段 2 · pi-server 集成入口（ESM bundle）
 *
 * ⚠ 本文件不是上游 pi-web-ui 代码，是 Urchin 新增的胶水入口（上游目录内为就近复用
 *   同目录 `./index`，并沿用该目录「不纳入本项目 eslint/tsc」的边界）。
 *
 * 作用：把上游 `pi-server/index.ts`（Express + WebSocket，仅 pi 引擎子集）包成
 * utilityProcess 可加载的 ESM 入口，并**默认不启用**——`entry.ts`（CJS 轻量壳）
 * 的行为与产物保持原样，本入口只在显式开关打开时启动 pi-server。
 *
 * 开关（任一为真即启用）：
 *   - 环境变量 `PI_HOST_PI_SERVER=1`
 *   - 命令行 `--pi-server=1`
 *
 * 参数（未给则回落 pi-server 自身的 --port/--host/--cwd/--data-dir 与 PI_WEB_* 环境变量）：
 *   - `--port=<n>`        HTTP 端口，默认 0（系统分配，避免与本机端口冲突）
 *   - `--host=<addr>`     默认 127.0.0.1
 *   - `--cwd=<dir>`       Agent 工作区（注意：与 entry.ts 的 `--cwd`（数据目录）语义不同）
 *   - `--data-dir=<dir>`  数据目录
 *   - `--token=<str>`     访问口令；空串 = 关闭口令（仅回环监听时安全）
 *   - `--www-dir=<dir>`   前端静态产物目录（desktop 传 <dist>/pi-web）
 *
 * 就绪握手：listen 成功后向 stdout 打印 `pi-server ready: <url>`（见 pi-server-ready.ts），
 * 父进程据此拿到实际端口与 token；收到 SIGTERM/SIGINT 走 handle.close() 优雅退出。
 *
 * 构建：`node scripts/build-pi-web.mjs`（esbuild format=esm → dist/main/pi-server.mjs）。
 */
import { argv, stderr, stdout } from 'node:process';
import { PI_SERVER_READY_PREFIX, buildPiServerUrl } from '../pi-server-ready';
import { startPiServer, type PiServerHandle } from './index';

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function isTruthy(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? '').trim());
}

function isEnabled(): boolean {
  return isTruthy(parseArg('pi-server') ?? process.env.PI_HOST_PI_SERVER);
}

async function main(): Promise<void> {
  if (!isEnabled()) {
    // 默认关闭：立即退出，父进程可用退出码 0 判定「未启用」而非「失败」。
    stdout.write('[pi-server-entry] disabled (set PI_HOST_PI_SERVER=1 or --pi-server=1 to start)\n');
    return;
  }

  const portRaw = parseArg('port');
  const handle: PiServerHandle = await startPiServer({
    port: portRaw === undefined ? 0 : Number(portRaw),
    host: parseArg('host') ?? process.env.PI_WEB_HOST ?? '127.0.0.1',
    cwd: parseArg('cwd') ?? process.env.PI_WEB_CWD,
    dataDir: parseArg('data-dir') ?? process.env.PI_WEB_DATA_DIR,
    token: parseArg('token') ?? process.env.PI_WEB_TOKEN,
    webDistDir: parseArg('www-dir'),
  });

  stdout.write(`\n${PI_SERVER_READY_PREFIX}${buildPiServerUrl(handle.port, handle.host, handle.token)}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void handle.close().then(
      () => {
        process.exit(0);
      },
      (err: unknown) => {
        console.error('[pi-server-entry] close failed', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  stderr.write(`[pi-server-entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});