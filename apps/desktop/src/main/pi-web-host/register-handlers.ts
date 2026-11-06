/**
 * pi 阶段 2 托管服务启动器 · IPC Handler 注册
 *
 * 通道（契约见 ipc-contract pihost.* schema）：
 * 1. pihost.launch：启动/复用托管服务，返回带 token 的入口 URL（失败抛 IpcError）
 * 2. pihost.status：查询状态快照（stopped/starting/running/error + url/port/pid）
 * 3. pihost.stop：停止服务（幂等）
 *
 * 与 piWeb（阶段 1）同构；launch 超时须 > 启动器 STARTUP_TIMEOUT_MS（60s）——
 * 默认 30s 会在冷启动慢时先杀 invoke，渲染层收 TIMEOUT 后放弃自动开标签。
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { PiWebHostLauncher } from './launcher';

const log = createLogger('pi-web-host-ipc');

const LAUNCH_TIMEOUT_MS = 90_000;

/**
 * 注册 pihost 域 IPC handler。
 *
 * @returns dispose 函数：app 退出时调用，终止 utility 子进程。
 */
export function registerPiWebHostHandlers(
  ipcMain: IpcMain,
  launcher: PiWebHostLauncher,
): { dispose(): void } {
  registerHandler(
    ipcMain,
    'pihost.launch',
    async () => {
      log.info('pihost.launch');
      try {
        const url = await launcher.launch();
        const m = /:(\d+)\//.exec(url);
        const port = m ? Number(m[1]) : undefined;
        return { ok: true as const, url, port: port ?? 0 };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error('pihost.launch failed', { error: message });
        throw new IpcError(IpcErrorCode.INTERNAL, `pihost.launch: ${message}`, {
          channel: 'pihost.launch',
        });
      }
    },
    { timeoutMs: LAUNCH_TIMEOUT_MS },
  );

  registerHandler(ipcMain, 'pihost.status', () => {
    return launcher.status();
  });

  registerHandler(ipcMain, 'pihost.stop', async () => {
    log.info('pihost.stop');
    await launcher.stop();
    return { ok: true as const };
  });

  log.info('pihost ipc handlers registered');

  return {
    dispose(): void {
      void launcher.dispose().catch((e) => {
        log.error('pihost dispose failed', { error: String(e) });
      });
    },
  };
}
