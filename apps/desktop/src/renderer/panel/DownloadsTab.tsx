/**
 * 下载 tab（P2 Session 4：自 bookmark-panel.ts 内联脚本迁移）
 *
 * 进度条 + 已下载/总大小 + 实时速度（500ms 轮询采样 EMA 平滑）+ completed
 * 状态「📂 在文件夹中显示」按钮（download.showInFolder）。
 *
 * 轮询语义（与原实现一致）：
 * - 间隔 DOWNLOAD_POLL_MS = 500ms（不随拉取耗时漂移）；
 * - 仅在本 tab 激活期间运行（原 loadTab → stopDownloadPolling）；
 * - 进入本 tab 且列表非空时才启动（原 rebuildDownloadList 的启动条件；
 *   空列表不轮询，轮询一旦启动持续到切离本 tab，即使列表变空）；
 * - 速度采样每次轮询恰好一次（原 tickSpeed 在 downloadMetaText 中调用的时机），
 *   采样与平滑值存 ref：跨 tab 切换保留（原 downloadSamples/downloadSpeeds）。
 *
 * 原实现的「增量更新 DOM（updateDownloadRows）避免闪烁/丢失 hover」在 React 下
 * 由协调机制天然获得：同 key 行仅原地更新文本/宽度属性，不重建节点。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadItem, DownloadListRes, DownloadState } from '@urchin/ipc-contract';
import { invoke } from './panel-ipc';

/** 下载进度轮询间隔（原 DOWNLOAD_POLL_MS，约束：不得改变） */
const DOWNLOAD_POLL_MS = 500;
/** EMA 平滑系数（原 tickSpeed：prevSpeed * 0.5 + inst * 0.5，约束：不得改变） */
const EMA_ALPHA = 0.5;

const ICON_DOWNLOAD = '⬇';

