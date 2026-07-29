export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused';

export interface DownloadItem {
  readonly id: string;
  filename: string;
  url: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  savePath: string;
  readonly startTime: number;
  endTime?: number;
  mimeType?: string;
}

export interface DownloadCreateOptions {
  readonly filename: string;
  readonly url: string;
  readonly savePath: string;
  readonly totalBytes: number;
  readonly mimeType?: string;
}

export type DownloadEvent = 'created' | 'updated' | 'completed' | 'cancelled' | 'removed';
export type DownloadEventListener = (download: DownloadItem) => void;
