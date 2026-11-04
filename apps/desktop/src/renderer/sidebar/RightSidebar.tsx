/**
 * 右侧边栏
 *
 * 结构：宽度拖拽手柄（展开态）+ 展开态（工作区选项卡条 + 标签卡片列表）/
 * 折叠态（工作区图标 + 当前工作区标签图标列）。
 *
 * 与 LeftSidebar 同一模式：尺寸与悬停展开状态由 App 持有（rightWidth 同时
 * 驱动主进程 BrowserView bounds），本组件只消费状态并通过回调上抛动作，
 * 避免布局真源分裂。（refactor-plan-p2 §2.3 步骤 3，JSX 自 App.tsx 原样迁出）
 */
import { TabBar } from '../tabs/TabBar';
import type { TabSnapshot } from '../tabs/types';
import { WorkspaceBar } from '../workspaces/WorkspaceBar';
import { WorkspaceSwitcher, type WorkspaceSwitcherMode } from '../workspaces/WorkspaceSwitcher';
import type { Workspace, WorkspaceColor } from '../workspaces/types';
import type { useWindowDrag } from '../lib/use-window-drag';
import { cn } from '../lib/utils';

export interface RightSidebarProps {
  readonly asideRef: React.RefObject<HTMLElement>;
  /** 展开宽度（App 由 rightExpandedWidth/rightHovered 计算后的实际渲染宽度） */
  readonly width: number;
  /** 展开 or 悬停预览展开（控制拖拽手柄与内容分支） */
  readonly effectiveExpanded: boolean;
  /** 拖拽调节中：禁用宽度 transition 保证跟手 */
  readonly resizing: boolean;
  /** 回弹动画标记：true 时使用带过冲的弹性缓动 */
  readonly retracting: boolean;
  /** 外框拖窗（App 持有唯一 useWindowDrag 实例，侧栏与外框共用） */
  readonly windowDrag: ReturnType<typeof useWindowDrag>;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onDoubleClick: (e: React.MouseEvent) => void;
  readonly onResizeStart: (e: React.PointerEvent) => void;
  readonly onResizeMove: (e: React.PointerEvent) => void;
  readonly onResizeEnd: (e: React.PointerEvent) => void;
  // WorkspaceBar（展开态选项卡条）
  readonly workspaces: readonly Workspace[];
  readonly currentWorkspaceId: string;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onCycleWorkspace: (direction: 1 | -1) => void;
  readonly onCreateWorkspace: (name: string, color: WorkspaceColor) => Promise<void>;
  readonly onWorkspaceContextMenu: (e: React.MouseEvent, workspace: Workspace) => void;
  // TabBar（展开/折叠两态共用）
  readonly tabs: readonly TabSnapshot[];
  readonly activeTabId: number | null;
  readonly onSelectTab: (tabId: number) => void;
  readonly onCloseTab: (tabId: number) => void;
  readonly onNewTab: () => void;
  readonly onTabPointerDown: (e: React.PointerEvent, tab: TabSnapshot) => void;
  readonly onTabPointerMove: (e: React.PointerEvent) => void;
  readonly onTabPointerEnd: () => void;
  readonly onTabContextMenu: (e: React.MouseEvent, tab: TabSnapshot) => void;
  // WorkspaceSwitcher（折叠态图标）
  readonly switcherMode: WorkspaceSwitcherMode;
  readonly onSwitcherCycle: (direction: 1 | -1) => void;
  readonly onSwitcherClick: () => void;
  readonly onSwitcherPointerEnter: () => void;
  readonly onSwitcherPointerLeave: () => void;
}

export function RightSidebar({
  asideRef,
  width,
  effectiveExpanded,
  resizing,
  retracting,
  windowDrag,
  onMouseEnter,
  onMouseLeave,
  onDoubleClick,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  workspaces,
  currentWorkspaceId,
  onSelectWorkspace,
  onCycleWorkspace,
  onCreateWorkspace,
  onWorkspaceContextMenu,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onTabPointerDown,
  onTabPointerMove,
  onTabPointerEnd,
  onTabContextMenu,
  switcherMode,
  onSwitcherCycle,
  onSwitcherClick,
  onSwitcherPointerEnter,
  onSwitcherPointerLeave,
}: RightSidebarProps) {
  return (
    <aside
      ref={asideRef}
      className={cn(
        'relative flex shrink-0 flex-col border-l border-border bg-transparent',
        resizing
          ? ''
          : retracting
            ? 'transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]'
            : 'transition-[width] duration-150 ease-out',
      )}
      style={{ width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}
      onPointerDown={windowDrag.startDrag}
      onPointerMove={windowDrag.moveDrag}
      onPointerUp={windowDrag.endDrag}
      onPointerCancel={windowDrag.endDrag}
      aria-label="右侧边栏"
    >
      {/* 宽度调节手柄：展开态下渲染于栏左缘内侧（避免与 BrowserView 重叠），
       *  鼠标移入手柄区域变横向调节光标，按住左右拖动调宽 */}
      {effectiveExpanded && (
        <div
          className="absolute top-0 bottom-12 left-0 z-10 w-1.5 cursor-col-resize"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          aria-label="调节右侧栏宽度"
          role="separator"
        />
      )}
      {effectiveExpanded ? (
        <>
          {/* 工作区选项卡条（TP7）：替换原「标签页」标题位 */}
          <WorkspaceBar
            workspaces={workspaces}
            currentWorkspaceId={currentWorkspaceId}
            onSelect={onSelectWorkspace}
            onCycle={onCycleWorkspace}
            onCreate={onCreateWorkspace}
            onContextMenu={onWorkspaceContextMenu}
          />

          {/* 标签列表：凸起悬浮感（卡片浮于底色之上，带阴影 + 微光边框 + 顶部高光） */}
          <TabBar
            expanded
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onNewTab={onNewTab}
            onTabPointerDown={onTabPointerDown}
            onTabPointerMove={onTabPointerMove}
            onTabPointerEnd={onTabPointerEnd}
            onTabContextMenu={onTabContextMenu}
          />
        </>
      ) : (
        // 折叠状态：顶部单工作区图标（滚轮切换）+ 当前工作区的标签图标。
        // 悬停工作区图标时抑制侧栏自动展开，滚轮切换不被打断。
        <div className="flex flex-1 flex-col items-center overflow-hidden pb-2">
          {/* 工作区图标固定在最顶部（无上方留白，用户指令 2026-10-23） */}
          <WorkspaceSwitcher
            workspace={workspaces.find((w) => w.id === currentWorkspaceId)}
            mode={switcherMode}
            onCycle={onSwitcherCycle}
            onClick={onSwitcherClick}
            onPointerEnter={onSwitcherPointerEnter}
            onPointerLeave={onSwitcherPointerLeave}
          />
          <TabBar
            expanded={false}
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onNewTab={onNewTab}
            onTabPointerDown={onTabPointerDown}
            onTabPointerMove={onTabPointerMove}
            onTabPointerEnd={onTabPointerEnd}
            onTabContextMenu={onTabContextMenu}
          />
        </div>
      )}

      {/* 底部折叠/展开按钮已移除（2026-08-14）：改为双击右侧边栏空白处展开/折叠，
       *  由 aside 的 onDoubleClick 处理；与悬停自动展开互斥（设置开关控制）。 */}
    </aside>
  );
}
