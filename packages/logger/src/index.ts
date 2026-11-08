/**
 * @urchin/logger · 结构化日志
 *
 * 依据：02-架构设计 §7.5
 * - 四级日志（ERROR/WARN/INFO/DEBUG）
 * - 结构化 LogEntry（timestamp/level/module/message/meta/processId/sessionId）
 * - 隐私约束：不记录凭据；页面内容仅 DEBUG 级别且用户开启调试时记录
 */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

export interface LogEntry {
  readonly timestamp: string; // ISO 8601
  readonly level: LogLevel;
  readonly module: string;
  readonly message: string;
  readonly meta?: Record<string, unknown>;
  readonly processId: number;
  readonly sessionId: string;
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/** 日志落点签名（console / 文件 / 远程等）。 */
export type LogSink = (entry: LogEntry) => void;

/** 进程级额外落点注册表（默认 sink 转发；见 addLogSink）。 */
const extraSinks = new Set<LogSink>();

/** 进程级 sessionId：每次启动生成唯一 ID，便于关联多进程日志。 */
const SESSION_ID = generateSessionId();
const PROCESS_ID = typeof process !== 'undefined' ? process.pid : 0;

function generateSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建 Logger 实例。
 *
 * @param moduleName 模块名（如 'tab-manager' / 'ipc-server' / 'orchestrator'）
 * @param sink 日志输出函数（默认 console，生产环境可替换为文件 sink）
 *
 * 设计理由（AGENTS.md §七.2）：
 * 不直接用 console.log 是因为需要结构化字段（level/module/sessionId）
 * 与隐私过滤（凭据/页面内容）。Logger 把「格式化 + 过滤 + 输出」收口一处。
 */
export function createLogger(
  moduleName: string,
  sink: (entry: LogEntry) => void = defaultConsoleSink,
): Logger {
  const minLevel = resolveMinLevel();

  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (!shouldLog(level, minLevel)) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: moduleName,
      message: sanitizeMessage(msg),
      meta: meta ? sanitizeMeta(meta) : undefined,
      processId: PROCESS_ID,
      sessionId: SESSION_ID,
    };
    sink(entry);
  }

  return {
    error: (msg, meta) => emit('ERROR', msg, meta),
    warn: (msg, meta) => emit('WARN', msg, meta),
    info: (msg, meta) => emit('INFO', msg, meta),
    debug: (msg, meta) => emit('DEBUG', msg, meta),
  };
}

/** 从环境变量解析最低日志级别。 */
function resolveMinLevel(): LogLevel {
  const env = typeof process !== 'undefined' ? process.env?.URCHIN_LOG_LEVEL : undefined;
  const order: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
  const idx = order.indexOf((env?.toUpperCase() as LogLevel) ?? 'INFO');
  return idx >= 0 ? order[idx]! : 'INFO';
}

/** 级别判定：低于 minLevel 的不输出。 */
function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  const order: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
  return order.indexOf(level) <= order.indexOf(minLevel);
}

/** 默认 console sink：JSON 格式输出，便于日志收集工具解析。 */
function defaultConsoleSink(entry: LogEntry): void {
  try {
    console.log(JSON.stringify(entry));
  } catch {
    /* 输出流不可用（管道关闭/EPIPE）时静默丢弃，防止错误风暴 */
  }
  // 额外落点（文件等）：任一落点异常不得影响其余落点与业务日志
  for (const sink of extraSinks) {
    try {
      sink(entry);
    } catch {
      /* 落点故障静默：日志系统自身不能成为错误来源 */
    }
  }
}

/**
 * 额外日志落点（如文件 sink）。
 *
 * 设计理由（2026-11-07 设置页「运行日志」需求）：
 * createLogger 的 sink 是**模块私有**参数，业务侧全部使用默认 console sink；
 * 若要落盘只能逐个改动调用点。这里提供进程级注册表，默认 sink 在 console 输出
 * 之后顺带转发，保持「一个入口、多落点」且不改变既有调用方式。
 *
 * @returns 注销函数（测试与热重配置用）
 */
export function addLogSink(sink: LogSink): () => void {
  extraSinks.add(sink);
  return () => {
    extraSinks.delete(sink);
  };
}

/**
 * 消息脱敏：移除可能的凭据片段。
 * 02-架构设计 §7.4：日志不得记录敏感凭据。
 */
function sanitizeMessage(msg: string): string {
  if (typeof msg !== 'string') return String(msg);
  return msg
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***')
    .replace(/api[_-]?key["'\s:=]+["'][^"']{8,}["']/gi, 'api_key=***REDACTED***');
}

/** meta 脱敏：递归处理嵌套对象。 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/key|token|secret|password|credential/i.test(key)) {
      result[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeMeta(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
