/**
 * pi 网页版启动器视图（阶段 1）· urchin://ai 标签页内容
 *
 * 职责：作为 pi 模块的入口——启动/停止/打开独立运行的 pi 网页
 * （社区包 pi-web-ui，系统 Node 子进程，http://127.0.0.1:<随机端口>）。
 *
 * 设计依据：docs/pi-web-评估.md 三阶段方案。旧对话视图 AiChatView 保留于
 * @urchin/ai-extension（回退时恢复 App.tsx 渲染即可）；阶段 2 将以自研
 * 「匹配官方」的 pi Web 前端替换本入口指向的目标。
 *
 * 首次运行展示第三方代码来源说明（对齐 IP8 精神：第三方能力需用户知情）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import {
  Sparkles,
  Play,
  Square,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';

/** piWeb.status 返回快照（与 ipc-contract PiWebStatusRes 对齐） */
interface PiWebSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'error';
  url?: string;
  port?: number;
  pid?: number;
  lastError?: string;
}

/** 首次运行说明的本地确认标记（仅渲染进程 UI 状态，不落设置） */
const NOTICE_ACK_KEY = 'urchin.pi-web.notice-ack-v1';

export interface PiWebLauncherViewProps {
  /** 打开 pi 网页（App 层新开标签页加载 URL） */
  readonly onOpenUrl: (url: string) => void;
  /**
   * 一键直达（dev.39 用户决策）：入口按钮点开即自动启动（无需再点「启动」按钮）。
   * 首次运行仍需经第三方来源说明确认（「我已知晓」后立即自动启动）。
   */
  readonly autoStart?: boolean;
}

export function PiWebLauncherView({ onOpenUrl, autoStart = false }: PiWebLauncherViewProps) {
  const [snapshot, setSnapshot] = useState<PiWebSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(
    () => localStorage.getItem(NOTICE_ACK_KEY) !== '1',
  );
  /** 第三方来源说明是否已确认（autoStart 的放行条件） */
  const [noticeAcked, setNoticeAcked] = useState(
    () => localStorage.getItem(NOTICE_ACK_KEY) === '1',
  );
  /** autoStart 是否已触发过（每次挂载只自动启动一次，避免 error 后死循环重启） */
  const autoStartedRef = useRef(false);
  /** 轮询定时器（starting 期间 1.2s 查一次状态） */
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = (await window.urchin.invoke('piWeb.status', {})) as PiWebSnapshot;
      setSnapshot(s);
    } catch (e) {
      setSnapshot({ state: 'error', lastError: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // 挂载即查询；starting 期间轮询直到进入终态
  useEffect(() => {
    void refreshStatus();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (snapshot?.state === 'starting') {
      pollTimer.current ??= setInterval(() => void refreshStatus(), 1_200);
    } else if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, [snapshot?.state, refreshStatus]);

  /** 启动（或复用已运行的）服务并打开网页 */
  const handleStart = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = (await window.urchin.invoke('piWeb.launch', {})) as {
        url: string;
        port: number;
      };
      await refreshStatus();
      onOpenUrl(res.url);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }, [onOpenUrl, refreshStatus]);

  /** 停止服务（终止子进程树） */
  const handleStop = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await window.urchin.invoke('piWeb.stop', {});
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshStatus();
      setBusy(false);
    }
  }, [refreshStatus]);

  // 一键直达：状态就绪 + 说明已确认 + 尚未触发过 → 自动启动（每次挂载一次）
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (snapshot?.state !== 'stopped') return;
    if (!noticeAcked || busy) return;
    autoStartedRef.current = true;
    void handleStart();
  }, [autoStart, snapshot, noticeAcked, busy, handleStart]);

  const state = snapshot?.state ?? 'stopped';
  const isRunning = state === 'running';
  const isStarting = state === 'starting';

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface p-8">
      {/* 标题 */}
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <h1 className="text-lg font-semibold text-text">pi 网页版</h1>
        <p className="max-w-md text-center text-sm text-text-secondary">
          在独立进程中运行的 pi 对话网页（模型管理、思考过程、工具调用、会话记录），
          与浏览器主体完全隔离。
        </p>
      </div>

      {/* 首次运行：第三方代码来源说明（IP8 精神） */}
      {noticeVisible && (
        <div className="flex max-w-lg items-start gap-3 rounded-lg border border-border bg-surface-secondary p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="flex flex-col gap-2 text-xs leading-relaxed text-text-secondary">
            <p>
              启动将运行第三方开源包{' '}
              <code className="rounded bg-surface px-1">pi-web-ui@0.47.0</code>
              （社区作者 xingshuyin，MIT 许可）——它在你的电脑上以本机权限运行 Node
              代码（含终端能力），服务仅监听本机回环地址（127.0.0.1）。 依赖审查记录见项目
              docs/pi-web-评估.md。
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="self-end"
              onClick={() => {
                localStorage.setItem(NOTICE_ACK_KEY, '1');
                setNoticeVisible(false);
                setNoticeAcked(true);
              }}
            >
              我已知晓
            </Button>
          </div>
        </div>
      )}

      {/* 状态与操作 */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          {isStarting && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          <span className="text-text-secondary">
            {state === 'stopped' && '服务未运行'}
            {isStarting && '正在启动…'}
            {isRunning && (
              <>
                运行中 · 端口 {snapshot?.port}
                {snapshot?.pid ? ` · PID ${snapshot.pid}` : ''}
              </>
            )}
            {state === 'error' && '启动失败'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!isRunning ? (
            <Button onClick={() => void handleStart()} disabled={busy || isStarting}>
              <Play className="mr-1.5 h-4 w-4" />
              {state === 'error' ? '重试启动' : '启动 pi 网页'}
            </Button>
          ) : (
            <>
              <Button onClick={() => snapshot?.url && onOpenUrl(snapshot.url)} disabled={busy}>
                <ExternalLink className="mr-1.5 h-4 w-4" />
                打开网页
              </Button>
              <Button variant="secondary" onClick={() => void handleStop()} disabled={busy}>
                <Square className="mr-1.5 h-4 w-4" />
                停止服务
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => void refreshStatus()}
            aria-label="刷新状态"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 错误信息 */}
      {(actionError ?? snapshot?.lastError) && (
        <div className="flex max-w-lg items-start gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-xs text-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{actionError ?? snapshot?.lastError}</span>
        </div>
      )}

      {/* 阶段 2：自研托管服务（双轨并存，docs/pi-web-评估.md 阶段 2） */}
      <PhaseTwoPanel onOpenUrl={onOpenUrl} />
    </div>
  );
}

