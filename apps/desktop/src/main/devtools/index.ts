/**
 * M15 DevTools 模块入口。
 *
 * 与 tabs/translate/pi-web 等模块结构对齐：
 * manager（会话与采集核心）+ register-handlers（IPC 适配）。
 * 依据：契约 G / 实施规划 §6。
 */
export { DevtoolsManager } from './devtools-manager';
export type { DevtoolsManagerOptions, DevtoolsStatusResult } from './devtools-manager';
export { registerDevtoolsHandlers } from './register-handlers';
export { installDevtoolsShortcuts } from './install-shortcuts';
export type { DevtoolsToggleNotifier } from './install-shortcuts';
export { TabCdpClient } from './cdp-client';
export type {
  DebuggerLike,
  DebuggerResolver,
  CdpMessageHandler,
  CdpDetachHandler,
} from './cdp-client';
export { RingBuffer } from './ring-buffer';
export { truncateText, sanitizeHeaders, formatConsoleApiArgs } from './devtools-manager';
