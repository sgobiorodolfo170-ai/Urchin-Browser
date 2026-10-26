/**
 * M15 DevTools · 检视会话管理器（主进程）
 *
 * 依据：契约 G §3-§9 / 实施规划 §4 §6 §7 §8。
 * 职责：
 * 1. 按 tabId 维护 CDP 会话（attach/detach/状态机）
 * 2. 采集 Network/Console 事件 → 聚合为 NetworkEntry/ConsoleEntry
 * 3. 环形缓冲（Console 1000 条；Network 按 requestId 索引 + FIFO 容量）
 * 4. 200ms 批合并推送（边缘触发：空闲零消息；detach 前 flush 尾批）
 * 5. list/clear/evaluate RPC 业务逻辑
 * 6. 自动清理：tab removed、webContents destroyed、debugger 被抢占、app quit
 *
 * 设计理由（agents.md §七.2 + §六 进程隔离/隐私）：
 * - 依赖注入 tabManager（取 webContents）+ notify（事件推送回调），核心逻辑可单测
 * - URL/标题/控制台文本/请求头不进 INFO 日志（隐私审查点），仅记录计数与状态
 * - 状态机：detached | attached | unavailable（attach 同步，无 attaching 瞬态）
 * - 会话绑定 tabId，不随切标签漂移（DT12）；切标签不产生 attach/detach 抖动
 */
import { createLogger } from '@urchin/logger';
import type {
  NetworkEntry,
  ConsoleEntry,
  DevtoolsState,
  DevtoolsUnavailableReason,
  DevtoolsTarget,
  DevtoolsEventPayload,
} from '@urchin/ipc-contract';
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import { RingBuffer } from './ring-buffer';
import { TabCdpClient, type DebuggerResolver } from './cdp-client';

const log = createLogger('devtools');

/** 环形缓冲容量（DT7：1000 条）。 */
const BUFFER_CAPACITY = 1000;
/** 批合并间隔（DT7：200ms）。 */
const FLUSH_INTERVAL_MS = 200;
/** 文本字段截断上限（URL/console text/exception description）。 */
const MAX_TEXT_BYTES = 8192;
/** 响应头累计字节上限（剔除 Set-Cookie 后）。 */
const MAX_HEADERS_BYTES = 16 * 1024;
/** evaluate 结果序列化截断上限。 */
const MAX_RESULT_BYTES = 256 * 1024;

/**
 * 截断字符串到指定字节数（UTF-8 字节计数；多字节字符不在中间切断，
 * 超出在末尾加「…(truncated)」）。
 * 纯函数，可单测。
 */
export function truncateText(text: string, maxBytes: number = MAX_TEXT_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // UTF-8 安全截断：若截断点落在多字节字符中间，回退到上一个完整字符边界
  let cut = maxBytes;
  // UTF-8 起始字节高位为 0xxxxxxx(0) 或 11xxxxxx(>=0xC0)；续字节为 10xxxxxx(0x80-0xBF)
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
  return buf.subarray(0, cut).toString('utf8') + '…(truncated)';
}

/**
 * 规整响应头：剔除 Set-Cookie（隐私 + 体量），累计字节超限截断。
 * 纯函数，可单测。
 */
export function sanitizeHeaders(headers: Record<string, string> | undefined): {
  headers?: Record<string, string>;
  truncated?: boolean;
} {
  if (!headers) return {};
  const out: Record<string, string> = {};
  let bytes = 0;
  let truncated = false;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') continue; // 隐私：Cookie 不属页面调试信息
    const entryBytes = Buffer.from(key, 'utf8').length + Buffer.from(value, 'utf8').length + 2;
    if (bytes + entryBytes > MAX_HEADERS_BYTES) {
      truncated = true;
      break;
    }
    out[key] = value;
    bytes += entryBytes;
  }
  return { headers: out, truncated };
}

