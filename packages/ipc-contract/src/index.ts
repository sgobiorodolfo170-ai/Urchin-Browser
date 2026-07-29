/**
 * @urchin/ipc-contract · IPC 契约层入口
 *
 * 单一真源：所有 IPC 通道的 zod schema + 类型化 server/client + 错误协议。
 * 依据：契约 B（M17 IPC Protocol Layer）
 */
export * from './schemas/index';
export * from './errors';
export * from './server';
export * from './client';
