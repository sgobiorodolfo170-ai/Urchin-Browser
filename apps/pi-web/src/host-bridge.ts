/**
 * pi-web-host ↔ pi-web-ui 协议适配层
 *
 * pi-web-ui 前端期望快照驱动协议（ready → snapshot → snapshot_delta），
 * 我们的 pi-web-host 发送简单流式消息（hello_ok / stream.chunk / stream.end / tool_call）。
 * 本模块包装 WebSocket，维护合成 UiState，把我们的消息翻译成 pi-web-ui 格式。
 */

import type { UiMessage, UiState, UiContentBlock, UiModelInfo } from '../server/protocol';

interface BridgeState {
  rev: number;
  messages: UiMessage[];
  streamingMessage: UiMessage | null;
  isStreaming: boolean;
  conversationId: string;
  clientId: string;
  cwd: string;
  sessionId: string;
  model: UiModelInfo | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  queue: { steering: string[]; followUp: string[] };
  errorMessage?: string;
}

function makeDefaultState(): BridgeState {
  return {
    rev: 0,
    messages: [],
    streamingMessage: null,
    isStreaming: false,
    conversationId: '',
    clientId:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `c-${Date.now()}`,
    cwd: '',
    sessionId: '',
    model: null,
    thinkingLevel: 'auto',
    availableThinkingLevels: ['auto'],
    queue: { steering: [], followUp: [] },
  };
}

function toUiState(s: BridgeState): UiState {
  const base: Record<string, unknown> = {
    clientId: s.clientId,
    cwd: s.cwd,
    sessionId: s.sessionId,
    conversationId: s.conversationId,
    rev: s.rev,
    messages: s.messages,
    streamingMessage: s.streamingMessage,
    isStreaming: s.isStreaming,
    model: s.model,
    thinkingLevel: s.thinkingLevel,
    availableThinkingLevels: s.availableThinkingLevels,
    queue: s.queue,
  };
  if (s.errorMessage) base.errorMessage = s.errorMessage;
  return base as unknown as UiState;
}

let msgSeq = 0;
function nextMsgId(role: string): string {
  return `${role[0]}-${Date.now()}-${++msgSeq}`;
}

export class HostBridgeWebSocket {
  private ws: WebSocket;
  private state: BridgeState = makeDefaultState();
  private toolCalls: Map<string, { id: string; name: string; status: string }> = new Map();

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  declare readyState: number;