/**
 * 格式化 Runtime.consoleAPICalled 的 args 为可读文本。
 * RemoteObject 取 value（by-value 原始类型）或 description（对象）。
 * 纯函数，可单测。
 */
export function formatConsoleApiArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (arg === null || typeof arg !== 'object') {
      // 上方 guard 已排除 object/null，arg 此处为原始类型；String() 安全
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      return arg === undefined ? 'undefined' : String(arg);
    }
    const obj = arg as { value?: unknown; description?: string; type?: string; subtype?: string };
    if (obj.value !== undefined) {
      return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
    }
    if (obj.description !== undefined) return obj.description;
    if (obj.subtype === 'null') return 'null';
    return `<${obj.type ?? 'object'}>`;
  });
  return truncateText(parts.join(' '));
}

/** 单个 tab 的检视会话（主进程持有，含 CDP 客户端与采集状态）。 */
interface TabDevtoolsSession {
  readonly tabId: number;
  client: TabCdpClient;
  state: DevtoolsState;
  target: DevtoolsTarget;
  /** Network：requestId → 条目最新态（去重合并多次状态演进） */
  networkIndex: Map<string, NetworkEntry>;
  /** Network：requestId 插入序（FIFO 容量淘汰） */
  networkOrder: string[];
  networkDropped: number;
  /** 自上次 flush 以来被更新的 requestId（脏集） */
  networkDirty: Set<string>;
  /** Console：FIFO 环形缓冲 */
  consoleBuffer: RingBuffer<ConsoleEntry>;
  /** 自上次 flush 以来新增的 console 条目（待推送） */
  consolePending: ConsoleEntry[];
  /** 会话内单调递增 seq */
  networkSeq: number;
  consoleSeq: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** Manager 依赖（依赖注入，便于单测）。 */
export interface DevtoolsManagerOptions {
  readonly tabManager: TabManager;
  /** 事件推送回调（manager 调用 → 主进程 sendToMainWindow）。 */
  readonly notify: (payload: DevtoolsEventPayload) => void;
  /** debugger 解析器（默认走真实 Electron；测试注入 mock）。 */
  readonly resolveDebugger?: DebuggerResolver;
}

/** attach/detach/status 的统一返回形状（与 ipc schema 对齐）。 */
export interface DevtoolsStatusResult {
  state: DevtoolsState;
  reason?: DevtoolsUnavailableReason;
  target?: DevtoolsTarget;
}

/**
 * DevTools 检视会话管理器。
 *
 * 一个 tabId 至多一个会话（幂等 attach）；内部页/genoffice 标签拒绝检视。
 */
export class DevtoolsManager {
  private readonly sessions = new Map<number, TabDevtoolsSession>();
  private readonly opts: DevtoolsManagerOptions & { resolveDebugger: DebuggerResolver };
  private disposed = false;
  /** tab removed/crashed 自动清理订阅句柄（构造时挂、dispose 时卸）。 */
  private readonly unsubRemoved: () => void;
  private readonly unsubCrashed: () => void;

  constructor(options: DevtoolsManagerOptions) {
    this.opts = { resolveDebugger: defaultDebuggerResolverSafe, ...options };
    // tab 移除/崩溃 → 自动 detach 会话（webContents 已销毁，cdp-client.detach 防御性 catch）
    const onRemoved = (snapshot: TabSnapshot): void => {
      if (this.sessions.has(snapshot.id)) {
        this.removeSession(snapshot.id, 'target-closed');
      }
    };
    this.opts.tabManager.on('removed', onRemoved);
    this.opts.tabManager.on('crashed', onRemoved);
    this.unsubRemoved = () => this.opts.tabManager.off('removed', onRemoved);
    this.unsubCrashed = () => this.opts.tabManager.off('crashed', onRemoved);
  }

