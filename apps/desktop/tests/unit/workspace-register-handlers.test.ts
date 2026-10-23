/**
 * Workspace IPC handler 注册单元测试。
 *
 * 验证：
 * 1. workspace.list / create / update 委托 registry 并广播变更
 * 2. workspace.remove：有打开标签时拒绝；无标签放行并广播
 * 3. workspace.clearData：有打开标签时拒绝；无标签调用 sessions.clearData
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerWorkspaceHandlers } from '../../src/main/workspaces/register-handlers';
import type { WorkspaceRegistry } from '../../src/main/workspaces/workspace-registry';
import type { WorkspaceSessionManager } from '../../src/main/workspaces/workspace-sessions';
import type { TabManager } from '../../src/main/tabs/tab-manager';
import { DEFAULT_WORKSPACE_ID } from '@urchin/ipc-contract';
import type { Workspace, WorkspaceColor } from '@urchin/ipc-contract';

/** 轻量 mock ipcMain：只记录 handler 并暴露 invoke。 */
function createMockIpcMain() {
  const handlers = new Map<string, (req: unknown) => unknown>();
  const ipcMain = {
    handle: (channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({ sender: null } as never, req));
    },
    invoke: (channel: string, req: unknown) => {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn(req);
    },
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

/** 快速构造工作区对象（避免 vi.fn 返回字面量导致 color 宽化为 string）。 */
function wsOf(id: string, name: string, color: WorkspaceColor, isDefault = false): Workspace {
  return { id, name, color, isDefault, createdAt: 1 };
}

function createDeps() {
  const sample: Workspace = {
    id: 'w1',
    name: 'x',
    color: 'blue',
    isDefault: false,
    createdAt: 1,
  };
  const registry = {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    create: vi.fn((input: { name: string; color: WorkspaceColor }) => ({
      id: 'new-id',
      ...input,
      isDefault: false,
      createdAt: 1,
    })),
    update: vi.fn(() => ({ ...sample })),
    remove: vi.fn(),
  } as unknown as WorkspaceRegistry;

  const sessions = {
    clearData: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceSessionManager;

  const tabManager = {
    query: vi.fn(() => []),
  } as unknown as TabManager;

  const broadcastChanged = vi.fn();

  return {
    registry,
    sessions,
    tabManager,
    broadcastChanged,
    deps: {
      registry,
      sessions,
      tabManager,
      broadcastChanged,
    } as Parameters<typeof registerWorkspaceHandlers>[1],
  };
}

describe('registerWorkspaceHandlers', () => {
  it('should list workspaces', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, registry } = createDeps();
    registry.list = vi.fn(() => [wsOf('default', '默认', 'blue', true)]);
    registerWorkspaceHandlers(ipcMain, deps);

    const res = (await handlers.get('workspace.list')?.({})) as { workspaces: unknown[] };
    expect(res?.workspaces).toHaveLength(1);
  });

  it('should create workspace and broadcast change', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, broadcastChanged } = createDeps();
    registerWorkspaceHandlers(ipcMain, deps);

    await handlers.get('workspace.create')?.({ name: '工作', color: 'green' });
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('should update workspace and broadcast change', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, broadcastChanged } = createDeps();
    registerWorkspaceHandlers(ipcMain, deps);

    await handlers.get('workspace.update')?.({ id: 'w1', name: '新名' });
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('should reject remove while tabs are open in that workspace', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, tabManager, broadcastChanged, registry } = createDeps();
    (tabManager.query as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 1, windowId: 1, workspaceId: 'w1' },
    ]);
    registerWorkspaceHandlers(ipcMain, deps);

    const res = (await handlers.get('workspace.remove')?.({ id: 'w1' })) as {
      code: string;
      message: string;
    };
    expect(res.code).toBe('INTERNAL');
    expect(res.message).toContain('请先关闭');
    expect(registry.remove).not.toHaveBeenCalled();
    expect(broadcastChanged).not.toHaveBeenCalled();
  });

  it('should remove workspace when no tabs open', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, tabManager, registry, broadcastChanged } = createDeps();
    (tabManager.query as ReturnType<typeof vi.fn>).mockReturnValue([]);
    registerWorkspaceHandlers(ipcMain, deps);

    const res = await handlers.get('workspace.remove')?.({ id: 'w1' });
    expect(res).toEqual({ ok: true });
    expect(registry.remove).toHaveBeenCalledWith('w1');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('should clear data when no tabs open', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, sessions, broadcastChanged, registry } = createDeps();
    registry.get = vi.fn(() => wsOf('w1', 'x', 'blue'));
    registerWorkspaceHandlers(ipcMain, deps);

    const res = await handlers.get('workspace.clearData')?.({ id: 'w1' });
    expect(res).toEqual({ ok: true });
    expect(sessions.clearData).toHaveBeenCalledWith('w1');
    expect(broadcastChanged).toHaveBeenCalledTimes(1);
  });

  it('should reject clearData while tabs are open', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, tabManager, sessions, registry } = createDeps();
    registry.get = vi.fn(() => wsOf('w1', 'x', 'blue'));
    (tabManager.query as ReturnType<typeof vi.fn>).mockReturnValue([{ id: 1, workspaceId: 'w1' }]);
    registerWorkspaceHandlers(ipcMain, deps);

    const res = (await handlers.get('workspace.clearData')?.({ id: 'w1' })) as {
      code: string;
      message: string;
    };
    expect(res.code).toBe('INTERNAL');
    expect(res.message).toContain('请先关闭');
    expect(sessions.clearData).not.toHaveBeenCalled();
  });

  it('should reject clearData for unknown workspace', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, registry } = createDeps();
    registry.get = vi.fn(() => undefined);
    registerWorkspaceHandlers(ipcMain, deps);

    const res = (await handlers.get('workspace.clearData')?.({ id: 'ghost' })) as { code: string };
    expect(res.code).toBe('INTERNAL');
  });

  it('should resolve default workspace id as existing (never rejects on clear)', async () => {
    const { ipcMain, handlers } = createMockIpcMain();
    const { deps, registry } = createDeps();
    registry.get = vi.fn(() => wsOf(DEFAULT_WORKSPACE_ID, '默认', 'blue', true));
    registerWorkspaceHandlers(ipcMain, deps);

    await expect(
      handlers.get('workspace.clearData')?.({ id: DEFAULT_WORKSPACE_ID }),
    ).resolves.toEqual({
      ok: true,
    });
  });
});
