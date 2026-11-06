/**
 * Runtime 域（设置-关于 · 运行时信息）出口
 *
 * 职责：便携 Node 运行时「期望路径单一真源 + 可运行性探测 + IPC 注册」。
 * 路径同时供 dsh 启动器接线复用（bootstrap/handlers.ts）。
 */
export {
  resolvePortableNodeExePath,
  probePortableNode,
  type PortableNodePathInput,
  type PortableNodeProbe,
  type ExecFileFn,
} from './portable-node';
export { registerRuntimeHandlers, type RuntimeHandlerDeps } from './register-handlers';
