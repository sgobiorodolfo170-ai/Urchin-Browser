/**
 * @urchin/ipc-contract · 客户端（渲染进程使用）
 *
 * 依据：契约 B §5 typedInvoke
 * 职责：
 * 1. 包装 ipcRenderer.invoke，提供 channel 类型约束
 * 2. 入参在发送前做 zod parse（防渲染层脏数据）
 * 3. 出参在返回前做 zod parse（防 Main 端 schema 漂移）
 * 4. 检测 IpcErrorPayload 并抛出 IpcError，让业务层 try/catch
 */
import { ipcSchema, type IpcChannel, type IpcReqInput, type IpcRes } from './schemas/index';
import { IpcError, IpcErrorCode, isIpcErrorPayload } from './errors';

/** IpcRenderer 的最小依赖接口（便于测试 mock，不直接依赖 electron 包）。 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * 创建类型化 invoke 客户端。
 *
 * @param ipcRenderer Electron 的 ipcRenderer 实例或 mock
 *
 * 设计理由（agents.md §七.2）：
 * 直接用 ipcRenderer.invoke 会失去类型与校验，AI 协作时易漂移。
 * typedInvoke 把「类型约束 + 双向校验 + 错误解包」收口在一处，
 * 业务调用方只看到强类型 promise，无需关心 zod。
 */
export function createTypedInvoke(ipcRenderer: IpcRendererLike) {
  /**
   * 类型化 invoke。
   * @example
   * const { tab } = await typedInvoke('tab.create', { windowId: 1, url: 'https://x' });
   */
  return async function typedInvoke<C extends IpcChannel>(
    channel: C,
    req: IpcReqInput<C>,
  ): Promise<IpcRes<C>> {
    const schema = ipcSchema[channel];
    if (!schema) {
      throw new IpcError(IpcErrorCode.INTERNAL, `未知 IPC 通道: ${channel}`);
    }

    // 1. 入参校验（渲染层自我保护）
    const parsedReq = schema.req.parse(req);

    // 2. 调用 Main
    const raw = await ipcRenderer.invoke(channel, parsedReq);

    // 3. 错误解包
    if (isIpcErrorPayload(raw)) {
      throw IpcError.fromPayload(raw);
    }

    // 4. 出参校验
    return schema.res.parse(raw);
  };
}

/** typedInvoke 推导出的函数类型。 */
export type TypedInvoke = ReturnType<typeof createTypedInvoke>;
