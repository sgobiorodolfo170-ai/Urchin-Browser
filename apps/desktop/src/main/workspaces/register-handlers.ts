/**
 * Workspace（工作区）IPC Handler 注册
 *
 * 依据：契约 B §3.1 workspace.* / 契约 D TP7
 * 职责：
 * 注册 workspace.list / workspace.create / workspace.update /
 *      workspace.remove / workspace.clearData IPC handler。
 *
 * 设计理由（AGENTS.md §七.2 + §六「Single Source of Truth」）：
 * - handler 只做协议适配，业务逻辑委托 WorkspaceRegistry / WorkspaceSessionManager
 * - 删除/清空工作区前必须确认该工作区无打开标签（防止清掉正在写入的会话）
 * - 变更后广播 'workspace:changed'，多窗口渲染层统一刷新
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { TabManager } from '../tabs/tab-manager';
import type { WorkspaceRegistry } from './workspace-registry';
import type { WorkspaceSessionManager } from './workspace-sessions';

const log = createLogger('workspace-ipc');

/** workspace handler 依赖。 */
export interface WorkspaceHandlerDeps {
  readonly registry: WorkspaceRegistry;
  readonly sessions: WorkspaceSessionManager;
  /** 用于「删除/清空前必须无打开标签」检查。 */
  readonly tabManager: TabManager;
  /** 工作区变更广播（create/update/remove/clearData 后调用，通知所有窗口刷新）。 */
  readonly broadcastChanged: () => void;
}

/**
 * 注册 workspace 域 IPC handler。
 */
export function registerWorkspaceHandlers(ipcMain: IpcMain, deps: WorkspaceHandlerDeps): void {
  // workspace.list：返回全部工作区
  registerHandler(ipcMain, 'workspace.list', () => {
    log.info('workspace.list');
    return { workspaces: deps.registry.list() };
  });

  // workspace.create：创建工作区
  registerHandler(ipcMain, 'workspace.create', (req) => {
    log.info('workspace.create', { name: req.name, color: req.color });
    const workspace = deps.registry.create({ name: req.name, color: req.color });
    deps.broadcastChanged();
    return { workspace };
  });

  // workspace.update：重命名 / 换色
  registerHandler(ipcMain, 'workspace.update', (req) => {
    log.info('workspace.update', { id: req.id, name: req.name, color: req.color });
    const workspace = deps.registry.update(req.id, {
      name: req.name,
      color: req.color,
    });
    deps.broadcastChanged();
    return { workspace };
  });

  // workspace.remove：删除工作区（默认工作区由 registry 拒绝）
  // 先清除分区数据（Cookie/存储/缓存），再删元数据——确保 UI 承诺的"清除"真正落地
  registerHandler(ipcMain, 'workspace.remove', async (req) => {
    log.info('workspace.remove', { id: req.id });
    assertNoOpenTabs(deps.tabManager, req.id, '删除');
    await deps.sessions.clearData(req.id);
    deps.registry.remove(req.id);
    deps.broadcastChanged();
    return { ok: true as const };
  });

  // workspace.clearData：清空 Cookie/存储/缓存（请求确认由 UI 层负责）
  registerHandler(ipcMain, 'workspace.clearData', async (req) => {
    log.info('workspace.clearData', { id: req.id });
    // 校验存在（default 也存在）
    if (!deps.registry.get(req.id)) {
      throw new Error(`工作区不存在：${req.id}`);
    }
    assertNoOpenTabs(deps.tabManager, req.id, '清空数据');
    await deps.sessions.clearData(req.id);
    deps.broadcastChanged();
    return { ok: true as const };
  });

  log.info('workspace ipc handlers registered');
}

/** 删除/清空前检查该工作区无打开标签。 */
function assertNoOpenTabs(tabManager: TabManager, workspaceId: string, action: string): void {
  const openTabs = tabManager.query({}).filter((t) => t.workspaceId === workspaceId);
  if (openTabs.length > 0) {
    throw new Error(
      `请先关闭${action}工作区的全部标签（该工作区还有 ${openTabs.length} 个标签打开）`,
    );
  }
}
