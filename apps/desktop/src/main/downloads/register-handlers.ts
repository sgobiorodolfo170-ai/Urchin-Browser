/**
 * M23 Download Manager · Download IPC Handler 注册
 *
 * 依据：契约 B §3.1 download.* 通道 / 04-模块全景 M23/M17
 * 职责：
 * 注册 download.list / download.cancel / download.pause /
 *      download.resume / download.clear IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 DownloadManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { DownloadManager } from './download-manager';

const log = createLogger('download-ipc');

/**
 * 注册 download 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param downloadManager DownloadManager 实例
 */
export function registerDownloadHandlers(ipcMain: IpcMain, downloadManager: DownloadManager): void {
  // download.list：列出全部下载项
  registerHandler(ipcMain, 'download.list', () => {
    log.info('download.list');

    const downloads = downloadManager.list();

    return { downloads };
  });

  // download.cancel：取消指定下载项
  registerHandler(ipcMain, 'download.cancel', (req) => {
    log.info('download.cancel', { id: req.id });

    downloadManager.cancel(req.id);

    return { ok: true as const, id: req.id };
  });

  // download.pause：暂停指定下载项
  registerHandler(ipcMain, 'download.pause', (req) => {
    log.info('download.pause', { id: req.id });

    downloadManager.pause(req.id);

    return { ok: true as const, id: req.id };
  });

  // download.resume：恢复指定下载项
  registerHandler(ipcMain, 'download.resume', (req) => {
    log.info('download.resume', { id: req.id });

    downloadManager.resume(req.id);

    return { ok: true as const, id: req.id };
  });

  // download.clear：清理下载项（指定 id 或全部已结束）
  registerHandler(ipcMain, 'download.clear', (req) => {
    log.info('download.clear', { id: req.id });

    const deleted = downloadManager.clear(req.id);

    return { ok: true as const, deleted };
  });

  log.info('download ipc handlers registered');
}
