/**
 * pi 网页版启动器 · IPC Handler 注册（阶段 1）
 *
 * 通道（契约见 ipc-contract piWeb.* schema）：
 * 1. piWeb.launch：启动/复用 pi 网页服务，返回入口 URL（失败抛 IpcError）
 * 2. piWeb.status：查询状态快照（stopped/starting/running/error + url/port/pid）
 * 3. piWeb.stop：停止服务（幂等）
 *
 * 设计：launcher 实例由 main/index.ts 注入（dataDir/cwd 指向 userData/pi，
 * DD1 决策）；dispose 供 performCleanup 调用，确保 app 退出时子进程树被终止。
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { PiWebLauncher } from './launcher';

const log = createLogger('pi-web-ipc');

/**
 * 注册 piWeb 域 IPC handler。
 *
 * @returns dispose 函数：app 退出时调用，终止 pi-web-ui 子进程树。
 */
export function registerPiWebHandlers(
  ipcMain: IpcMain,
  launcher: PiWebLauncher,
): { dispose(): void } {
  // ── piWeb.launch：启动（或复用）服务 ──
  registerHandler(ipcMain, 'piWeb.launch', async () => {
    log.info('piWeb.launch');
    try {
      const port = await launcher.launch();
      return { ok: true as const, url: `http://127.0.0.1:${port}`, port };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('piWeb.launch failed', { error: message });
      throw new IpcError(IpcErrorCode.INTERNAL, `piWeb.launch: ${message}`, {
        channel: 'piWeb.launch',
      });
    }
  });

  // ── piWeb.status：状态快照 ──
  registerHandler(ipcMain, 'piWeb.status', () => {
    const snapshot = launcher.status();
    return snapshot;
  });

  // ── piWeb.stop：停止服务 ──
  registerHandler(ipcMain, 'piWeb.stop', async () => {
    log.info('piWeb.stop');
    await launcher.stop();
    return { ok: true as const };
  });

  log.info('piWeb ipc handlers registered');

  return {
    dispose(): void {
      void launcher.dispose().catch((e) => {
        log.error('piWeb dispose failed', { error: String(e) });
      });
    },
  };
}