  constructor(url: string | URL) {
    this.ws = new WebSocket(url);
    const self = this;

    Object.defineProperty(this, 'readyState', {
      get() {
        return self.ws.readyState;
      },
    });

    this.ws.onopen = () => {
      self.ws.send(JSON.stringify({ type: 'hello', client: 'urchin-pi-web' }));
    };

    this.ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Record<
          string,
          unknown
        >;
      } catch {
        return;
      }
      self.handleHostMessage(msg);
    };

    this.ws.onclose = (ev) => {
      self.onclose?.(ev);
    };
    this.ws.onerror = (ev) => {
      self.onerror?.(ev);
    };
  }

  send(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.ws.send(data);
      return;
    }
    this.translateClientMessage(msg);
  }

  close(): void {
    this.ws.close();
  }

  private dispatchSynthetic(serverMsg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(serverMsg) } as MessageEvent);
  }

  private sendSnapshot(): void {
    this.state.rev++;
    const state = toUiState(this.state);
    this.dispatchSynthetic({ type: 'snapshot', state });
  }

  private handleHostMessage(msg: Record<string, unknown>): void {
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';
    switch (type) {
      case 'hello_ok': {
        const provider = typeof msg['provider'] === 'string' ? msg['provider'] : '';
        const model = typeof msg['model'] === 'string' ? msg['model'] : '';
        const version = typeof msg['version'] === 'string' ? msg['version'] : '';
        this.dispatchSynthetic({
          type: 'ready',
          engine: 'pi',
          protocolVersion: 37,
          appVersion: `pi-web-host ${version}`,
          serverVersion: version,
          managed: true,
          buildId: '',
          engineCapabilities: {},
          engines: [],
        });
        if (provider && model) {
          this.state.model = { id: model, name: model, provider, vision: false };
        }
        this.sendSnapshot();
        this.ws.send(JSON.stringify({ type: 'list_models' }));
        this.ws.send(JSON.stringify({ type: 'list_sessions' }));
        break;
      }
      case 'stream.chunk': {
        const content = typeof msg['content'] === 'string' ? msg['content'] : '';
        if (!content) break;
        if (!this.state.streamingMessage) {
          this.state.streamingMessage = {
            id: nextMsgId('a'),
            role: 'assistant',
            content: [{ type: 'text', text: content }],
            timestamp: Date.now(),
          };
        } else {
          const blocks = this.state.streamingMessage.content;
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') {
            (last as { text: string }).text += content;
          } else {
            blocks.push({ type: 'text', text: content });
          }
        }
        this.state.isStreaming = true;
        this.sendSnapshot();
        break;
      }
      case 'stream.end': {
        if (this.state.streamingMessage) {
          this.state.streamingMessage.stopReason =
            typeof msg['finishReason'] === 'string' ? msg['finishReason'] : 'stop';
          this.state.messages.push(this.state.streamingMessage);
          this.state.streamingMessage = null;
        }
        this.state.isStreaming = false;
        this.sendSnapshot();
        break;
      }
      case 'tool_call': {
        const toolName = typeof msg['toolName'] === 'string' ? msg['toolName'] : '';
        const status = typeof msg['status'] === 'string' ? msg['status'] : 'start';
        const toolId = `t-${toolName}-${this.toolCalls.size}`;
        if (status === 'start') {
          this.toolCalls.set(toolName, { id: toolId, name: toolName, status });
          if (!this.state.streamingMessage) {
            this.state.streamingMessage = {
              id: nextMsgId('a'),
              role: 'assistant',
              content: [],
              timestamp: Date.now(),
            };
          }
          this.state.streamingMessage.content.push({
            type: 'toolCall',
            id: toolId,
            name: toolName,
          } as UiContentBlock);
          this.state.messages.push({
            id: nextMsgId('t'),
            role: 'toolResult',
            content: [{ type: 'text', text: '执行中…' }],
            toolCallId: toolId,
            toolName,
          });
        } else {
          const existing = this.toolCalls.get(toolName);
          if (existing) {
            existing.status = status;
            const rm = this.state.messages.find((m) => m.toolCallId === existing.id);
            if (rm) {
              rm.isError = status === 'error';
              const tb = rm.content[0];
              if (tb && tb.type === 'text') {
                (tb as { text: string }).text = status === 'error' ? '失败' : '完成';
              }
            }
          }
        }
        this.sendSnapshot();
        break;
      }
      case 'error': {
        const code = typeof msg['code'] === 'string' ? msg['code'] : 'unknown';
        const message = typeof msg['message'] === 'string' ? msg['message'] : '';
        this.state.errorMessage = `[${code}] ${message}`;
        this.state.isStreaming = false;
        if (this.state.streamingMessage) {
          this.state.streamingMessage.stopReason = 'error';
          this.state.streamingMessage.errorMessage = message;
          this.state.messages.push(this.state.streamingMessage);
          this.state.streamingMessage = null;
        }
        this.sendSnapshot();
        break;
      }
      case 'models': {
        const providers = Array.isArray(msg['providers']) ? msg['providers'] : [];
        this.dispatchSynthetic({
          type: 'models',
          models: providers.map((p) => ({ id: p, name: p, provider: p, vision: false })),
          providers: providers.map((p) => ({
            id: p,
            name: p,
            apiKeyEnvVar: '',
            supportsOAuth: false,
          })),
        });
        break;
      }
      case 'session_list': {
        const sessions = Array.isArray(msg['sessions']) ? msg['sessions'] : [];
        this.dispatchSynthetic({
          type: 'conversations',
          conversations: sessions.map((s) => ({
            id: s.id,
            cwd: '',
            name: s.firstMessage || s.id,
            messageCount: s.messageCount || 0,
            created: Date.now(),
            modified: Date.now(),
            firstMessage: s.firstMessage || '',
          })),
        });
        break;
      }
      case 'session_created': {
        const sid = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
        this.state.sessionId = sid;
        this.state.conversationId = sid;
        this.state.messages = [];
        this.state.streamingMessage = null;
        this.state.isStreaming = false;
        this.sendSnapshot();
        break;
      }
      case 'session_switched': {
        const sid = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
        const msgs = Array.isArray(msg['messages']) ? msg['messages'] : [];
        this.state.sessionId = sid;
        this.state.conversationId = sid;
        this.state.messages = msgs.map((m) => ({
          id: nextMsgId(typeof m.role === 'string' ? m.role : 'u'),
          role: typeof m.role === 'string' ? m.role : 'user',
          content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }],
          timestamp: Date.now(),
        }));
        this.state.streamingMessage = null;
        this.state.isStreaming = false;
        this.sendSnapshot();
        break;
      }
      default:
        break;
    }
  }

  private translateClientMessage(msg: Record<string, unknown>): void {
    const type = typeof msg['type'] === 'string' ? msg['type'] : '';
    switch (type) {
      case 'hello':
        break;
      case 'prompt': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) {
          this.state.messages.push({
            id: nextMsgId('u'),
            role: 'user',
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
          });
          this.sendSnapshot();
          this.ws.send(JSON.stringify({ type: 'prompt', text }));
        }
        break;
      }
      case 'abort':
        this.ws.send(JSON.stringify({ type: 'abort' }));
        break;
      case 'list_models':
        this.ws.send(JSON.stringify({ type: 'list_models' }));
        break;
      case 'get_state':
        break;
      case 'new_chat':
      case 'new_session':
        this.ws.send(JSON.stringify({ type: 'new_session' }));
        break;
      case 'switch_conversation':
      case 'switch_session': {
        const sid = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
        if (sid) this.ws.send(JSON.stringify({ type: 'switch_session', sessionId: sid }));
        break;
      }
      default:
        this.ws.send(JSON.stringify(msg));
        break;
    }
  }
}