  /** 开始检视（幂等：已 attached 直接返回状态）。 */
  attach(tabId: number): DevtoolsStatusResult {
    const existing = this.sessions.get(tabId);
    if (existing?.state === 'attached') {
      return { state: 'attached', target: existing.target };
    }

    const tab = this.opts.tabManager.getTab(tabId);
    if (!tab) {
      return { state: 'unavailable', reason: 'target-closed' };
    }
    // DT10/genoffice：编辑器视图不提供页面级检视
    if (tab.viewKind === 'genoffice') {
      return { state: 'unavailable', reason: 'genoffice-tab' };
    }
    // 内部页（urchin://*）由主窗口 React 渲染，BrowserView 仅占位，无有意义的页面内容
    if (tab.url.startsWith('urchin://')) {
      return { state: 'unavailable', reason: 'internal-page' };
    }

    const target: DevtoolsTarget = { tabId, title: tab.title || tab.url };
    const client = new TabCdpClient(tab.webContents, this.opts.resolveDebugger);

    try {
      if (client.isAttached()) {
        return { state: 'unavailable', reason: 'already-attached' };
      }
      client.attach();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 'already-attached' 理论上 isAttached 已拦截；原生其他错误视为目标不可用
      log.warn('attach failed', { tabId, error: msg });
      return {
        state: 'unavailable',
        reason: msg === 'already-attached' ? 'already-attached' : 'target-closed',
      };
    }

    const session: TabDevtoolsSession = {
      tabId,
      client,
      state: 'attached',
      target,
      networkIndex: new Map(),
      networkOrder: [],
      networkDropped: 0,
      networkDirty: new Set(),
      consoleBuffer: new RingBuffer<ConsoleEntry>(BUFFER_CAPACITY),
      consolePending: [],
      networkSeq: 0,
      consoleSeq: 0,
      flushTimer: null,
    };

    client.onMessage((method, params) => this.handleCdpEvent(session, method, params));
    client.onDetach((reason) => {
      log.info('debugger detached externally', { tabId, reason });
      this.removeSession(tabId, reason.includes('cancel') ? 'already-attached' : 'target-closed');
    });

    // 异步启用采集域（不等待完成——会话已建立即可响应 evaluate；
    // enable 仅影响事件推送起点，enable 前的请求不可见，见已知限制）
    void client
      .send('Network.enable')
      .catch((e) => log.warn('Network.enable failed', { tabId, error: String(e) }));
    void client
      .send('Runtime.enable')
      .catch((e) => log.warn('Runtime.enable failed', { tabId, error: String(e) }));
    void client
      .send('Log.enable')
      .catch((e) => log.warn('Log.enable failed', { tabId, error: String(e) }));

    this.sessions.set(tabId, session);
    log.info('attached', { tabId });
    this.opts.notify({ type: 'state', tabId, state: 'attached', target });
    return { state: 'attached', target };
  }

  /** 停止检视（flush 尾批后 detach）。 */
  detach(tabId: number): { ok: true } {
    this.removeSession(tabId, undefined);
    return { ok: true };
  }

  /** 状态查询。 */
  status(tabId: number): DevtoolsStatusResult {
    const session = this.sessions.get(tabId);
    if (session) return { state: session.state, target: session.target };
    return { state: 'detached' };
  }

  /** 网络条目全量快照（无会话返回空数组，不报错）。 */
  listNetwork(tabId: number): { entries: NetworkEntry[]; dropped: number } {
    const session = this.sessions.get(tabId);
    if (!session) return { entries: [], dropped: 0 };
    const entries = session.networkOrder
      .map((rid) => session.networkIndex.get(rid)!)
      .filter(Boolean);
    return { entries, dropped: session.networkDropped };
  }

  /** 清空网络缓冲。 */
  clearNetwork(tabId: number): { ok: true } {
    const session = this.sessions.get(tabId);
    if (!session) return { ok: true };
    session.networkIndex.clear();
    session.networkOrder.length = 0;
    session.networkDirty.clear();
    this.opts.notify({ type: 'cleared', tabId, scope: 'network' });
    return { ok: true };
  }

