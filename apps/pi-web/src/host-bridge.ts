/**
 * pi-web-host ↔ pi-web-ui 协议适配层（第一批扩展）
 *
 * 扩展：心跳 / 设置 / 文件浏览 / 模型管理 / 主题 / 命令 / 组件初始化空响应
 * 后续批次（终端/Git/SSH/插件等）在此基础追加。
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

interface BridgeSettings {
  autoReload?: boolean;
  thinkingLevel?: string;
  [key: string]: unknown;
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
  private settings: BridgeSettings = {};
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
      if (self.heartbeatTimer) clearInterval(self.heartbeatTimer);
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
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

  /** 启动心跳定时器（前端 use-chat.ts 期望 30s 间隔 heartbeat） */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.dispatchSynthetic({ type: 'heartbeat' });
    }, 30_000);
  }

  /** ready 后发送初始空响应（让前端各面板正常初始化） */
  private sendInitialEmpties(): void {
    // 命令面板
    this.dispatchSynthetic({ type: 'commands', commands: [] });
    this.dispatchSynthetic({ type: 'slash_commands', slashCommands: [] });
    // 组件
    this.dispatchSynthetic({ type: 'widgets', widgets: [] });
    this.dispatchSynthetic({ type: 'statuses', statuses: [] });
    this.dispatchSynthetic({ type: 'bg_servers', bgServers: [] });
    this.dispatchSynthetic({ type: 'scheduler_tasks', schedulerTasks: [] });
    this.dispatchSynthetic({ type: 'mcp_servers', servers: [] });
    // Git
    this.dispatchSynthetic({
      type: 'scm_data',
      scm: { changed: [], staged: [], branches: [], currentBranch: '' },
    });
    // Goal/Plan
    this.dispatchSynthetic({ type: 'goal_status', goal: null });
    // 会话（空列表，list_sessions 会更新）
    this.dispatchSynthetic({ type: 'sessions', sessions: [] });
    this.dispatchSynthetic({ type: 'projects', projects: [] });
    // 插件
    this.dispatchSynthetic({ type: 'plugins', plugins: [] });
    this.dispatchSynthetic({ type: 'plugin_catalog', catalog: [] });
    // 设置
    this.dispatchSynthetic({ type: 'settings_state', settings: this.settings });
    // 模型配置（空，list_models 会更新）
    this.dispatchSynthetic({ type: 'models_config', modelsConfig: [] });
    this.dispatchSynthetic({ type: 'providers_status', providers: [] });
    this.dispatchSynthetic({ type: 'provider_keys', keys: {} });
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
          this.state.cwd = typeof msg['cwd'] === 'string' ? msg['cwd'] : '';
        }
        this.sendSnapshot();
        this.startHeartbeat();
        this.sendInitialEmpties();
        this.ws.send(JSON.stringify({ type: 'list_models' }));
        this.ws.send(JSON.stringify({ type: 'list_sessions' }));
        this.ws.send(JSON.stringify({ type: 'list_files', path: '' }));
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
          models: providers.map((p: string) => ({
            id: p,
            name: p,
            provider: p,
            vision: false,
          })),
          loading: false,
        });
        break;
      }

      case 'session_list': {
        const sessions = Array.isArray(msg['sessions']) ? msg['sessions'] : [];
        this.dispatchSynthetic({
          type: 'conversations',
          conversations: sessions.map((s: Record<string, unknown>) => ({
            id: s['id'],
            cwd: '',
            name: s['firstMessage'] || s['id'],
            messageCount: s['messageCount'] || 0,
            created: Date.now(),
            modified: Date.now(),
            firstMessage: s['firstMessage'] || '',
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
        this.state.messages = msgs.map((m: Record<string, unknown>) => ({
          id: nextMsgId(typeof m['role'] === 'string' ? (m['role'] as string) : 'u'),
          role: typeof m['role'] === 'string' ? (m['role'] as string) : 'user',
          content: [
            {
              type: 'text',
              text: typeof m['content'] === 'string' ? (m['content'] as string) : '',
            },
          ],
          timestamp: Date.now(),
        }));
        this.state.streamingMessage = null;
        this.state.isStreaming = false;
        this.sendSnapshot();
        break;
      }

      case 'files': {
        // pi-web-host 返回的文件列表——直接透传
        this.dispatchSynthetic(msg);
        break;
      }

      case 'file_content': {
        this.dispatchSynthetic(msg);
        break;
      }

      case 'settings_state': {
        this.dispatchSynthetic(msg);
        break;
      }

      default:
        // 未知消息——透传（pi-web-host 可能直接返回 pi-web-ui 格式）
        if (type) this.dispatchSynthetic(msg);
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
        // 发送当前快照（pi-web-host 不维护 UiState，host-bridge 是权威源）
        this.sendSnapshot();
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

      // ── 文件操作：转发到 pi-web-host（utility 进程有 fs 访问） ──
      case 'list_files':
      case 'read_file':
      case 'file_search':
        this.ws.send(JSON.stringify(msg));
        break;

      // ── 设置：本地存储 + 同步到 pi-web-host ──
      case 'get_settings':
        this.dispatchSynthetic({ type: 'settings_state', settings: this.settings });
        break;
      case 'set_settings': {
        const newSettings = msg['settings'] as Record<string, unknown> | undefined;
        if (newSettings) {
          this.settings = { ...this.settings, ...newSettings };
        }
        this.dispatchSynthetic({ type: 'settings_state', settings: this.settings });
        break;
      }

      // ── 模型管理：转发到 pi-web-host ──
      case 'set_model':
      case 'cycle_model':
      case 'set_thinking_level':
        this.ws.send(JSON.stringify(msg));
        // 本地更新 model/thinkingLevel
        if (type === 'set_model' && typeof msg['model'] === 'string') {
          this.state.model = {
            ...this.state.model,
            id: msg['model'],
            name: msg['model'],
          } as UiModelInfo;
          this.sendSnapshot();
        }
        if (type === 'set_thinking_level' && typeof msg['level'] === 'string') {
          this.state.thinkingLevel = msg['level'];
          this.sendSnapshot();
        }
        break;

      // ── 不支持的功能：返回空响应，前端面板正常初始化但不操作 ──
      case 'list_commands':
        this.dispatchSynthetic({ type: 'commands', commands: [] });
        break;
      case 'get_commands':
        this.dispatchSynthetic({ type: 'slash_commands', slashCommands: [] });
        break;
      case 'check_update':
      case 'check_updates_all':
        // managed=true 时前端不发送；如果发了，返回空
        break;
      case 'scm_status':
      case 'scm_stage':
      case 'scm_unstage':
      case 'scm_commit':
      case 'scm_branch':
        this.dispatchSynthetic({
          type: 'scm_data',
          scm: { changed: [], staged: [], branches: [], currentBranch: '' },
        });
        break;
      case 'terminal_create':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_restart':
        // 终端不支持——忽略（前端面板会显示但无法创建终端）
        break;
      case 'plugin_install':
      case 'plugin_uninstall':
      case 'plugin_enable':
      case 'plugin_disable':
        this.dispatchSynthetic({ type: 'plugins', plugins: [] });
        break;

      default:
        // 其他消息——透传到 pi-web-host（后续批次逐步对接）
        this.ws.send(JSON.stringify(msg));
        break;
    }
  }
}
