import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostClientMessage, HostServerMessage, SessionSummary } from './protocol';

interface ReadyInfo {
  readonly service: string;
  readonly version: string;
  readonly provider?: string;
  readonly model?: string;
}

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly streaming?: boolean;
}

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

function pageToken(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('token');
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

function wsUrl(): string {
  const token = pageToken();
  const wsBase = window.location.origin.replace(/^http/, 'ws');
  const sep = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${wsBase}/ws${sep}`;
}

let msgIdCounter = 0;
const nextMsgId = (): string => `m-${++msgIdCounter}`;

export function App(): React.JSX.Element {
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [ready, setReady] = useState<ReadyInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [providers, setProviders] = useState<readonly string[]>([]);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const currentAssistantRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    setConnState('connecting');
    setReady(null);
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

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
      let msg: HostServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as HostServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'hello_ok': {
          const svc = typeof msg.service === 'string' ? msg.service : '';
          const version = typeof msg.version === 'string' ? msg.version : '';
          const provider = typeof msg.provider === 'string' ? msg.provider : undefined;
          const model = typeof msg.model === 'string' ? msg.model : undefined;
          setReady({ service: svc, version, provider, model });
          // 请求可用 provider 列表 + 历史会话
          ws.send(JSON.stringify({ type: 'list_models' }));
          ws.send(JSON.stringify({ type: 'list_sessions' }));
          break;
        }
        case 'models': {
          const list = Array.isArray(msg.providers) ? msg.providers : [];
          setProviders(list);
          break;
        }
        case 'session_list': {
          setSessions(Array.isArray(msg.sessions) ? msg.sessions : []);
          break;
        }
        case 'session_created': {
          setCurrentSessionId(typeof msg.sessionId === 'string' ? msg.sessionId : '');
          setMessages([]);
          // 刷新会话列表
          ws.send(JSON.stringify({ type: 'list_sessions' }));
          break;
        }
        case 'session_switched': {
          setCurrentSessionId(typeof msg.sessionId === 'string' ? msg.sessionId : '');
          const loadedMsgs = Array.isArray(msg.messages) ? msg.messages : [];
          setMessages(
            loadedMsgs.map((m: { role: 'user' | 'assistant'; content: string }) => ({
              id: nextMsgId(),
              role: m.role,
              content: m.content,
            })),
          );
          break;
        }
        case 'state': {
          if (typeof msg.streaming === 'boolean' && !msg.streaming) {
            setStreaming(false);
          }
          break;
        }
        case 'stream.chunk': {
          const content = typeof msg.content === 'string' ? msg.content : '';
          setMessages((prev) => {
            const id = currentAssistantRef.current;
            if (!id) return prev;
            return prev.map((m) => (m.id === id ? { ...m, content: m.content + content } : m));
          });
          break;
        }
        case 'stream.end': {
          const id = currentAssistantRef.current;
          currentAssistantRef.current = null;
          setStreaming(false);
          if (id) {
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
          }
          break;
        }
        case 'error': {
          const code = typeof msg.code === 'string' ? msg.code : 'unknown';
          const message = typeof msg.message === 'string' ? msg.message : '';
          if (streaming) {
            setStreaming(false);
            currentAssistantRef.current = null;
          }
          setMessages((prev) => [
            ...prev,
            { id: nextMsgId(), role: 'assistant', content: `[错误 ${code}] ${message}` },
          ]);
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

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || connState !== 'open') return;
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = { id: nextMsgId(), role: 'user', content: text };
    const assistantId = nextMsgId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };
    currentAssistantRef.current = assistantId;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setStreaming(true);

    const payload: HostClientMessage = { type: 'prompt', text };
    ws.send(JSON.stringify(payload));
  }, [input, streaming, connState]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'abort' }));
    setStreaming(false);
  }, []);

  const newSession = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'new_session' }));
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'switch_session', sessionId }));
  }, []);

  return (
    <main className="page">
      <header className="header">
        <h1>pi · Urchin（阶段 2）</h1>
        <span className={`badge badge-${connState}`}>{connState}</span>
        {ready && (
          <span className="hint">
            已握手 {ready.service} @ {ready.version}
            {ready.provider ? ` · ${ready.provider}` : ''}
            {ready.model ? ` / ${ready.model}` : ''}
          </span>
        )}
      </header>

      {ready && !ready.provider && (
        <div className="notice">
          未配置 AI Provider——请在 Urchin 设置中配置 apiKey / provider / model 后重启自研版
        </div>
      )}
      {providers.length > 0 && (
        <details className="providers-panel">
          <summary>可用 Providers（{providers.length}）</summary>
          <div className="providers-list">
            {providers.map((p) => (
              <span key={p} className="provider-chip">
                {p}
              </span>
            ))}
          </div>
        </details>
      )}

      <div className="body">
        <aside className="sidebar" aria-label="会话列表">
          <button
            type="button"
            className="btn-new-session"
            onClick={() => void newSession()}
            disabled={connState !== 'open'}
          >
            + 新建会话
          </button>
          {sessions.length === 0 ? (
            <p className="sidebar-empty">暂无历史会话</p>
          ) : (
            <ul className="session-list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => void switchSession(s.id)}
                  >
                    <span className="session-title">{s.firstMessage || s.id.slice(0, 19)}</span>
                    <span className="session-meta">{s.messageCount} 条</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="messages" aria-label="对话消息列表">
          {messages.length === 0 ? (
            <p className="placeholder">输入消息开始对话…</p>
          ) : (
            messages.map((m) => (
              <article key={m.id} className={`msg msg-${m.role}`}>
                <span className="msg-role">{m.role === 'user' ? '你' : 'pi'}</span>
                <pre className="msg-content">{m.content || (m.streaming ? '…' : '')}</pre>
              </article>
            ))
          )}
        </section>
      </div>

      <footer className="composer">
        <textarea
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
          rows={2}
          disabled={connState !== 'open'}
        />
        {streaming ? (
          <button type="button" className="btn-stop" onClick={() => void abort()}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="btn-send"
            onClick={() => void send()}
            disabled={!input.trim() || connState !== 'open'}
          >
            发送
          </button>
        )}
      </footer>
    </main>
  );
}
