/**
 * @urchin/ipc-contract · 错误协议
 *
 * 依据：契约 B §4 IpcError + IpcErrorCode
 * 所有 IPC handler 未捕获异常必须装箱为 IpcError('INTERNAL')，
 * 渲染层统一捕获并展示 toast。
 */

/**
 * IPC 错误码枚举。
 * 语义与契约 B §4 一致：
 * - INTERNAL：未知服务端异常（兜底）
 * - NOT_FOUND：目标资源不存在（如 tabId 不存在）
 * - VALIDATION：zod 入参/出参校验失败
 * - TIMEOUT：handler 超时（IP7，默认 30s）
 * - PERMISSION：调用方无权限
 * - STATE：当前状态不允许该操作（如对已关闭 tab 调用 reload）
 * - ABORTED：用户主动中止（如 ai.chat.abort）
 * - UNAVAILABLE：目标子系统不可用（如 Provider 未加载）
 * - FILE_TOO_LARGE：文件超过读取上限（file.read 已改截断语义不再抛出，码位为契约 B §4 保留）
 */
export const IpcErrorCode = {
  INTERNAL: 'INTERNAL',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  TIMEOUT: 'TIMEOUT',
  PERMISSION: 'PERMISSION',
  STATE: 'STATE',
  ABORTED: 'ABORTED',
  UNAVAILABLE: 'UNAVAILABLE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
} as const;

export type IpcErrorCode = (typeof IpcErrorCode)[keyof typeof IpcErrorCode];

/**
 * IPC 错误协议载荷。
 * 跨进程边界可序列化，禁止携带 Error 堆栈等非可序列化字段。
 */
export interface IpcErrorPayload {
  readonly code: IpcErrorCode;
  readonly message: string;
  /** 可选：调用上下文中的 channel 名，便于日志关联 */
  readonly channel?: string;
  /** 可选：是否可重试（与 ProviderError.retryable 语义对齐） */
  readonly retryable?: boolean;
}

/**
 * IpcError：在 Main 端抛出后由包装器捕获并序列化为 IpcErrorPayload。
 *
 * 设计理由（AGENTS.md §七.2「说明为什么」）：
 * 不直接复用原生 Error 是因为跨进程序列化时 stack 会丢失；
 * 显式 code 让渲染层能按错误码分支处理（toast / 重试 / 静默）。
 */
export class IpcError extends Error {
  public readonly code: IpcErrorCode;
  public readonly retryable: boolean;
  public readonly channel?: string;

  constructor(
    code: IpcErrorCode,
    message: string,
    opts?: { channel?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.retryable = opts?.retryable ?? defaultRetryable(code);
    this.channel = opts?.channel;
    // 保持 V8 堆栈，但跨进程传输时只取 payload 字段
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, IpcError);
    }
  }

  /** 序列化为可跨进程传输的 payload。 */
  toPayload(): IpcErrorPayload {
    return {
      code: this.code,
      message: this.message,
      channel: this.channel,
      retryable: this.retryable,
    };
  }

  /** 从 payload 还原（渲染层使用）。 */
  static fromPayload(payload: IpcErrorPayload): IpcError {
    return new IpcError(payload.code, payload.message, {
      channel: payload.channel,
      retryable: payload.retryable,
    });
  }
}

/** 按错误码默认是否可重试。与契约 B §4 一致。 */
function defaultRetryable(code: IpcErrorCode): boolean {
  switch (code) {
    case IpcErrorCode.TIMEOUT:
    case IpcErrorCode.UNAVAILABLE:
      return true;
    case IpcErrorCode.ABORTED:
    case IpcErrorCode.VALIDATION:
    case IpcErrorCode.NOT_FOUND:
    case IpcErrorCode.PERMISSION:
    case IpcErrorCode.STATE:
    case IpcErrorCode.INTERNAL:
    case IpcErrorCode.FILE_TOO_LARGE:
    default:
      return false;
  }
}

/** 类型守卫：判断未知值是否为 IpcErrorPayload。 */
export function isIpcErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string' && v.code in IpcErrorCode;
}

// ───────────────── contextBridge 错误码信封 ─────────────────

/**
 * 错误码跨桥信封（[CODE] 前缀）。
 *
 * 设计理由（2026-08-30 实测）：Electron contextBridge 会把 preload 侧抛出的
 * Error 重构为只剩 message 的普通 Error——code/name/自定义属性全部丢失，
 * 渲染层无法按 err.code 分支，契约 B §4 的错误码语义就此失效。桥只能保真
 * message，故 client.ts 抛错时把错误码以 `[CODE] ` 前缀嵌入 message 跨桥，
 * 渲染层用 extractIpcCode 还原后按码分支。
 * 前缀格式收紧为「[大写字母/下划线] + 空格」，普通业务消息以同样形态开头的
 * 概率极低；前缀命中但非合法错误码时按无信封处理（不吞合法内容）。
 */
const IPC_CODE_ENVELOPE_RE = /^\[([A-Z][A-Z_]*)\] /;

/** 把错误码嵌入 message（client.ts 跨桥抛错用）。 */
export function embedIpcCode(code: IpcErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

/** 从 message 还原错误码；无信封或前缀非合法错误码时 code 为 undefined、message 原样返回。 */
export function extractIpcCode(message: string): {
  code: IpcErrorCode | undefined;
  message: string;
} {
  const match = IPC_CODE_ENVELOPE_RE.exec(message);
  if (!match) return { code: undefined, message };
  const prefix = match[1];
  if (!prefix || !(prefix in IpcErrorCode)) return { code: undefined, message };
  return { code: prefix as IpcErrorCode, message: message.slice(match[0].length) };
}
