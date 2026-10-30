/**
 * pi-web-host ↔ pi-web-ui 协议适配层（第一批扩展）
 *
 * 扩展：心跳 / 设置 / 文件浏览 / 模型管理 / 主题 / 命令 / 组件初始化空响应
 * 后续批次（终端/Git/SSH/插件等）在此基础追加。
 */

import type { UiMessage, UiState, UiContentBlock, UiModelInfo } from '../server/protocol';
import { applyTheme, type ThemeInfo } from './theme';

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

interface BridgeGoalStatus {
  conversationId: string | null;
  goal: string | null;
  reviewModel: string | null;
  maxRounds: number;
  locked: boolean;
  reviewing: boolean;
  round: number;
  status: string;
  verdict: 'pending' | 'pass' | 'fail' | 'blocked';
  wizard: {
    active: boolean;
    draft: string;
    model: string | null;
    step: number;
    maxSteps: number;
    status: string;
  };
  phase?: 'idle' | 'executing' | 'reviewing' | 'blocked';
}

function makeEmptyGoalStatus(): BridgeGoalStatus {
  return {
    conversationId: null,
    goal: null,
    reviewModel: null,
    maxRounds: 0,
    locked: false,
    reviewing: false,
    round: 0,
    status: '',
    verdict: 'pending',
    wizard: {
      active: false,
      draft: '',
      model: null,
      step: 0,
      maxSteps: 0,
      status: '',
    },
  };
}

