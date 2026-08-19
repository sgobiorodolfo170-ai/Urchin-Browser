/**
 * 下载域 · will-download 完整下载挂钩（DL1 决策）
 *
 * 职责：把 Chromium 真实下载接到 Urchin 下载体系——
 * 1. 保存位置策略：
 *    a. 用户已设置 downloadsPath → 直接保存到该目录（不再询问）
 *    b. 未设置 → 弹系统保存对话框（默认 <用户数据目录>/downloads/<文件名>），
 *       确认后询问「是否设为默认下载路径」（勾选 → 写入 downloadsPath 设置）
 * 2. 下载进度/状态同步到 DownloadManager（收藏夹面板「下载」页展示用）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - BrowserView 使用默认 session，挂 session.defaultSession 的 will-download
 *   即覆盖所有网页下载；对话框懒取焦点窗口（无窗口时走无父窗口模态）
 * - 每次下载询问 + 可设默认（DL1 决策，用户指定交互）：设置后直达目录不打扰
 * - 状态同步经 DownloadManager 事件驱动，面板侧已有 download.list 消费，
 *   无需新增 IPC 通道
 */
import { join, dirname } from 'node:path';
import { session, dialog, BrowserWindow } from 'electron';
import type { DownloadManager } from './download-manager';
import { createLogger } from '@urchin/logger';

const log = createLogger('will-download');

/** 默认下载子目录名（相对用户数据目录；DD1 决策：下载属用户个人数据） */
const DOWNLOADS_DIR = 'downloads';

/** will-download 依赖注入（便于测试） */
export interface WillDownloadDeps {
  /** 读取设置（downloadsPath 等） */
  getSetting: (key: string) => string | undefined;
  /** 写入设置（设置 downloadsPath 默认下载路径） */
  setSetting: (key: string, value: string) => void;
  /** 用户数据目录绝对路径（默认下载目录的父目录） */
  getDataDir: () => string;
  /** 下载管理器（同步进度/状态） */
  downloadManager: DownloadManager;
}

/**
 * 安装下载挂钩（幂等：重复调用先移除旧监听）。
 * 需在 app ready 后、首次下载前调用。
 */
export function installWillDownload(deps: WillDownloadDeps): void {
  const ses = session.defaultSession;
  // 幂等：移除上一次安装的监听，避免热重载/重复初始化叠加
  ses.removeAllListeners('will-download');

  ses.on('will-download', (event, item) => {
    void handleDownload(event, item, deps);
  });

  log.info('will-download handler installed');
}

/** 单个下载的完整流程（异步：保存对话框 + 设默认询问）。 */
async function handleDownload(
  _event: Electron.Event,
  item: Electron.DownloadItem,
  deps: WillDownloadDeps,
): Promise<void> {
  const filename = item.getFilename() || 'download';
  const configured = deps.getSetting('downloadsPath');
  const defaultDir = join(deps.getDataDir(), DOWNLOADS_DIR);

  if (configured?.trim()) {
    // 已设置默认下载路径：直接保存，不询问
    item.setSavePath(join(configured.trim(), filename));
  } else {
    // 未设置：弹保存对话框（默认位置 = 数据目录/downloads/<文件名>）
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.SaveDialogOptions = {
      title: '保存文件',
      defaultPath: join(defaultDir, filename),
      buttonLabel: '保存',
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      item.cancel();
      return;
    }
    item.setSavePath(result.filePath);

    // 询问是否设为默认下载路径（DL1 决策：每次询问 + 可设默认）
    const dir = dirname(result.filePath);
    const askOptions: Electron.MessageBoxOptions = {
      type: 'question',
      title: '设为默认下载路径？',
      message: `下载位置：${dir}`,
      detail: '是否将此位置设为默认下载路径？设置后后续下载将直接保存到该目录，不再询问。',
      buttons: ['设为默认', '仅此一次'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: '设为默认下载路径',
      checkboxChecked: false,
    };
    const ask = win
      ? await dialog.showMessageBox(win, askOptions)
      : await dialog.showMessageBox(askOptions);
    if (ask.checkboxChecked || ask.response === 0) {
      deps.setSetting('downloadsPath', dir);
      log.info('default download path set', { dir });
    }
  }

  // 同步到 DownloadManager（收藏夹面板「下载」页展示）
  const download = deps.downloadManager.create({
    filename,
    url: item.getURL(),
    savePath: item.getSavePath(),
    totalBytes: item.getTotalBytes(),
    mimeType: item.getMimeType(),
  });

  item.on('updated', (_e, state) => {
    deps.downloadManager.update(download.id, {
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: state === 'interrupted' ? 'interrupted' : 'progressing',
    });
  });
  item.on('done', (_e, state) => {
    if (state === 'completed') {
      deps.downloadManager.update(download.id, {
        state: 'completed',
        receivedBytes: item.getReceivedBytes(),
      });
    } else {
      deps.downloadManager.update(download.id, {
        state: state === 'cancelled' ? 'cancelled' : 'interrupted',
      });
    }
  });
}
