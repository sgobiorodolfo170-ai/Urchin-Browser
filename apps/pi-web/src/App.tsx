import { useCallback, useEffect, useState } from 'react';

/** 服务就绪信息（由 hello_ok 回填） */
interface ReadyInfo {
  readonly service: string;
  readonly version: string;
  readonly status: string;
}

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

/** 从当前页面 URL 解析 token（页面以 ?token=<...> 打开） */
function pageToken(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

/** 构造 WS 地址：http://127.0.0.1:<port> → ws://127.0.0.1:<port>/ws + token */
function wsUrl(): string {
  const token = pageToken();
  const wsBase = window.location.origin.replace(/^http/, 'ws');
  const sep = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${wsBase}/ws${sep}`;
}

/**
 * pi 阶段 2 前端骨架（M2A）。
 * 目标：验证「页面由自研托管服务加载 + WS 经 token 鉴权握手」整链路；
 * 对话 UI（流式/思考/工具卡片/会话管理）在 M2B 填充。
 */
export function App(): React.JSX.Element {
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [pongTs, setPongTs] = useState<number | null>(null);

  const connect = useCallback(() => {
    setConnState('connecting');
    setReady(null);
    const ws = new WebSocket(wsUrl());

    const timeout = window.setTimeout(() => {
      ws.close();
      setConnState('error');
    }, 5000);

    ws.onopen = () => {
      window.clearTimeout(timeout);
      setConnState('open');
      ws.send(JSON.stringify({ type: 'hello', client: 'urchin-pi-web' }));
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello_ok': {
          const svc = typeof msg.service === 'string' ? msg.service : '';
          const version = typeof msg.version === 'string' ? msg.version : '';
          const status = typeof msg.status === 'string' ? msg.status : '';
          setReady({ service: svc, version, status });
          break;
        }
        case 'pong': {
          const ts = typeof msg.ts === 'number' ? msg.ts : 0;
          setPongTs(ts);
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = () => {
      window.clearTimeout(timeout);
      setConnState('closed');
    };
    ws.onerror = () => {
      window.clearTimeout(timeout);
      setConnState('error');
    };

    return () => {
      window.clearTimeout(timeout);
      ws.close();
    };
  }, []);

  useEffect(() => connect(), [connect]);

  return (
    <main className="page">
      <h1>pi · Urchin（阶段 2 骨架）</h1>
      <section className="card">
        <div>
          <span className="label">连接状态</span>
          <span className={`badge badge-${connState}`}>{connState}</span>
        </div>
        {ready ? (
          <p>
            已握手：{ready.service} @ {ready.version}（{ready.status}）
          </p>
        ) : (
          <p>等待 hello_ok…</p>
        )}
      </section>
      <section className="card">
        <div className="row">
          <span className="label">心跳</span>
          <span className="badge badge-open">{pongTs !== null ? `pong@${pongTs}` : '—'}</span>
          <button type="button" onClick={() => void pingCurrent()}>
            发送 ping
          </button>
        </div>
      </section>
      <p className="hint">
        认证 token 取自页面地址栏（?token=…），服务端在首次请求时一并回写 HttpOnly Cookie。
      </p>
    </main>
  );

  function pingCurrent(): void {
    // 与集中连接的 WS 解耦：M2A 仅演示，真正复用时把 socket 提升为模块态。
    const ws = new WebSocket(wsUrl());
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (msg.type === 'pong') setPongTs(Number(msg.ts ?? 0));
      ws.close();
    };
  }
}
