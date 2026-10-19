/**
 * M20 Update · IPC Handler 注册（dev.114 提前落地）
 *
 * 通道（契约见 ipc-contract update.* schema）：
 * 1. update.getState：读取状态快照（同步快操作，默认 30s 超时）
 * 2. update.check：检查更新——GitHub releases.atom + dev.yml 清单网络抓取，
 *    放宽到 60s（慢网下默认 30s 会先杀 invoke，设置页只能显示"超时"）
 * 3. update.download：开始下载，立即返回快照；进度经 update:event 推送
 * 4. update.install：退出应用并安装（立即返回 {ok}；服务侧 setImmediate 后退出）
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { UpdateService } from './update-service';

const log = createLogger('update-ipc');

/** check 通道 IPC 超时：GitHub 两跳网络请求，60s 给慢网留余量。 */
const CHECK_TIMEOUT_MS = 60_000;

/** 注册 update 域 IPC handler（服务由 index.ts 组装注入）。 */
export function registerUpdateHandlers(ipcMain: IpcMain, service: UpdateService): void {
  registerHandler(ipcMain, 'update.getState', () => service.getState());

  registerHandler(ipcMain, 'update.check', () => service.check(), { timeoutMs: CHECK_TIMEOUT_MS });

  registerHandler(ipcMain, 'update.download', () => service.download());

  registerHandler(ipcMain, 'update.install', () => {
    service.install();
    return { ok: true as const };
  });

  log.info('update ipc handlers registered');
}
