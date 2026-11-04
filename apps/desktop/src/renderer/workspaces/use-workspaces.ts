/**
 * TP7 工作区状态与操作（App 域 hook）
 *
 * 为什么是 App 调用的 hook，而不是状态收进 <WorkspaceBar /> / <RightSidebar />：
 * - currentWorkspaceId 是标签生命周期的不变量锚点（活动标签永远属于当前工作区），
 *   被 tab:event 订阅（lastActive 维护）、handleNewTab、工作区总览页、侧栏列表多处
 *   消费，收进渲染树深处的组件会被迫层层上提、分裂真源；
 * - 整窗快照采集依赖 contentAreaRef（BrowserView 对应矩形）与 isInternalPage 判定，
 *   属 App 布局域。
 * hook 仅做代码组织：状态真源经 App 调用仍归 App 渲染域，侧栏/总览页只消费返回值。
 * lastActiveByWorkspaceRef / savedTabsByWorkspaceRef 由 App 持有传入——前者由
 * tab:event 订阅写入（声明须早于该订阅），后者由 TP4 启动加载 effect 填充。
 * （refactor-plan-p2 §2.3 步骤 6，代码自 App.tsx 原样迁出）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureWindowSnapshot } from './window-snapshot';
import type { WorkspaceOverviewItem } from './WorkspaceOverviewPage';
import { DEFAULT_WORKSPACE_ID, type Workspace, type WorkspaceColor } from './types';
import type { TabSnapshot } from '../tabs/types';
import { getCurrentWindowId } from '../lib/current-window';

/** TP4 懒恢复的保存标签（按工作区分组；App 启动时从 session.lastTabs 读取）。 */
export type SavedTabsByWorkspace = Record<
  string,
  { url: string; title: string; active: boolean }[]
>;

export interface UseWorkspacesOptions {
  readonly tabs: readonly TabSnapshot[];
  readonly activeTabId: number | null;
  /** 内容区 DOM 引用（整窗快照取 BrowserView 对应矩形） */
  readonly contentAreaRef: React.RefObject<HTMLDivElement>;
  /** 活跃标签是否内部页（快照叠加判定：内部页由 React 渲染，不叠加网页截图） */
  readonly isInternalPage: boolean;
  /** 每工作区最近一次激活的标签（tab:event 订阅写入，App 持有） */
  readonly lastActiveByWorkspaceRef: React.MutableRefObject<Record<string, number>>;
  /** TP4 懒恢复的保存标签（App 启动时填充，切换工作区时消费并逐条删除） */
  readonly savedTabsByWorkspaceRef: React.MutableRefObject<SavedTabsByWorkspace>;
  readonly doSelectTab: (tabId: number) => Promise<void>;
  readonly doCloseTab: (tabId: number) => Promise<void>;
  readonly handleCloseTab: (tabId: number) => void;
}

