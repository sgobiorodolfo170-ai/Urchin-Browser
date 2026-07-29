/**
 * Urchin Browser · preload 脚本
 *
 * 依据：02-架构设计 §4 安全边界 / 契约 B §5 typedInvoke 客户端
 * 职责：
 * 1. 在 sandbox + contextIsolation 下暴露最小化 API 到渲染进程
 * 2. 暴露 typedInvoke 让渲染层强类型调用 Main，无需直接访问 ipcRenderer
 *
 * 设计理由（agents.md §七.2 + 项目特化审查点）：
 * 不暴露 ipcRenderer 全量 API 是因为渲染层拿到 ipcRenderer 可绕过校验。
 * 仅暴露 typedInvoke 把「类型约束 + zod 校验 + 错误解包」收口在 preload。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createTypedInvoke } from '@urchin/ipc-contract';

// 创建类型化 invoke 客户端
const typedInvoke = createTypedInvoke(ipcRenderer);

/**
 * 暴露到渲染进程的 API 表面。
 * 渲染层通过 window.urchin.invoke(...) 调用，无 ipcRenderer 直接访问权。
 */
const api = {
  invoke: typedInvoke,
  /** 平台信息（v0.1 最小集） */
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('urchin', api);

// 类型导出（供渲染层 import type 使用）
export type UrchinApi = typeof api;