  /** 控制台条目全量快照。 */
  listConsole(tabId: number): { entries: ConsoleEntry[]; dropped: number } {
    const session = this.sessions.get(tabId);
    if (!session) return { entries: [], dropped: 0 };
    return { entries: session.consoleBuffer.toArray(), dropped: session.consoleBuffer.dropped() };
  }

  /** 清空控制台缓冲。 */
  clearConsole(tabId: number): { ok: true } {
    const session = this.sessions.get(tabId);
    if (!session) return { ok: true };
    session.consoleBuffer.clear();
    session.consolePending.length = 0;
    this.opts.notify({ type: 'cleared', tabId, scope: 'console' });
    return { ok: true };
  }

  /** 执行表达式（Runtime.evaluate，returnByValue）。 */
  async evaluate(
    tabId: number,
    expression: string,
    awaitPromise?: boolean,
  ): Promise<{
    ok: boolean;
    result?: unknown;
    exception?: string;
    error?: string;
    truncated?: boolean;
  }> {
    const session = this.sessions.get(tabId);
    if (session?.state !== 'attached') {
      return { ok: false, error: 'not attached' };
    }
    try {
      const res =
        (await session.client.send<{
          result?: { value?: unknown; description?: string; type?: string; subtype?: string };
          exceptionDetails?: { exception?: { description?: string }; text?: string };
        }>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: awaitPromise ?? false,
        })) ?? {};
      if (res.exceptionDetails) {
        const exc =
          res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Exception';
        return { ok: false, exception: truncateText(exc) };
      }
      const value = res.result?.value;
      let serialized: string | undefined;
      let truncated = false;
      if (value !== undefined) {
        serialized = safeStringify(value);
        if (Buffer.from(serialized, 'utf8').length > MAX_RESULT_BYTES) {
          serialized = truncateText(serialized, MAX_RESULT_BYTES);
          truncated = true;
        }
      } else if (res.result?.description) {
        serialized = res.result.description;
      }
      // 返回原始 JSON 解析值（已截断则返回字符串），渲染层直接展示
      let result: unknown = value;
      if (truncated && serialized !== undefined) {
        result = serialized;
      } else if (serialized !== undefined && typeof value === 'object' && value !== null) {
        // 反序列化截断后的 JSON（保证渲染层拿到合法 JSON）
        try {
          result = JSON.parse(serialized);
        } catch {
          result = serialized;
        }
      }
      return { ok: true, result, truncated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('evaluate failed', { tabId, error: msg });
      return { ok: false, error: truncateText(msg) };
    }
  }

