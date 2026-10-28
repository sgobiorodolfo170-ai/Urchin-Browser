/**
 * pi 阶段 2 托管服务 · utilityProcess 入口
 *
 * 从 argv 读取配置并启动组合服务；就绪后向 stdout 输出
 * `pi-web-host ready: <url>`（desktop 侧 PiWebHostLauncher 以此解析认证 URL，
 * 与 dsh 同法）。收到 SIGTERM/SIGINT 优雅关闭并退出。
 *
 * 注意：本文件是 esbuild bundle（scripts/build-pi-web.mjs）的入口，产物
 * apps/desktop/dist/main/pi-web-host.js 由 utilityProcess.fork 加载。
 */
import { argv, stdout } from 'node:process';
import { startPiWebHostServer } from './server';
import { HOST_READY_PREFIX } from './auth';

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const wwwDir = parseArg('www-dir');
  const portRaw = parseArg('port');
  const dataDir = parseArg('cwd');
  const apiKey = parseArg('api-key') ?? process.env.PI_HOST_API_KEY;
  const providerId = parseArg('provider-id') ?? process.env.PI_HOST_PROVIDER;
  const modelId = parseArg('model') ?? process.env.PI_HOST_MODEL;
  const baseUrl = parseArg('base-url') ?? process.env.PI_HOST_BASE_URL;
  const systemPrompt = parseArg('system-prompt') ?? process.env.PI_HOST_SYSTEM_PROMPT;
  if (!wwwDir) {
    throw new Error('pi-web-host: --www-dir is required');
  }
  if (dataDir) {
    // M2A 仅承接数据目录占位（后续 AgentSession/session 落盘用）。先确保存在。
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });
  }

  const handle = await startPiWebHostServer({
    wwwDir,
    port: portRaw === undefined ? 0 : Number(portRaw),
    agentDir: dataDir,
    // M2B：凭据/模型经 argv 注入（主进程 agentConfigProvider 合并后传入）
    agent:
      apiKey && providerId && modelId
        ? {
            apiKey,
            providerId,
            modelId,
            baseUrl: baseUrl ?? undefined,
            systemPrompt: systemPrompt ?? undefined,
          }
        : undefined,
  });

  stdout.write(`\n${HOST_READY_PREFIX}${handle.url}\n`);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error('[pi-web-host] fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
