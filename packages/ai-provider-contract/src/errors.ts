/**
 * M12 Provider Contract · 错误协议
 *
 * 依据：契约 A §5
 *
 * 所有 Provider 抛出的异常必须装箱为 ProviderError，
 * 包含 code（结构化错误码）和 retryable（是否可重试）字段。
 * Orchestrator 对 NETWORK_ERROR / RATE_LIMITED 自动重试（指数退避 1s/2s/4s，最多 3 次）。
 */

/** 结构化错误码 */
export type ProviderErrorCode =
  | 'AUTH_INVALID' // api_key 错或过期
  | 'RATE_LIMITED' // 429
  | 'NETWORK_ERROR' // 网络异常
  | 'CONTEXT_TOO_LONG' // 超出模型窗口
  | 'CONTENT_FILTERED' // 内容被提供方拒绝
  | 'PROVIDER_ERROR' // Provider 内部错误
  | 'INVALID_RESPONSE' // 返回格式不合法
  | 'ABORTED' // 用户取消
  | 'UNKNOWN';

/** 可重试的错误码集合 */
export const RETRYABLE_ERROR_CODES: readonly ProviderErrorCode[] = [
  'NETWORK_ERROR',
  'RATE_LIMITED',
];

/** 判断错误码是否可重试 */
export function isRetryable(code: ProviderErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.includes(code);
}

/**
 * Provider 结构化错误。
 *
 * Provider 实现抛错时必须使用此类，Orchestrator 据此决定重试策略。
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options?.retryable ?? isRetryable(code);
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }

    // 维持原型链（ES5 兼容）
    Object.setPrototypeOf(this, ProviderError.prototype);
  }

  /**
   * 将任意异常装箱为 ProviderError。
   * - 已是 ProviderError 则原样返回
   * - 其他 Error 装箱为 UNKNOWN，保留原始 cause
   */
  static from(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof Error) {
      return new ProviderError('UNKNOWN', err.message, { cause: err });
    }
    return new ProviderError('UNKNOWN', String(err));
  }
}
