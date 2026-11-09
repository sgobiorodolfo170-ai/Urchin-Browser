/**
 * 运行日志落盘与读取（设置 · 运行日志）
 *
 * 需求（2026-11-07 用户指令）：设置页「关于」分类下新增「运行日志」选项卡，
 * 展示项目全部运行日志与报错日志；日志位置跟随数据目录，不提供单独设置项。
 *
 * 设计：
 * - 落盘：通过 @urchin/logger 的 addLogSink 注册进程级文件落点，所有既有
 *   createLogger 调用无需改动即自动写入。文件按本地日期切分
 *   `<数据目录>/logs/app-YYYY-MM-DD.log`（JSONL，一行一条 LogEntry）。
 * - 读取：IPC 只读最近若干条，按「今天 → 更早」倒序扫描文件尾部，
 *   逐行 JSON 解析（损坏行跳过，绝不因单行异常导致整个页面失败）。
 * - 隐私：脱敏已在 logger 内完成（凭据/令牌）；此处不再二次加工。
 * - 容量：单次读取最多回看 4 MB / 5000 条；只保留最近 7 个日志文件，
 *   超出部分在启动时清理，避免长期运行撑爆数据目录。
 *
 * 为何同步写：桌面端日志量级为每秒个位数，appendFileSync 足够快且能保证
 * 「日志已产生即可在设置页看到」；换成流会引入 flush 时序与句柄泄漏问题。
 */
import { addLogSink, createLogger, type LogEntry, type LogLevel } from '@urchin/logger';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

const log = createLogger('logs');

/** 日志文件名前缀（与文件名格式 app-YYYY-MM-DD.log 对应） */
const FILE_PREFIX = 'app-';
/** 保留的日志文件数量（按文件名字典序 = 时间序） */
const KEEP_FILES = 7;
/** 单次读取最多回看的字节数（尾部截取） */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** 单次读取最多解析的条数（防超大文件拖慢主进程） */
const MAX_SCAN_ENTRIES = 5000;

/** 读取条件（与 ipc-contract logsReadReqSchema 对齐） */
export interface LogQuery {
  readonly limit?: number;
  readonly level?: LogLevel;
  readonly query?: string;
}

/** 日志文件描述 */
export interface LogFileDescriptor {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
}

/** 日志读取结果 */
export interface LogsReadResult {
  readonly entries: LogEntry[];
  readonly total: number;
  readonly dir: string;
  readonly currentFile: string;
}

/** 日志目录信息 */
export interface LogsInfoResult {
  readonly dir: string;
  readonly currentFile: string;
  readonly files: LogFileDescriptor[];
}

interface LogStoreState {
  dir?: string;
  disposeSink?: () => void;
}

const state: LogStoreState = {};

/** 本地日期戳 YYYY-MM-DD（与用户所在时区一致，不按 UTC 切分）。 */
function dateStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 当前日志文件名。 */
function currentFileName(now = new Date()): string {
  return `${FILE_PREFIX}${dateStamp(now)}.log`;
}

/** 列出目录下的日志文件，按文件名倒序（新 → 旧）。 */
function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith('.log'))
    .sort()
    .reverse();
}

/** 只保留最近 KEEP_FILES 个文件（含当前文件）；删除失败忽略（不影响主流程）。 */
function pruneOldFiles(dir: string): void {
  const files = listLogFiles(dir);
  // 当前文件尚未创建时给自己预留一个名额，避免「6 个旧文件 + 今天」变成 8 个
  const keep = files.includes(currentFileName()) ? KEEP_FILES : KEEP_FILES - 1;
  for (const name of files.slice(keep)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* 文件被占用/权限不足：下次启动再试 */
    }
  }
}

