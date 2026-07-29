/**
 * M23 Download Manager · 模块入口
 *
 * 依据：04-模块全景 M23 / 契约 B §3.1 download.* 通道
 */
export { DownloadManager } from './download-manager';
export type { DownloadPatch } from './download-manager';
export { registerDownloadHandlers } from './register-handlers';
export type {
  DownloadState,
  DownloadItem,
  DownloadCreateOptions,
  DownloadEvent,
  DownloadEventListener,
} from './types';
