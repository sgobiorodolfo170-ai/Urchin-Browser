/**
 * Workspace（工作区）模块入口
 *
 * 依据：契约 D TP7 / 契约 B §3.1 workspace.* / 04-模块全景 M2/M7
 * 职责：工作区元数据注册表 + session 分区解析 + IPC handler。
 */
export { WorkspaceRegistry } from './workspace-registry';
export type { WorkspacePersistence, WorkspaceStoredRecord } from './workspace-registry';
export { WorkspaceSessionManager, partitionForWorkspace } from './workspace-sessions';
export { registerWorkspaceHandlers } from './register-handlers';
export type { WorkspaceHandlerDeps } from './register-handlers';