// ============================================================================
// 阶段 2 · 自研托管服务面板
// ============================================================================

/** piWebHost.status 返回快照（与 ipc-contract PiWebHostStatusRes 对齐） */
interface PiWebHostSnapshot {
  state: 'stopped' | 'starting' | 'running' | 'error';
  url?: string;
  port?: number;
  pid?: number;
  lastError?: string;
}

interface PhaseTwoPanelProps {
  /** 打开服务 URL（App 层新开标签页） */
  readonly onOpenUrl: (url: string) => void;
}

function PhaseTwoPanel({ onOpenUrl }: PhaseTwoPanelProps) {
  const [snapshot, setSnapshot] = useState<PiWebHostSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [refresh]);

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

  const state = snapshot?.state ?? 'stopped';
  const running = state === 'running';

  return (
    <div className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-dashed border-border bg-surface-secondary/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">自研前端（阶段 2 · 试用）</h2>
        <span className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] text-primary">
          pi-web-host
        </span>
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">
        自研 <code className="rounded bg-surface px-1">apps/pi-web</code> +{' '}
        <code className="rounded bg-surface px-1">packages/pi-web-host</code> 的骨架预览
        （M2A）：HTTP 静态 + WebSocket + 随机 token 鉴权，运行于 Electron utilityProcess。
        会话/对话能力随 M2B 补充；阶段 1（pi-web-ui）届时整体退役。
      </p>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        {running ? (
          <>自研版运行中{snapshot?.port ? ` · 端口 ${snapshot.port}` : ''}</>
        ) : (
          <>自研版未运行</>
        )}
      </div>
      <div className="flex items-center gap-2">
        {!running ? (
          <Button size="sm" onClick={() => void start()} disabled={busy || state === 'starting'}>
            <Play className="mr-1.5 h-4 w-4" />
            {state === 'error' ? '重试启动' : '启动自研版'}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => snapshot?.url && onOpenUrl(snapshot.url)}
              disabled={busy}
            >
              <ExternalLink className="mr-1.5 h-4 w-4" />
              打开
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void stop()} disabled={busy}>
              <Square className="mr-1.5 h-4 w-4" />
              停止
            </Button>
          </>
        )}
      </div>
      {(error ?? snapshot?.lastError) && (
        <div className="break-all text-xs text-error">{error ?? snapshot?.lastError}</div>
      )}
    </div>
  );
}