  /** 应用退出清理：detach 所有会话 + 卸载 tab 事件订阅。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tabId of [...this.sessions.keys()]) {
      this.removeSession(tabId, undefined);
    }
    this.unsubRemoved();
    this.unsubCrashed();
  }

  // ---- 内部：CDP 事件路由 ----

  private handleCdpEvent(session: TabDevtoolsSession, method: string, params: unknown): void {
    if (session.state !== 'attached') return;
    try {
      switch (method) {
        case 'Network.requestWillBeSent':
          this.onNetworkRequest(session, params);
          break;
        case 'Network.responseReceived':
          this.onNetworkResponse(session, params);
          break;
        case 'Network.loadingFinished':
          this.onNetworkFinished(session, params);
          break;
        case 'Network.loadingFailed':
          this.onNetworkFailed(session, params);
          break;
        case 'Runtime.consoleAPICalled':
          this.onConsoleApi(session, params);
          break;
        case 'Runtime.exceptionThrown':
          this.onException(session, params);
          break;
        case 'Log.entryAdded':
          this.onLogEntry(session, params);
          break;
        default:
          // 其余 CDP 事件本期不采集（DT10 能力集限定）
          break;
      }
    } catch (err) {
      log.warn('cdp event handler error', { tabId: session.tabId, method, error: String(err) });
    }
  }

  private onNetworkRequest(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      requestId: string;
      request?: { url?: string; method?: string };
      type?: string;
      timestamp?: number;
      wallTime?: number;
    };
    const requestId = p.requestId;
    const url = truncateText(p.request?.url ?? '');
    const seq = session.networkSeq++;
    const entry: NetworkEntry = {
      seq,
      requestId,
      url,
      method: p.request?.method ?? 'GET',
      resourceType: p.type,
      startedAt: Math.floor((p.wallTime ?? Date.now() / 1000) * 1000),
    };
    session.networkIndex.set(requestId, entry);
    session.networkOrder.push(requestId);
    this.evictIfFull(session);
    session.networkDirty.add(requestId);
    this.scheduleFlush(session);
  }

  private onNetworkResponse(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      requestId: string;
      response?: {
        status?: number;
        mimeType?: string;
        headers?: Record<string, string>;
      };
    };
    const entry = session.networkIndex.get(p.requestId);
    if (!entry) return;
    if (p.response?.status !== undefined) entry.status = p.response.status;
    if (p.response?.mimeType) entry.mimeType = p.response.mimeType;
    if (p.response?.headers) {
      const { headers, truncated } = sanitizeHeaders(p.response.headers);
      if (headers) {
        entry.responseHeaders = headers;
        if (truncated) entry.headersTruncated = true;
      }
    }
    session.networkDirty.add(p.requestId);
    this.scheduleFlush(session);
  }

  private onNetworkFinished(session: TabDevtoolsSession, params: unknown): void {
    const p = params as { requestId: string; encodedDataLength?: number; timestamp?: number };
    const entry = session.networkIndex.get(p.requestId);
    if (!entry) return;
    if (p.encodedDataLength !== undefined) entry.size = p.encodedDataLength;
    entry.finishedAt = Math.floor((p.timestamp ?? Date.now() / 1000) * 1000);
    entry.durationMs = entry.finishedAt - entry.startedAt;
    session.networkDirty.add(p.requestId);
    this.scheduleFlush(session);
  }

  private onNetworkFailed(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      requestId: string;
      errorText?: string;
      timestamp?: number;
      type?: string;
    };
    const entry = session.networkIndex.get(p.requestId);
    if (!entry) return;
    if (p.errorText) entry.errorText = truncateText(p.errorText);
    entry.finishedAt = Math.floor((p.timestamp ?? Date.now() / 1000) * 1000);
    entry.durationMs = entry.finishedAt - entry.startedAt;
    if (p.type) entry.resourceType = p.type;
    session.networkDirty.add(p.requestId);
    this.scheduleFlush(session);
  }

  private onConsoleApi(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      type?: string;
      args?: unknown[];
      timestamp?: number;
      stackTrace?: { callFrames?: unknown[] };
      executionContextId?: number;
    };
    // Runtime.consoleAPICalled 的 type: log/info/warning/error/debug/trace/dir/...
    const type = p.type ?? 'log';
    const level = mapConsoleType(type);
    const entry: ConsoleEntry = {
      seq: session.consoleSeq++,
      level,
      text: formatConsoleApiArgs(p.args ?? []),
      source: 'console-api',
      timestamp: Math.floor((p.timestamp ?? Date.now() / 1000) * 1000),
    };
    this.pushConsole(session, entry);
  }

  private onException(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string; subtype?: string };
        url?: string;
        lineNumber?: number;
        stackTrace?: { callFrames?: unknown[] };
      };
      timestamp?: number;
    };
    const d = p.exceptionDetails;
    if (!d) return;
    const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
    const entry: ConsoleEntry = {
      seq: session.consoleSeq++,
      level: 'error',
      text: truncateText(text),
      source: 'exception',
      url: d.url,
      lineNumber: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined,
      timestamp: Math.floor((p.timestamp ?? Date.now() / 1000) * 1000),
    };
    this.pushConsole(session, entry);
  }

  private onLogEntry(session: TabDevtoolsSession, params: unknown): void {
    const p = params as {
      entry?: {
        level?: string;
        text?: string;
        source?: string;
        url?: string;
        lineNumber?: number;
        stackTrace?: { callFrames?: unknown[] };
      };
      timestamp?: number;
    };
    const e = p.entry;
    if (!e) return;
    const source = e.source === 'network' ? 'network' : 'other';
    const entry: ConsoleEntry = {
      seq: session.consoleSeq++,
      level: mapLogLevel(e.level ?? 'info'),
      text: truncateText(e.text ?? ''),
      source,
      url: e.url,
      lineNumber: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined,
      timestamp: Math.floor((p.timestamp ?? Date.now() / 1000) * 1000),
    };
    this.pushConsole(session, entry);
  }

  private pushConsole(session: TabDevtoolsSession, entry: ConsoleEntry): void {
    session.consoleBuffer.push(entry);
    session.consolePending.push(entry);
    this.scheduleFlush(session);
  }

  // ---- 内部：容量淘汰 ----

  private evictIfFull(session: TabDevtoolsSession): void {
    while (session.networkOrder.length > BUFFER_CAPACITY) {
      const oldest = session.networkOrder.shift();
      if (oldest === undefined) break;
      session.networkIndex.delete(oldest);
      session.networkDirty.delete(oldest);
      session.networkDropped += 1;
    }
  }

  // ---- 内部：批合并推送（边缘触发定时器） ----

  private scheduleFlush(session: TabDevtoolsSession): void {
    if (session.flushTimer !== null) return;
    session.flushTimer = setTimeout(() => this.flush(session), FLUSH_INTERVAL_MS);
  }

  private flush(session: TabDevtoolsSession): void {
    session.flushTimer = null;
    if (this.disposed) return;
    const tabId = session.tabId;
    // Network：脏集聚合为最终态
    if (session.networkDirty.size > 0) {
      const entries: NetworkEntry[] = [];
      for (const rid of session.networkDirty) {
        const e = session.networkIndex.get(rid);
        if (e) entries.push({ ...e });
      }
      session.networkDirty.clear();
      if (entries.length > 0) {
        this.opts.notify({ type: 'network.batch', tabId, entries });
      }
    }
    // Console：待推送条目
    if (session.consolePending.length > 0) {
      const entries = session.consolePending;
      session.consolePending = [];
      this.opts.notify({ type: 'console.append', tabId, entries });
    }
  }

  // ---- 内部：会话移除 ----

  private removeSession(tabId: number, reason: DevtoolsUnavailableReason | undefined): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    // flush 尾批（detach 前保证数据完整，见 §6.3）
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    this.flush(session);
    session.client.detach();
    this.sessions.delete(tabId);
    const state: DevtoolsState = reason ? 'unavailable' : 'detached';
    log.info('detached', { tabId, state, reason });
    this.opts.notify({ type: 'state', tabId, state, reason, target: session.target });
  }
}

/** 默认 debugger 解析器（包装为安全版本，catch 解析异常）。 */
const defaultDebuggerResolverSafe: DebuggerResolver = (wc) => {
  return (wc as { debugger: import('./cdp-client').DebuggerLike }).debugger;
};

/** Runtime.consoleAPICalled type → ConsoleEntry level。 */
function mapConsoleType(type: string): ConsoleEntry['level'] {
  switch (type) {
    case 'error':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'log':
    default:
      return 'log';
  }
}

/** Log.entryAdded level → ConsoleEntry level。 */
function mapLogLevel(level: string): ConsoleEntry['level'] {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warning';
    case 'debug':
      return 'debug';
    case 'verbose':
      return 'debug';
    case 'info':
    default:
      return 'info';
  }
}

/** 安全 JSON 序列化（处理循环引用与大对象）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k: string, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    );
  } catch {
    return String(value);
  }
}
