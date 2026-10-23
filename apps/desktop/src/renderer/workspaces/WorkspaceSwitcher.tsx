/**
 * 工作区折叠态切换器（TP7）：折叠栏顶部单工作区首字图标。
 *
 * 两种模式（由设置 ui.workspaceSwitcherMode 决定，参考 ego-lite Space 卡片设计）：
 * - 'wheel'：鼠标停放在图标上滚动滚轮 = 循环切换工作区（默认，原行为）
 * - 'cards'：点击图标 = 打开工作区总览页（urchin://workspaces，卡片网格 + 网页缩略图），
 *   Cards 模式滚轮不拦截
 * 两种模式均保留悬停抑制侧栏自动展开（由父级处理）。
 */
import { cn } from '../lib/utils';
import type { Workspace } from './types';
import { WORKSPACE_COLORS, workspaceInitial } from './workspace-colors';

/** 折叠态工作区切换模式（与设置 ui.workspaceSwitcherMode 的值对齐）。 */
export type WorkspaceSwitcherMode = 'wheel' | 'cards';

export interface WorkspaceSwitcherProps {
  readonly workspace: Workspace | undefined;
  /** 切换模式：wheel=滚轮循环；cards=点击打开工作区总览页。 */
  readonly mode: WorkspaceSwitcherMode;
  /** dir=1 下一个 / -1 上一个（滚轮向下=next，向上=prev）。仅 wheel 模式使用。 */
  readonly onCycle: (dir: 1 | -1) => void;
  /** wheel 模式=切换侧栏展开；cards 模式=打开工作区总览页。 */
  readonly onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
}

export function WorkspaceSwitcher({
  workspace,
  mode,
  onCycle,
  onClick,
  onPointerEnter,
  onPointerLeave,
}: WorkspaceSwitcherProps): React.JSX.Element {
  const cardsMode = mode === 'cards';
  return (
    <button
      type="button"
      className={cn(
        'group relative flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-md border shadow-sm',
        'border-border/60 bg-surface hover:border-primary/40',
      )}
      title={
        workspace
          ? cardsMode
            ? `${workspace.name}（点击打开工作区总览）`
            : `${workspace.name}（滚轮切换工作区）`
          : '无工作区'
      }
      aria-label={workspace ? `切换工作区：${workspace.name}` : '无工作区'}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
      onWheel={(e) => {
        // cards 模式滚轮不拦截（不循环切换，让侧栏标签列表正常滚动）
        if (cardsMode) return;
        e.preventDefault();
        onCycle(e.deltaY > 0 ? 1 : -1);
      }}
    >
      {workspace ? (
        <span
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white',
            WORKSPACE_COLORS[workspace.color]?.avatar ?? 'bg-gray-500',
          )}
        >
          {workspaceInitial(workspace.name)}
        </span>
      ) : (
        <span className="text-text-secondary">—</span>
      )}
      {/* 多工作区提示点：图标右下角的小色点 */}
      {workspace && (
        <span
          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary/70"
          aria-hidden
        />
      )}
    </button>
  );
}