/** UiSettingsState 全字段默认值（protocol.ts:3305）——空对象会导致组件访问 .length 崩溃 */
function makeDefaultSettings(): Record<string, unknown> {
  return {
    promptMode: 'append',
    customSystemPrompt: '',
    promptTemplate: '',
    promptOverrides: {},
    promptDisabled: [],
    toolPromptOverrides: {},
    disabledSkills: [],
    disabledExtensions: [],
    disabledAgentTools: [],
    disabledPluginTools: [],
    terminalToolsEnabled: true,
    terminalBash: false,
    terminalBashIdleMs: 0,
    terminalBashMaxForegroundMs: 0,
    toolWatchdogTimeoutMs: 0,
    readDirEnabled: true,
    bgAutoCleanupMin: 0,
    toolLazyLoading: false,
    codemodeMode: 'on',
    codemodeInlineBudget: 3000,
    editSoftEnabled: true,
    questionnaireEnabled: true,
    toolApprovalEnabled: true,
    approvalPolicy: { allowAll: false, categories: [] },
    approvalRules: [],
    parallelReminderEnabled: true,
    goalModeEnabled: true,
    thinkingWrap: true,
    toolsWrap: true,
    toolImagesEnabled: true,
    keepRecentMessages: 15,
    showForkedParentSessions: false,
    retainFinishedConversations: false,
    openRecentSessionOnProjectSwitch: true,
    skillsFullText: [],
    skillsCatalogMaxDesc: 250,
    skillsCatalogShowLocation: false,
    skillsCatalogBudget: 20000,
    visionBridgeEnabled: true,
    visionBridgeModel: null,
    visionBridgePromptMode: 'append',
    visionBridgePrompt: '',
    scmCommitMsgPromptMode: 'append',
    scmCommitMsgPrompt: '',
    planModePromptMode: 'append',
    planModePrompt: '',
    reviewPrompt: '',
    reviewDisabledSkills: [],
    disabledPlugins: [],
    uiLayout: {},
    effectiveSystemPrompt: '',
    promptSourceDefaults: {},
    toolsSchema: '',
    visionBridgeDefaultPrompt: '',
    scmCommitMsgDefaultPrompt: '',
    planModeDefaultPrompt: '',
    visionModels: [],
    skills: [],
    reviewSkills: [],
    extensions: [],
    presets: [],
    markersEnabled: false,
    disabledMarkers: [],
    markers: [],
    subagentTemplates: [],
    subagentDefaultModel: null,
    retryMaxAttempts: 6,
    softCapTokens: 0,
    softCapByModel: {},
    quickPhrases: [],
    quickPhrasesEnabled: true,
    minimalNewChat: false,
    preserveDraftAcrossConversations: false,
    quickPhrasesSeeded: true,
    subagentModels: [],
    subagentDefaultTemplates: [],
  };
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
  private readonly wsUrl: string;
  private state: BridgeState = makeDefaultState();
  private toolCalls: Map<string, { id: string; name: string; status: string }> = new Map();
  private settings: BridgeSettings = {};
  private goalStatus: BridgeGoalStatus = makeEmptyGoalStatus();
  private themeInfos: ThemeInfo[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  declare readyState: number;

  constructor(url: string | URL) {
    this.wsUrl = typeof url === 'string' ? url : url.toString();
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

  /** 主题跟随浏览器：监听 prefers-color-scheme 自动切换 pi-web 浅色/深色主题 */
  private initThemeFollowing(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    try {
      const u = new URL(this.wsUrl);
      const httpBase = `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
      const token = u.searchParams.get('token') ?? '';
      fetch(`${httpBase}/api/themes?token=${encodeURIComponent(token)}`)
        .then((res) => res.json())
        .then((data: unknown) => {
          const arr: ThemeInfo[] = Array.isArray(data)
            ? data
            : Array.isArray((data as { themes?: ThemeInfo[] }).themes)
              ? (data as { themes: ThemeInfo[] }).themes
              : [];
          this.themeInfos = arr;
          this.applySystemTheme();
        })
        .catch(() => {});
    } catch {
      /* URL 解析失败 */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => this.applySystemTheme());
  }

  private applySystemTheme(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) {
      applyTheme(null);
    } else {
      const light = this.themeInfos.find((t) => t.scheme === 'light');
      applyTheme(light?.id ?? 'latte');
    }
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
    // 命令面板（protocol.ts: commands {commands, path?} / slash_commands {commands}）
    this.dispatchSynthetic({ type: 'commands', commands: [] });
    this.dispatchSynthetic({ type: 'slash_commands', commands: [] });
    // 组件（protocol.ts: widgets {widgets} / statuses {statuses}）
    this.dispatchSynthetic({ type: 'widgets', widgets: [] });
    this.dispatchSynthetic({ type: 'statuses', statuses: [] });
    // 后台服务 / 定时任务（protocol.ts: bg_servers {servers} / scheduler_tasks {tasks}）
    this.dispatchSynthetic({ type: 'bg_servers', servers: [] });
    this.dispatchSynthetic({ type: 'scheduler_tasks', tasks: [] });
    this.dispatchSynthetic({ type: 'mcp_servers', servers: [] });
    // Git（protocol.ts: scm_data {reqId, kind, ok, files?, branches?, ...}）
    this.dispatchSynthetic({
      type: 'scm_data',
      reqId: 0,
      kind: 'status',
      ok: true,
      files: [],
      branches: [],
    });
    // Goal/Plan（protocol.ts: goal_status {status: GoalStatus}）
    this.dispatchSynthetic({ type: 'goal_status', status: this.goalStatus });
    // 会话（空列表，list_sessions 会更新）
    this.dispatchSynthetic({ type: 'sessions', sessions: [] });
    this.dispatchSynthetic({ type: 'projects', projects: [] });
    // 插件（protocol.ts: plugins {plugins, epoch} / plugin_catalog {entries, epoch}）
    this.dispatchSynthetic({ type: 'plugins', plugins: [], epoch: 0 });
    this.dispatchSynthetic({ type: 'plugin_catalog', entries: [], epoch: 0 });
    // 设置（UiSettingsState 全字段默认值 + 用户覆盖）
    this.dispatchSynthetic({
      type: 'settings_state',
      settings: { ...makeDefaultSettings(), ...this.settings },
    });
    // 模型配置（protocol.ts: models_config {providers} / providers_status {providers}）
    this.dispatchSynthetic({ type: 'models_config', providers: [] });
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
        this.initThemeFollowing();
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
        const rawSettings =
          typeof msg['settings'] === 'object' && msg['settings']
            ? (msg['settings'] as Record<string, unknown>)
            : {};
        this.dispatchSynthetic({
          type: 'settings_state',
          settings: { ...makeDefaultSettings(), ...rawSettings, ...this.settings },
        });
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
        this.ws.send(JSON.stringify(msg));
        break;

      // ── 设置：本地存储 + 同步到 pi-web-host（落盘） ──
      case 'get_settings':
        this.ws.send(JSON.stringify(msg));
        this.dispatchSynthetic({
          type: 'settings_state',
          settings: { ...makeDefaultSettings(), ...this.settings },
        });
        break;
      case 'set_settings': {
        const { type: _omit, ...rest } = msg;
        this.settings = { ...this.settings, ...rest };
        this.ws.send(
          JSON.stringify({
            type: 'set_settings',
            settings: { ...makeDefaultSettings(), ...this.settings },
          }),
        );
        this.dispatchSynthetic({
          type: 'settings_state',
          settings: { ...makeDefaultSettings(), ...this.settings },
        });
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
        this.dispatchSynthetic({ type: 'slash_commands', commands: [] });
        break;
      case 'check_update':
        this.dispatchSynthetic({
          type: 'update_status',
          current: '',
          latest: null,
          latestPublishedAt: null,
          upToDate: true,
        });
        break;
      case 'check_updates_all':
        this.dispatchSynthetic({
          type: 'update_status_all',
          items: [],
        });
        break;
      case 'scm_status':
        // 转发到 pi-web-host（git-ops.ts getGitStatus 返回真实 git 状态）
        this.ws.send(JSON.stringify(msg));
        break;
      case 'scm_stage':
      case 'scm_unstage':
      case 'scm_commit':
      case 'scm_branch':
        this.dispatchSynthetic({
          type: 'scm_data',
          reqId: 0,
          kind: 'status',
          ok: true,
          files: [],
          branches: [],
        });
        break;
      // ── 终端：转发到 pi-web-host（node-pty PTY） ──
      case 'terminal_create':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_kill':
      case 'rename_terminal':
        this.ws.send(JSON.stringify(msg));
        break;
      // ── 插件：转发到 pi-web-host（plugin-manager.ts） ──
      case 'plugins_reload':
      case 'plugin_install':
      case 'plugin_uninstall':
      case 'plugin_enable':
      case 'plugin_disable':
      case 'plugin_catalog_add':
      case 'plugin_catalog_remove':
        this.ws.send(JSON.stringify(msg));
        break;

      // ── Goal/Plan：host-bridge 维护状态（后端不支持 goal/review） ──
      case 'start_goal_wizard': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        this.goalStatus = {
          ...this.goalStatus,
          conversationId: this.state.conversationId || null,
          goal: text,
          phase: 'executing',
          status: '执行中',
          wizard: { ...this.goalStatus.wizard, active: false },
        };
        this.dispatchSynthetic({ type: 'goal_status', status: this.goalStatus });
        break;
      }

      // ── 工具审批：转发到 pi-web-host（后端 beforeToolCall 钩子等待 resolve） ──
      case 'tool_approval_response':
        this.ws.send(JSON.stringify(msg));
        break;

      // ── 技能市场：后端不支持，返回空目录（3-7） ──
      case 'fetch_skill_market':
        this.dispatchSynthetic({
          type: 'skill_market_result',
          ok: true,
          skills: [],
          repo: '',
        });
        break;
      case 'fetch_skill_content': {
        const skillId = typeof msg['skillId'] === 'string' ? msg['skillId'] : '';
        this.dispatchSynthetic({
          type: 'skill_content_result',
          ok: false,
          skillId,
          content: '',
          error: 'skill not found',
        });
        break;
      }

      // ── 会话操作：转发到后端 ──
      case 'fork_session':
      case 'delete_session':
        this.ws.send(JSON.stringify(msg));
        break;
      // edit_message = 新建会话 + 用编辑后文本提问
      case 'edit_message': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        this.ws.send(JSON.stringify({ type: 'new_session' }));
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

      // ── 未实现功能：忽略（不转发后端避免 unknown_type error） ──
      case 'steer':
      case 'follow_up':
      case 'set_workspace_roots':
      case 'present_files':
      case 'ask_user_question_response':
      case 'sandbox_create':
      case 'sandbox_remove':
      case 'worktree_create':
      case 'worktree_remove':
      case 'page_request':
      case 'mcp_manage':
      case 'dismiss_conversation':
      case 'rollback_session':
      case 'save_subagent_template':
      case 'delete_subagent_template':
      case 'dismiss_finished_subagents':
      // Canvas（pi 引擎不支持，忽略所有 canvas_* 操作）
      case 'canvas_list':
      case 'canvas_load':
      case 'canvas_save':
      case 'canvas_delete':
      case 'canvas_run_all':
      case 'canvas_run_node':
      case 'canvas_stop_node':
      case 'canvas_stop_all':
      case 'canvas_steer_node':
      case 'canvas_review_node':
      case 'canvas_reset_status':
      case 'canvas_cards':
      case 'canvas_card_delete':
      case 'canvas_get_log':
      case 'canvas_clear_log':
      // DSH（pi 引擎不提供 dsh_* 消息，忽略）
      case 'dsh_patches_list':
      case 'dsh_patches_rescan':
      case 'dsh_preset_apply':
      case 'dsh_permission_apply':
        break;

      default:
        // 其他消息——透传到 pi-web-host（后续批次逐步对接）
        this.ws.send(JSON.stringify(msg));
        break;
    }
  }
}
