/**
 * M23 Download Manager · Download IPC Handler 注册
 *
 * 依据：契约 B §3.1 download.* 通道 / 04-模块全景 M23/M17
 * 职责：
 * 注册 download.list / download.cancel / download.pause /
 *      download.resume / download.clear / download.showInFolder IPC handler。
 *
 * 设计理由（AGENTS.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 DownloadManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 * - download.showInFolder 经依赖注入 shell.showItemInFolder（便于单测 mock）
 */
import type { IpcMain } from 'electron';
import { shell } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { DownloadManager } from './download-manager';

const log = createLogger('download-ipc');

/** 「在文件夹中显示」实现类型（与 electron shell.showItemInFolder 对齐）。 */
type ShowItemInFolderFn = (fullPath: string) => void;

/** download.showInFolder 依赖注入（便于测试 mock；默认走 electron shell）。 */
export interface DownloadHandlerOptions {
  /** 系统「在文件夹中显示」实现（单测注入 mock）。 */
  readonly showItemInFolder?: ShowItemInFolderFn;
}

/**
 * 注册 download 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param downloadManager DownloadManager 实例
 * @param options 可选依赖注入（shell.showItemInFolder mock）
 */
export function registerDownloadHandlers(
  ipcMain: IpcMain,
  downloadManager: DownloadManager,
  options: DownloadHandlerOptions = {},
): void {
  // 箭头包装避免 unbound-method（shell.showItemInFolder 是实例方法）
  const showItemInFolder: ShowItemInFolderFn =
    options.showItemInFolder ?? ((p) => shell.showItemInFolder(p));

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

  // download.showInFolder：在系统文件管理器中定位该下载文件。
  // 隐私/日志规范：savePath 为本地绝对路径，仅记录 id 与 basename，不记录完整路径。
  registerHandler(ipcMain, 'download.showInFolder', (req) => {
    log.info('download.showInFolder', { id: req.id });

    const item = downloadManager.get(req.id);
    if (!item) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `Download not found: ${req.id}`, {
        channel: 'download.showInFolder',
      });
    }
    showItemInFolder(item.savePath);

    return { ok: true as const, id: req.id };
  });

  log.info('download ipc handlers registered');
}
