/**
 * 渲染进程运行时错误日志 store（设置页「调试 → 运行报错日志」数据源）
 *
 * 设计：
 * - 模块级单例 + 发布订阅：采集器在渲染进程启动时安装（main.tsx），
 *   设置页打开前发生的错误也会被记录；调试页只订阅展示，不负责采集。
 * - 去重计数：相同级别 + 相同内容的错误只保留一条，count 自增，
 *   避免渲染循环等场景下同一错误反复刷屏（设置页用户可见的核心语义）。
 * - 持久化：每次变更同步写入 localStorage（与调试页配色方案同一存储层），
 *   重启后仍可查看；「清空」会同时删除本地存储。
 * - 事件源：console.error / console.warn 覆盖 + window error /
 *   unhandledrejection，覆盖应用主动报错与未捕获异常的常见来源。
 *
 * 与 React 集成：subscribeErrorLogs / getErrorLogs 适配 useSyncExternalStore，
 * 快照是不可变数组，仅在变更时换新引用，未变更时订阅者不会重渲染。
 */

/** 日志级别（UNCAUGHT / REJECTION 复用错误色，见设置页渲染） */
export type LogLevel = 'ERROR' | 'WARN' | 'UNCAUGHT' | 'REJECTION';

/** 单条去重后的日志条目 */
export interface RuntimeErrorEntry {
  readonly id: number;
  readonly level: LogLevel;
  /** 去重键的一部分：格式化后的完整错误内容（含 stack） */
  readonly message: string;
  /** 出现次数（>=1，重复出现时自增） */
  readonly count: number;
  /** 首次出现时间 YYYY-MM-DD HH:mm:ss（去重条目不随时间变动位置） */
  readonly time: string;
}

/** 条目数上限：每条可能代表多次重复，200 条足以承载一次会话的错误全貌 */
const MAX_ENTRIES = 200;
/** localStorage 持久化 key（重启后恢复日志） */
const STORAGE_KEY = 'urchin.debug.runtimeErrorLogs';
const LOG_LEVELS: readonly LogLevel[] = ['ERROR', 'WARN', 'UNCAUGHT', 'REJECTION'];

/** 格式化为 YYYY-MM-DD HH:mm:ss（本地时区） */
function formatDateTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 从 localStorage 恢复上次会话的日志。
 * 结构校验：损坏 / 越界 / 缺字段的数据直接丢弃，只保留合法条目（最多 MAX_ENTRIES 条）。
 */
function loadPersisted(): readonly RuntimeErrorEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RuntimeErrorEntry =>
          typeof e === 'object' &&
          e !== null &&
          LOG_LEVELS.includes((e as RuntimeErrorEntry).level) &&
          typeof (e as RuntimeErrorEntry).message === 'string' &&
          typeof (e as RuntimeErrorEntry).time === 'string' &&
          Number.isInteger((e as RuntimeErrorEntry).count) &&
          (e as RuntimeErrorEntry).count >= 1,
      )
      .slice(-MAX_ENTRIES)
      .map((e, i) => ({
        id: i + 1,
        level: e.level,
        message: e.message,
        count: e.count,
        time: e.time,
      }));
  } catch {
    return [];
  }
}

let entries: readonly RuntimeErrorEntry[] = loadPersisted();
let nextId = entries.length + 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 变更后同步持久化（条目最多 200 条，JSON 体积很小；配额异常时静默降级为仅内存） */
function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* 忽略配额 / 隐私模式等写入失败，日志仅保留在内存 */
  }
}

/** 订阅日志变更，返回退订函数（useSyncExternalStore 订阅接口） */
export function subscribeErrorLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前日志快照（useSyncExternalStore 快照接口；无变更时返回同一引用） */
export function getErrorLogs(): readonly RuntimeErrorEntry[] {
  return entries;
}

/** 清空日志（设置页「清空」按钮）：内存与 localStorage 一并删除 */
export function clearErrorLogs(): void {
  entries = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
  emit();
}

/** 把任意参数序列化为可读文本（Error 带 name/message/stack，对象走 JSON） */
function formatArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return '[object]';
        }
      }
      return String(a);
    })
    .join(' ');
}

/** 追加/去重一条日志：同级别同内容 → count 自增；否则新增条目（超出上限裁掉最旧的） */
function pushLog(level: LogLevel, message: string): void {
  const duplicate = entries.find((e) => e.level === level && e.message === message);
  if (duplicate) {
    entries = entries.map((e) => (e === duplicate ? { ...e, count: e.count + 1 } : e));
  } else {
    const entry: RuntimeErrorEntry = {
      id: nextId++,
      level,
      message,
      count: 1,
      time: formatDateTime(new Date()),
    };
    entries = [...entries, entry];
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }
  }
  persist();
  emit();
}

let installed = false;

/**
 * 安装渲染进程级错误采集器（幂等，main.tsx 启动时调用一次）。
 *
 * 必须挂在渲染进程入口而非设置页组件：设置页是按需挂载的，
 * 只有启动即安装才能记录「设置页打开之前」发生的错误。
 */
export function initRuntimeErrorLog(): void {
  if (installed) return;
  installed = true;

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    pushLog('ERROR', formatArgs(args));
    originalError.apply(console, args as never);
  };
  console.warn = (...args: unknown[]) => {
    pushLog('WARN', formatArgs(args));
    originalWarn.apply(console, args as never);
  };

  const onError = (e: ErrorEvent): void => {
    pushLog('UNCAUGHT', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    pushLog('REJECTION', formatArgs([e.reason]));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
}
