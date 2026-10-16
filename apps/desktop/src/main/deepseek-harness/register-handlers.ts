/**
 * DeepSeek Harness 启动器 · IPC Handler 注册
 *
 * 通道（契约见 ipc-contract deepseekHarness.* schema）：
 * 1. deepseekHarness.launch：启动/复用 dsh web 服务，返回入口 URL（失败抛 IpcError）
 * 2. deepseekHarness.status：查询状态快照
 * 3. deepseekHarness.stop：停止服务（幂等）
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { DshLauncher } from './launcher';

const log = createLogger('dsh-ipc');

/**
 * launch 通道 IPC 超时。
 *
 * 必须 > launcher 启动上限（STARTUP_TIMEOUT_MS=120s，dsh 冷启动含 Cordis
 * 插件加载与 tsx 转译），让启动器自身错误成为唯一失败出口——默认 30s 会在
 * 冷启动慢时先杀 invoke，渲染层放弃自动开标签（与 piWeb.launch 同病，
 * 2026-10-16 一并修复）。
 */
const LAUNCH_TIMEOUT_MS = 180_000;

/**
 * 注册 deepseekHarness 域 IPC handler。
 *
 * @returns dispose 函数：app 退出时调用，终止 dsh 子进程树。
 */
export function registerDshHandlers(ipcMain: IpcMain, launcher: DshLauncher): { dispose(): void } {
  registerHandler(
    ipcMain,
    'deepseekHarness.launch',
    async () => {
      log.info('deepseekHarness.launch');
      try {
        const result = await launcher.launch();
        return { ok: true as const, url: result.url, port: result.port };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error('deepseekHarness.launch failed', { error: message });
        throw new IpcError(IpcErrorCode.INTERNAL, `deepseekHarness.launch: ${message}`, {
          channel: 'deepseekHarness.launch',
        });
      }
    },
    { timeoutMs: LAUNCH_TIMEOUT_MS },
  );

  registerHandler(ipcMain, 'deepseekHarness.status', () => {
    return launcher.status();
  });

  registerHandler(ipcMain, 'deepseekHarness.stop', async () => {
    log.info('deepseekHarness.stop');
    await launcher.stop();
    return { ok: true as const };
  });

  log.info('deepseekHarness ipc handlers registered');

  return {
    dispose(): void {
      void launcher.dispose().catch((e) => {
        log.error('dsh dispose failed', { error: String(e) });
      });
    },
  };
}