export function useWorkspaces({
  tabs,
  activeTabId,
  contentAreaRef,
  isInternalPage,
  lastActiveByWorkspaceRef,
  savedTabsByWorkspaceRef,
  doSelectTab,
  doCloseTab,
  handleCloseTab,
}: UseWorkspacesOptions) {
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string>(DEFAULT_WORKSPACE_ID);
  /** 工作区整窗快照（总览页卡片；仅内存，不持久化）。key = workspaceId。 */
  const [workspaceSnapshots, setWorkspaceSnapshots] = useState<Record<string, string>>({});
  /** 快照采集中标记：避免切换/打开总览并发抓图。 */
  const workspaceSnapshotInFlightRef = useRef(false);
  /** 各工作区上次快照时间（滚轮快速切换时限流，避免每步都抓图卡顿）。 */
  const lastWorkspaceSnapshotAtRef = useRef<Record<string, number>>({});

  // TP7：加载工作区列表（元数据；会话分区由主进程管理）。
  const refreshWorkspaces = useCallback(async () => {
    try {
      const result = (await window.urchin.invoke('workspace.list', {})) as {
        workspaces?: readonly Workspace[];
      };
      // 防御：mock/异常返回缺字段时按空列表处理
      setWorkspaces(Array.isArray(result.workspaces) ? result.workspaces : []);
    } catch (e) {
      console.error('Failed to load workspaces:', e);
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  // TP7：工作区变更广播（其他窗口创建/删除/改名/清空后本窗口同步刷新）。
  useEffect(() => {
    const unsubscribe = window.urchin.on('workspace:changed', () => {
      void refreshWorkspaces();
    });
    return () => {
      unsubscribe();
    };
  }, [refreshWorkspaces]);

  // TP7：当前工作区跟随活动标签（不变量：活动标签永远属于当前工作区）。
  useEffect(() => {
    if (activeTabId == null) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (active?.workspaceId && active.workspaceId !== currentWorkspaceId) {
      setCurrentWorkspaceId(active.workspaceId);
    }
  }, [activeTabId, tabs, currentWorkspaceId]);

  // TP7：工作区被删除/清空后，当前工作区失效 → 回退默认工作区。
  useEffect(() => {
    if (currentWorkspaceId === DEFAULT_WORKSPACE_ID) return;
    if (workspaces.length > 0 && !workspaces.some((w) => w.id === currentWorkspaceId)) {
      setCurrentWorkspaceId(DEFAULT_WORKSPACE_ID);
    }
  }, [workspaces, currentWorkspaceId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isWorkspacesTab = !!activeTab?.url?.startsWith('urchin://workspaces');

  /**
   * 采集指定工作区的整窗快照（工作区总览页卡片）。
   *
   * 采集时机（必须在该工作区仍处于激活现场时）：
   * - 切换到其他工作区前（保留离开时的窗口状态）；
   * - 打开总览页前（否则截图会包含总览页自身）。
   * 内部页（设置/主页/总览等）由 React 渲染，窗口截图已包含其内容，不叠加网页；
   * 普通网页按内容区 DOM 矩形叠加 BrowserView 截图，合成为「整个浏览器窗口」。
   *
   * @param throttleMs >0 时按工作区限流（滚轮连续切换避免每步抓图）
   */
  const captureWorkspaceSnapshot = useCallback(
    async (workspaceId: string, throttleMs = 0): Promise<void> => {
      if (workspaceSnapshotInFlightRef.current) return;
      const now = Date.now();
      const last = lastWorkspaceSnapshotAtRef.current[workspaceId] ?? 0;
      if (throttleMs > 0 && now - last < throttleMs) return;

      workspaceSnapshotInFlightRef.current = true;
      try {
        const windowId = await getCurrentWindowId();
        const rect = contentAreaRef.current?.getBoundingClientRect();
        const overlayPage = !isInternalPage && activeTabId !== null;
        const snapshot = await captureWindowSnapshot({
          windowId,
          activeTabId: overlayPage ? activeTabId : null,
          contentRect:
            overlayPage && rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null,
        });
        if (snapshot) {
          lastWorkspaceSnapshotAtRef.current[workspaceId] = Date.now();
          setWorkspaceSnapshots((prev) => ({ ...prev, [workspaceId]: snapshot }));
        }
      } finally {
        workspaceSnapshotInFlightRef.current = false;
      }
    },
    [activeTabId, isInternalPage, contentAreaRef],
  );

  // 自动采集当前工作区整窗快照（总览页卡片）：
  // 标签切换/加载完成后延迟一拍（等页面绘制稳定），同工作区 2.5s 限流。
  // 不阻塞工作区切换——总览打开时再补一次最新快照（见 handleOpenWorkspacesPage）。
  const activeTabLoading = activeTab?.loading ?? false;
  const activeTabUrl = activeTab?.url ?? '';
  useEffect(() => {
    if (isWorkspacesTab || activeTabId === null || activeTabLoading) return;
    const timer = window.setTimeout(() => {
      void captureWorkspaceSnapshot(currentWorkspaceId, 2500);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    activeTabId,
    activeTabUrl,
    activeTabLoading,
    currentWorkspaceId,
    isWorkspacesTab,
    captureWorkspaceSnapshot,
  ]);

  /** 切换工作区：有标签则激活该工作区最近激活/首个标签；空则自动新建主页标签。 */
  const handleSwitchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === currentWorkspaceId) return;
      setCurrentWorkspaceId(workspaceId);
      const list = tabs.filter((t) => (t.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId);
      const last = lastActiveByWorkspaceRef.current[workspaceId];
      const target = list.find((t) => t.id === last) ?? list[0];
      if (target) {
        if (target.id !== activeTabId) void doSelectTab(target.id);
        return;
      }
      // 空工作区：先检查是否有保存的标签可懒恢复（TP4）
      const saved = savedTabsByWorkspaceRef.current[workspaceId];
      if (saved && saved.length > 0) {
        // 只恢复一次：从 ref 中删除
        delete savedTabsByWorkspaceRef.current[workspaceId];
        void (async () => {
          try {
            const windowId = await getCurrentWindowId();
            let activeId: number | undefined;
            for (const tab of saved) {
              const res = (await window.urchin.invoke('tab.create', {
                windowId,
                url: tab.url,
                workspaceId,
                active: false,
              })) as { tab: { id: number } };
              if (tab.active) activeId = res.tab.id;
            }
            // 激活上次活跃的标签（或第一个创建的——TabManager 首个自动激活）
            if (activeId) {
              await window.urchin.invoke('tab.setActive', { tabId: activeId });
            }
          } catch (e) {
            console.error('Failed to restore saved tabs in workspace:', e);
          }
        })();
        return;
      }
      // 无保存标签：自动新建主页标签（TP7 确认行为）
      void (async () => {
        try {
          const windowId = await getCurrentWindowId();
          await window.urchin.invoke('tab.create', {
            windowId,
            url: 'urchin://newtab',
            active: true,
            workspaceId,
          });
        } catch (e) {
          console.error('Failed to open newtab in workspace:', e);
        }
      })();
    },
    [tabs, currentWorkspaceId, activeTabId, doSelectTab],
  );

  /** 滚轮切换（折叠态）：dir=1 下一个 / -1 上一个。 */
  const handleCycleWorkspace = useCallback(
    (dir: 1 | -1) => {
      if (workspaces.length === 0) return;
      const idx = workspaces.findIndex((w) => w.id === currentWorkspaceId);
      const nextIdx = idx + dir;
      // 不循环：到第一个/最后一个后继续滚动不再切换
      if (nextIdx < 0 || nextIdx >= workspaces.length) return;
      const next = workspaces[nextIdx];
      if (next) handleSwitchWorkspace(next.id);
    },
    [workspaces, currentWorkspaceId, handleSwitchWorkspace],
  );

  const handleCreateWorkspace = useCallback(
    async (name: string, color: WorkspaceColor): Promise<Workspace | undefined> => {
      try {
        const res = (await window.urchin.invoke('workspace.create', { name, color })) as {
          workspace: Workspace;
        };
        await refreshWorkspaces();
        return res.workspace;
      } catch (e) {
        console.error('Failed to create workspace:', e);
        return undefined;
      }
    },
    [refreshWorkspaces],
  );

  /** 创建后切换到新工作区（入口保留原行为：创建 → 切过去）。 */
  const handleCreateAndSwitchWorkspace = useCallback(
    async (name: string, color: WorkspaceColor) => {
      const ws = await handleCreateWorkspace(name, color);
      if (ws) handleSwitchWorkspace(ws.id);
    },
    [handleCreateWorkspace, handleSwitchWorkspace],
  );

  // 工作区总览页（urchin://workspaces）点卡切换：激活该工作区的最近激活标签（或第一个），
  // 再关闭总览页；空工作区则新建主页标签。原为 WorkspaceOverviewPage JSX 内联闭包，
  // 随 ContentArea 抽取提升为具名回调（逻辑原样，闭包依赖不变）。
  const handleOverviewSwitch = useCallback(
    (workspaceId: string) => {
      void (async () => {
        // 排除总览页自身：总览 tab 归属当前工作区，若将其作为「最近激活标签」
        // 激活后再关闭，会导致主进程移除 active tab 时自动激活到任意剩余 tab
        const list = tabs.filter(
          (t) =>
            (t.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId &&
            !t.url.startsWith('urchin://workspaces'),
        );
        const last = lastActiveByWorkspaceRef.current[workspaceId];
        const target = list.find((t) => t.id === last) ?? list[0];
        setCurrentWorkspaceId(workspaceId);
        if (target) {
          // 先激活目标标签（总览页变为 inactive），再关闭总览页；
          // 否则关闭 active 的总览页会让主进程激活任意剩余 tab
          if (target.id !== activeTabId) await doSelectTab(target.id);
        } else {
          // 空工作区：新建主页标签（目标工作区）
          const windowId = await getCurrentWindowId();
          await window.urchin.invoke('tab.create', {
            windowId,
            url: 'urchin://newtab',
            active: true,
            workspaceId,
          });
        }
        // 此刻总览页已非 active，安全关闭
        if (activeTabId != null) handleCloseTab(activeTabId);
      })();
    },
    [tabs, activeTabId, doSelectTab, handleCloseTab],
  );

  // 工作区总览页新建工作区：创建后切到新工作区——先在工作区内新建主页标签（await 确保
  // 标签已激活），再关闭总览页——否则关闭总览页时标签管理器会自动激活旧工作区的标签，
  // 导致 currentWorkspaceId 被同步回旧工作区，新创建的工作区看起来像被"自动删除"了。
  // 空工作区在 registry 中持久化保留，不因无存储标签而被删除。
  const handleOverviewCreate = useCallback(
    async (name: string, color: WorkspaceColor) => {
      const ws = await handleCreateWorkspace(name, color);
      if (ws) {
        setCurrentWorkspaceId(ws.id);
        const windowId = await getCurrentWindowId();
        await window.urchin.invoke('tab.create', {
          windowId,
          url: 'urchin://newtab',
          active: true,
          workspaceId: ws.id,
        });
        if (activeTabId != null) handleCloseTab(activeTabId);
      }
    },
    [handleCreateWorkspace, activeTabId, handleCloseTab],
  );

  const handleUpdateWorkspace = useCallback(
    async (id: string, patch: { name?: string; color?: WorkspaceColor }) => {
      await window.urchin.invoke('workspace.update', { id, ...patch });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  const handleRemoveWorkspace = useCallback(
    async (id: string) => {
      await window.urchin.invoke('workspace.remove', { id });
      await refreshWorkspaces();
      // 删除当前工作区后：切到默认工作区并激活/新建标签（仅 setCurrentWorkspaceId
      // 会导致 activeTabId 为 null、中区无内容渲染的降级状态）
      if (currentWorkspaceId === id) handleSwitchWorkspace(DEFAULT_WORKSPACE_ID);
    },
    [refreshWorkspaces, currentWorkspaceId, handleSwitchWorkspace],
  );

  const handleClearWorkspaceData = useCallback(
    async (id: string) => {
      await window.urchin.invoke('workspace.clearData', { id });
      await refreshWorkspaces();
    },
    [refreshWorkspaces],
  );

  /** 在另一工作区打开当前页（标签右键菜单）。 */
  const handleOpenInWorkspace = useCallback(async (workspaceId: string, tab: { url: string }) => {
    try {
      const windowId = await getCurrentWindowId();
      await window.urchin.invoke('tab.create', {
        windowId,
        url: tab.url,
        active: true,
        workspaceId,
      });
    } catch (e) {
      console.error('Failed to open in workspace:', e);
    }
  }, []);

  /** 新建工作区并打开当前页（标签右键菜单兜底）。 */
  const handleOpenInNewWorkspace = useCallback(
    async (tab: { url: string }) => {
      try {
        const res = (await window.urchin.invoke('workspace.create', {
          name: '新工作区',
          color: 'violet',
        })) as { workspace: Workspace };
        await refreshWorkspaces();
        await handleOpenInWorkspace(res.workspace.id, tab);
      } catch (e) {
        console.error('Failed to create workspace and open:', e);
      }
    },
    [refreshWorkspaces, handleOpenInWorkspace],
  );

  /**
   * 折叠态 cards 模式：点击工作区图标 = 切换总览页（toggle）。
   * - 总览页正激活 → 关闭它（再次点击关闭）
   * - 总览页已存在但非激活 → 激活它（不另开新标签）
   * - 不存在 → 新建总览页标签
   */
  const handleOpenWorkspacesPage = useCallback(() => {
    // 1. 总览页正激活 → 关闭（toggle off）
    if (isWorkspacesTab && activeTabId != null) {
      void doCloseTab(activeTabId);
      return;
    }
    // 2. 总览页已存在但非激活 → 激活（不另开新标签）；仅搜索当前工作区的总览标签，
    //    避免跨工作区激活旧总览导致用户被切回另一工作区
    const existingOverview = tabs.find(
      (t) =>
        t.url?.startsWith('urchin://workspaces') &&
        (t.workspaceId ?? DEFAULT_WORKSPACE_ID) === currentWorkspaceId,
    );
    if (existingOverview) {
      void doSelectTab(existingOverview.id);
      return;
    }
    // 3. 不存在 → 新建
    void (async () => {
      await captureWorkspaceSnapshot(currentWorkspaceId);
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url: 'urchin://workspaces',
          active: true,
          workspaceId: currentWorkspaceId,
        });
      } catch (e) {
        console.error('Failed to open workspaces page:', e);
      }
    })();
  }, [
    isWorkspacesTab,
    activeTabId,
    tabs,
    doCloseTab,
    doSelectTab,
    currentWorkspaceId,
    captureWorkspaceSnapshot,
  ]);

  /** 总览页数据：每工作区一张卡片 + 已采集的整窗快照（无快照时组件渲染占位）。 */
  const workspaceOverviewItems: readonly WorkspaceOverviewItem[] = useMemo(
    () =>
      workspaces.map((ws) => ({
        workspace: ws,
        snapshot: workspaceSnapshots[ws.id],
      })),
    [workspaces, workspaceSnapshots],
  );

  // 当前工作区的标签（展开/折叠列表都按工作区过滤，TP7）
  // 工作区总览页（urchin://workspaces）视为瞬态：点击查看不驻留为侧边栏图标，
  // 与既有「不持久化 / 不计入最近激活」待遇对齐（main/index.ts 退出过滤、855 行 lastActive 排除）
  const visibleTabs = tabs.filter(
    (t) =>
      (t.workspaceId ?? DEFAULT_WORKSPACE_ID) === currentWorkspaceId &&
      !t.url.startsWith('urchin://workspaces'),
  );

  return {
    workspaces,
    currentWorkspaceId,
    workspaceOverviewItems,
    visibleTabs,
    handleSwitchWorkspace,
    handleCycleWorkspace,
    handleCreateAndSwitchWorkspace,
    handleOverviewSwitch,
    handleOverviewCreate,
    handleUpdateWorkspace,
    handleRemoveWorkspace,
    handleClearWorkspaceData,
    handleOpenInWorkspace,
    handleOpenInNewWorkspace,
    handleOpenWorkspacesPage,
  } as const;
}