/** 单条落盘：JSONL 追加。任何 IO 异常静默（日志系统不得影响业务）。 */
function appendEntry(entry: LogEntry): void {
  const dir = state.dir;
  if (!dir) return;
  try {
    appendFileSync(join(dir, currentFileName()), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* 磁盘满 / 路径不可写：静默丢弃本条 */
  }
}

/**
 * 初始化日志落盘（幂等；数据目录变化时重建落点）。
 *
 * 由主进程在数据目录解析完成后尽早调用，保证启动阶段的错误也能被记录。
 */
export function initLogFile(dir: string): void {
  if (state.dir === dir && state.disposeSink) return;
  state.disposeSink?.();
  state.dir = dir;
  try {
    mkdirSync(dir, { recursive: true });
    pruneOldFiles(dir);
  } catch {
    /* 目录不可创建：读取侧会返回空列表 */
  }
  state.disposeSink = addLogSink(appendEntry);
  log.info('log file sink ready', { dir, file: currentFileName() });
}

/** 读取文件尾部文本（超过 maxBytes 时从尾部截断，丢弃首行残片）。 */
function readTailText(file: string, maxBytes = MAX_READ_BYTES): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = Math.min(size, maxBytes);
    if (length <= 0) return '';
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
  } finally {
    closeSync(fd);
  }
}

/** 解析一行 JSONL；非法行返回 null。 */
function parseLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Partial<LogEntry>;
    if (
      typeof value.timestamp === 'string' &&
      typeof value.level === 'string' &&
      typeof value.module === 'string' &&
      typeof value.message === 'string'
    ) {
      return value as LogEntry;
    }
  } catch {
    /* 损坏行（如进程崩溃时写了一半）：跳过 */
  }
  return null;
}

/** 条件匹配：级别精确匹配；关键词对 module/message/meta 做不区分大小写包含。 */
function matches(entry: LogEntry, query: LogQuery): boolean {
  if (query.level && entry.level !== query.level) return false;
  const keyword = query.query?.trim().toLowerCase();
  if (!keyword) return true;
  if (entry.module.toLowerCase().includes(keyword)) return true;
  if (entry.message.toLowerCase().includes(keyword)) return true;
  if (entry.meta) {
    try {
      return JSON.stringify(entry.meta).toLowerCase().includes(keyword);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 读取最近日志（新 → 旧）。
 *
 * 从今天的文件开始向前扫描；累计到 limit 条或扫描完文件即停止。
 * total 为「已扫描并命中的条数」，可能大于返回的 entries 长度（受 limit 限制）。
 */
export function readLogs(query: LogQuery = {}): LogsReadResult {
  const limit = clampInt(query.limit, 1, 2000, 500);
  const dir = state.dir ?? '';
  const currentFile = currentFileName();
  const entries: LogEntry[] = [];
  let total = 0;
  /** 跨文件共享的读取预算：避免历史文件多时每次轮询都读满上限。 */
  let byteBudget = MAX_READ_BYTES;

  if (!dir || !existsSync(dir)) {
    return { entries, total, dir, currentFile };
  }

  for (const name of listLogFiles(dir)) {
    if (entries.length >= limit || total >= MAX_SCAN_ENTRIES || byteBudget <= 0) break;
    const file = join(dir, name);
    let lines: string[];
    try {
      const text = readTailText(file, byteBudget);
      byteBudget -= Buffer.byteLength(text, 'utf8');
      lines = text.split('\n');
    } catch {
      continue; // 文件不可读（占用/权限）：跳过，继续更早的文件
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLine(lines[i] ?? '');
      if (!entry || !matches(entry, query)) continue;
      total++;
      if (entries.length < limit) entries.push(entry);
      if (total >= MAX_SCAN_ENTRIES) break;
    }
  }

  return { entries, total, dir, currentFile };
}

/** 日志目录信息（路径 + 文件列表），供设置页展示保存位置。 */
export function getLogsInfo(): LogsInfoResult {
  const dir = state.dir ?? '';
  const currentFile = currentFileName();
  const files: LogFileDescriptor[] = [];
  if (dir && existsSync(dir)) {
    for (const name of listLogFiles(dir)) {
      try {
        const stat = statSync(join(dir, name));
        files.push({ name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch {
        /* 竞态删除：跳过 */
      }
    }
  }
  return { dir, currentFile, files };
}

/** 数值收敛（缺省/非法值回退默认，越界夹紧）。 */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 测试用：注销落点并清空模块状态。 */
export function __resetLogFileForTest(): void {
  state.disposeSink?.();
  state.disposeSink = undefined;
  state.dir = undefined;
}
