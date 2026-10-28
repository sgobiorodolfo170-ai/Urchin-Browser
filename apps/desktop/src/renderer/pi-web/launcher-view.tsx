/**
 * pi 自研前端启动器视图（阶段 2，M2C 退役阶段 1 后的唯一入口）
 *
 * 职责：作为 pi 模块的入口——启动/停止/打开自研 pi-web-host 托管服务
 * （utilityProcess + HTTP 静态 + WebSocket + token 鉴权）。
 *
 * 设计依据：docs/pi-web-评估.md 阶段 2 / ADR-013。阶段 1（pi-web-ui）
 * 已于 M2C 整体退役。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import {
  Sparkles,
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

interface PiWebHostSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'error';
  url?: string;
  port?: number;
  pid?: number;
  lastError?: string;
}

export interface PiWebLauncherViewProps {
  readonly onOpenUrl: (url: string) => void;
  readonly autoStart?: boolean;
}

export function PiWebLauncherView({ onOpenUrl, autoStart = false }: PiWebLauncherViewProps) {
  const [snapshot, setSnapshot] = useState<PiWebHostSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useEffect;

  const refresh = useCallback(async () => {
    try {
      const s = (await window.urchin.invoke('piWebHost.status', {})) as PiWebHostSnapshot;
      setSnapshot(s);
    } catch (e) {
      setSnapshot({ state: 'error', lastError: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => undefined;
  }, [refresh]);

  useEffect(() => {
    if (snapshot?.state === 'starting') {
      const t = setInterval(() => void refresh(), 1_200);
      return () => clearInterval(t);
    }
    return () => undefined;
  }, [snapshot?.state, refresh]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.urchin.invoke('piWebHost.launch', {})) as { url: string };
      await refresh();
      onOpenUrl(res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [onOpenUrl, refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await window.urchin.invoke('piWebHost.stop', {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [refresh]);

  void autoStarted;
  void autoStart;

  const state = snapshot?.state ?? 'stopped';
  const running = state === 'running';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface p-8">
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-lg font-semibold text-text">pi · Urchin</h1>
        <p className="max-w-md text-center text-sm text-text-secondary">
          自研 pi 对话前端（utilityProcess 托管 + WebSocket + token 鉴权）。
          模型管理、思考过程、工具调用、会话记录，与浏览器主体完全隔离。
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          {state === 'starting' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          <span className="text-text-secondary">
            {state === 'stopped' && '服务未运行'}
            {state === 'starting' && '正在启动…'}
            {running && (
              <>
                运行中 · 端口 {snapshot?.port}
                {snapshot?.pid ? ` · PID ${snapshot.pid}` : ''}
              </>
            )}
            {state === 'error' && '启动失败'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!running ? (
            <Button onClick={() => void start()} disabled={busy || state === 'starting'}>
              <Play className="mr-1.5 h-4 w-4" />
              {state === 'error' ? '重试启动' : '启动 pi'}
            </Button>
          ) : (
            <>
              <Button onClick={() => snapshot?.url && onOpenUrl(snapshot.url)} disabled={busy}>
                <ExternalLink className="mr-1.5 h-4 w-4" />
                打开
              </Button>
              <Button variant="secondary" onClick={() => void stop()} disabled={busy}>
                <Square className="mr-1.5 h-4 w-4" />
                停止
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => void refresh()}
            aria-label="刷新状态"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {(error ?? snapshot?.lastError) && (
        <div className="flex max-w-lg items-start gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error ?? snapshot?.lastError}</span>
        </div>
      )}
    </div>
  );
}
