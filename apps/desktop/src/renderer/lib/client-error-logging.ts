/**
 * 渲染进程全局错误上报（设置 · 运行日志）
 *
 * 主进程的结构化日志覆盖不到渲染层 JS 异常与未处理的 Promise rejection；
 * 这类错误往往正是「某个功能打不开」的直接原因，因此统一经 `logs.clientError`
 * 转交主进程落盘（module=renderer），与运行日志同页展示。
 *
 * 约束：
 * - 只在有 `window.urchin.invoke` 的环境启用（preload 未就绪时静默跳过）；
 * - 每分钟最多上报 30 条，避免错误风暴把日志文件刷爆；
 * - 上报本身失败静默（错误处理不得再抛错误）。
 */
const MAX_REPORTS_PER_MINUTE = 30;

let windowStart = 0;
let reportCount = 0;

/** 限流：滑动一分钟窗口。 */
function allowed(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    reportCount = 0;
  }
  return ++reportCount <= MAX_REPORTS_PER_MINUTE;
}

/** 安全截断（契约对字段长度有上限）。 */
function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 上报一条渲染层错误。 */
function report(message: string, stack?: string, source?: string): void {
  if (!allowed()) return;
  try {
    void window.urchin
      .invoke('logs.clientError', {
        message: clip(message, 2000) ?? 'renderer error',
        ...(clip(stack, 8000) ? { stack: clip(stack, 8000) } : {}),
        ...(clip(source, 500) ? { source: clip(source, 500) } : {}),
      })
      .catch(() => undefined);
  } catch {
    /* 上报通道不可用：忽略 */
  }
}

/** 安装全局错误监听（幂等：重复调用只安装一次）。 */
let installed = false;

export function installGlobalErrorLogging(): void {
  if (installed) return;
  if (typeof window === 'undefined' || !window.urchin?.invoke) return;
  installed = true;

  window.addEventListener('error', (event) => {
    const error = event.error instanceof Error ? event.error : undefined;
    const message = event.message.length > 0 ? event.message : (error?.message ?? 'renderer error');
    report(
      message,
      error?.stack,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof Error) {
      report(`unhandledRejection: ${reason.message}`, reason.stack);
      return;
    }
    report(`unhandledRejection: ${String(reason)}`);
  });
}
