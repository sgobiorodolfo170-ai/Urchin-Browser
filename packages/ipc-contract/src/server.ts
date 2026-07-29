/**
 * @urchin/ipc-contract · 服务端包装器（Main 进程使用）
 *
 * 依据：契约 B §4 Main 进程的 handle 包装器
 * 职责：
 * 1. 包装 ipcMain.handle，对入参做 zod parse（防恶意/畸形输入）
 * 2. 对出参做 zod parse（防 AI 协作 schema 漂移）
 * 3. 捕获异常装箱为 IpcError payload（跨进程可序列化）
 * 4. 应用 per-channel 超时（IP7，默认 30s）
 */
import { ipcSchema, type IpcChannel, type IpcReq, type IpcRes } from './schemas/index';
import { IpcError, IpcErrorCode, type IpcErrorPayload } from './errors';

/**
 * Electron ipcMain 的最小依赖接口（便于测试 mock，不直接依赖 electron 包）。
 * 完整类型由 apps/desktop 在运行时通过 Electron 提供。
 */
export interface IpcMainLike {
  handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** Electron IpcMainInvokeEvent 的最小依赖接口。 */
export interface IpcMainInvokeEvent {
  readonly sender: unknown;
}

/** 默认超时 30s（IP7）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-channel 超时配置覆盖。 */
export type TimeoutOverrides = Partial<Record<IpcChannel, number>>;

/** Handler 函数签名：接收入参与上下文，返回出参。 */
export type IpcHandler<C extends IpcChannel> = (
  req: IpcReq<C>,
  ctx: IpcCallCtx,
) => Promise<IpcRes<C>> | IpcRes<C>;

/** 调用上下文：暴露 Electron 原生 event 与超时配置。 */
export interface IpcCallCtx {
  readonly event: IpcMainInvokeEventLike;
  readonly channel: IpcChannel;
  readonly timeoutMs: number;
}

/** IpcMainInvokeEvent 的公开别名（解耦 electron 包）。 */
export type IpcMainInvokeEventLike = IpcMainInvokeEvent;

/** 注册结果：便于测试与卸载。 */
export interface RegisteredHandler {
  readonly channel: IpcChannel;
  unregister(): void;
}

/**
 * 注册类型化 IPC handler。
 *
 * @param ipcMain Electron 的 ipcMain 实例（依赖注入，便于测试 mock）
 * @param channel 通道名（必须是 ipcSchema 的 key）
 * @param handler 业务处理函数
 * @param opts 可选：超时覆盖
 *
 * 设计理由（agents.md §七.2）：
 * 不直接用 ipcMain.handle 是因为原生 API 无类型、无校验、无超时、
 * 异常会以原生 Error 形式跨进程序列化丢失语义。
 * 本包装器把「校验→超时→异常装箱」收敛为一处，业务 handler 只关心纯逻辑。
 */
export function registerHandler<C extends IpcChannel>(
  ipcMain: IpcMainLike,
  channel: C,
  handler: IpcHandler<C>,
  opts?: { timeoutMs?: number },
): RegisteredHandler {
  const schema = ipcSchema[channel];
  if (!schema) {
    throw new IpcError(IpcErrorCode.INTERNAL, `未知 IPC 通道: ${channel}`, { channel });
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const wrapped = async (
    event: IpcMainInvokeEvent,
    rawReq: unknown,
  ): Promise<IpcRes<C> | IpcErrorPayload> => {
    void event;
    // 1. 入参校验
    let req: IpcReq<C>;
    try {
      req = schema.req.parse(rawReq);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new IpcError(IpcErrorCode.VALIDATION, `入参校验失败: ${msg}`, { channel }).toPayload();
    }

    // 2. 超时竞速
    const ctx: IpcCallCtx = { event, channel, timeoutMs };
    try {
      const result = await Promise.race([
        Promise.resolve(handler(req, ctx)),
        createTimeout(timeoutMs, channel),
      ]);

      // 3. 出参校验（仅对成功结果，超时/异常跳过）
      if (isIpcErrorPayloadInternal(result)) {
        return result;
      }
      try {
        return schema.res.parse(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new IpcError(IpcErrorCode.INTERNAL, `出参校验失败: ${msg}`, { channel }).toPayload();
      }
    } catch (e) {
      // 4. 异常装箱
      if (e instanceof IpcError) {
        return e.toPayload();
      }
      const msg = e instanceof Error ? e.message : String(e);
      return new IpcError(IpcErrorCode.INTERNAL, msg, { channel }).toPayload();
    }
  };

  ipcMain.handle(channel, wrapped);

  return {
    channel,
    unregister() {
      ipcMain.removeHandler(channel);
    },
  };
}

/** 创建超时 promise，超时后 reject IpcError。 */
function createTimeout(ms: number, channel: IpcChannel): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new IpcError(IpcErrorCode.TIMEOUT, `IPC 调用超时 (${ms}ms)`, { channel, retryable: true }),
      );
    }, ms);
  });
}

/** 类型守卫：判断是否为内部已装箱错误 payload。 */
function isIpcErrorPayloadInternal(value: unknown): value is IpcErrorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}