const DOWNLOAD_STATE_TEXT: Record<DownloadState, string> = {
  completed: '已完成',
  progressing: '下载中',
  paused: '已暂停',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** 上一轮采样：id → { received, t }（速度 = Δbytes / Δms） */
type DownloadSamples = Record<string, { received: number; t: number }>;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * 速度采样（EMA 平滑）：基于上一轮 receivedBytes 计算瞬时速度后与历史值平均
 * （原 tickSpeed 的纯函数化：samples/speeds 由调用方持有）。
 */
function tickSpeed(
  samples: DownloadSamples,
  speeds: Record<string, number>,
  id: string,
  received: number,
): number {
  const now = Date.now();
  const prev = samples[id];
  samples[id] = { received, t: now };
  const lastSpeed = speeds[id] ?? 0;
  if (!prev) return lastSpeed;
  const dt = now - prev.t;
  if (dt <= 0) return lastSpeed;
  const inst = Math.max(0, ((received - prev.received) * 1000) / dt);
  const smoothed = lastSpeed > 0 ? lastSpeed * EMA_ALPHA + inst * (1 - EMA_ALPHA) : inst;
  speeds[id] = smoothed;
  return smoothed;
}

/** 进度百分比：completed=100；未知总量=-1（不定进度动画） */
function downloadPercent(d: DownloadItem): number {
  if (d.state === 'completed') return 100;
  if (!d.totalBytes || d.totalBytes <= 0) return -1;
  return Math.min(100, (d.receivedBytes / d.totalBytes) * 100);
}

/** 元信息行：状态 + 大小（progressing 附加实时速度，速度为 0 时显示 …） */
function downloadMetaText(d: DownloadItem, speed: number | undefined): string {
  const state = DOWNLOAD_STATE_TEXT[d.state] ?? d.state;
  if (d.state === 'progressing' || d.state === 'paused') {
    const size =
      d.totalBytes > 0
        ? `${formatBytes(d.receivedBytes)} / ${formatBytes(d.totalBytes)}`
        : formatBytes(d.receivedBytes);
    return size + (d.state === 'progressing' ? ` · ${formatSpeed(speed ?? 0) || '…'}` : '');
  }
  if (d.state === 'completed') {
    return `${state} · ${formatBytes(d.totalBytes || d.receivedBytes)}`;
  }
  return state;
}

/** 一次轮询的渲染快照（速度为本次采样结果，渲染期不再调用 tickSpeed） */
interface DownloadsSnapshot {
  items: DownloadItem[];
  /** 本次采样得到的速度：id → bytes/s（仅 progressing 项有值） */
  speeds: Record<string, number>;
}

export function DownloadsTab({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<DownloadsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const samplesRef = useRef<DownloadSamples>({});
  const speedsRef = useRef<Record<string, number>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 轮询定时器引用的刷新函数（保持 setInterval 句柄稳定，不随 refresh 重建） */
  const refreshRef = useRef<() => Promise<void>>();

  const startPolling = useCallback((): void => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void refreshRef.current?.();
    }, DOWNLOAD_POLL_MS);
  }, []);

  const stopPolling = useCallback((): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** 拉取下载列表（原 renderDownloads）+ progressing 项速度采样 + 按需启动轮询 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await invoke<DownloadListRes>('download.list', {});
      const items = res.downloads ?? [];
      const speeds: Record<string, number> = {};
      for (const d of items) {
        if (d.state === 'progressing') {
          speeds[d.id] = tickSpeed(samplesRef.current, speedsRef.current, d.id, d.receivedBytes);
        }
      }
      setError(null);
      setSnapshot({ items, speeds });
      // 原语义：rebuildDownloadList 仅在列表非空时 startDownloadPolling；
      // 已启动的轮询不因列表变空而停止（持续到切离本 tab）
      if (items.length > 0) startPolling();
    } catch (e) {
      setError(String(e));
    }
  }, [startPolling]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // 激活期管理：切入立即拉取；切离/卸载停止轮询（原 loadTab → stopDownloadPolling）
  useEffect(() => {
    if (!active) {
      stopPolling();
      return;
    }
    void refresh();
    return () => stopPolling();
  }, [active, refresh, stopPolling]);

  /** 行操作：暂停/恢复/取消/在文件夹中显示（原 bindDownloadActions；show 后不刷新） */
  const doAction = useCallback(
    async (act: string, id: string): Promise<void> => {
      try {
        if (act === 'pause') await invoke('download.pause', { id });
        else if (act === 'resume') await invoke('download.resume', { id });
        else if (act === 'cancel') await invoke('download.cancel', { id });
        else if (act === 'show') await invoke('download.showInFolder', { id });
        if (act !== 'show') await refresh();
      } catch {
        /* 忽略：操作失败保持现状 */
      }
    },
    [refresh],
  );

  const clearFinished = useCallback(async (): Promise<void> => {
    try {
      await invoke('download.clear', {});
      await refresh();
    } catch {
      /* ignore */
    }
  }, [refresh]);

  if (error) {
    return <div className="empty">加载失败：{error}</div>;
  }
  if (!snapshot) {
    return <div className="empty">加载中…</div>;
  }
  if (snapshot.items.length === 0) {
    return <div className="empty">暂无下载记录</div>;
  }

  return (
    <>
      <div id="dl-list">
        {snapshot.items.map((d) => {
          const pct = downloadPercent(d);
          const indeterminate = d.state === 'progressing' && pct < 0;
          return (
            <div
              className={'item dl-item' + (indeterminate ? ' indeterminate' : '')}
              data-id={d.id}
              key={d.id}
            >
              <span className="icon">{ICON_DOWNLOAD}</span>
              <div className="main">
                <div className="title">{d.filename}</div>
                <div className="url dl-meta">{downloadMetaText(d, snapshot.speeds[d.id])}</div>
                {(d.state === 'progressing' || d.state === 'paused') && (
                  <div className="progress-bar">
                    <div
                      className="progress-bar-fill"
                      style={pct >= 0 ? { width: `${pct.toFixed(1)}%` } : undefined}
                    />
                  </div>
                )}
              </div>
              <div className="dl-actions">
                {d.state === 'progressing' && (
                  <button
                    data-act="pause"
                    data-id={d.id}
                    onClick={() => void doAction('pause', d.id)}
                  >
                    暂停
                  </button>
                )}
                {d.state === 'paused' && (
                  <button
                    data-act="resume"
                    data-id={d.id}
                    onClick={() => void doAction('resume', d.id)}
                  >
                    恢复
                  </button>
                )}
                {(d.state === 'progressing' || d.state === 'paused') && (
                  <button
                    data-act="cancel"
                    data-id={d.id}
                    onClick={() => void doAction('cancel', d.id)}
                  >
                    取消
                  </button>
                )}
                {d.state === 'completed' && (
                  <button
                    data-act="show"
                    data-id={d.id}
                    title="在文件夹中显示"
                    onClick={() => void doAction('show', d.id)}
                  >
                    📂
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="clear-row">
        <button id="clear-downloads" onClick={() => void clearFinished()}>
          清空已结束的下载
        </button>
      </div>
    </>
  );
}
