/**
 * 工作区选项卡条（TP7）：右侧栏展开态标题位。
 * 每个选项卡 = 首字头像 + 工作区名；右键弹出管理工作区菜单；末尾「+」快速创建。
 */
import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Workspace, WorkspaceColor } from './types';
import { WORKSPACE_COLORS, WORKSPACE_COLOR_KEYS } from './workspace-colors';
import { WorkspaceAvatar } from './WorkspaceAvatar';

export interface WorkspaceBarProps {
  readonly workspaces: readonly Workspace[];
  readonly currentWorkspaceId: string;
  readonly onSelect: (id: string) => void;
  readonly onCreate: (name: string, color: WorkspaceColor) => Promise<void>;
  readonly onContextMenu: (e: React.MouseEvent, workspace: Workspace) => void;
}

export function WorkspaceBar({
  workspaces,
  currentWorkspaceId,
  onSelect,
  onCreate,
  onContextMenu,
}: WorkspaceBarProps): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkspaceColor>('blue');

  const submitCreate = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void onCreate(trimmed, color).then(() => {
      setName('');
      setColor('blue');
      setCreating(false);
    });
  };

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {workspaces.map((ws) => {
          const active = ws.id === currentWorkspaceId;
          const colorInfo = WORKSPACE_COLORS[ws.color];
          return (
            <button
              key={ws.id}
              type="button"
              title={`${ws.name}${active ? '（当前工作区）' : ''} — 右键管理`}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e, ws);
              }}
              onClick={() => onSelect(ws.id)}
              className={cn(
                'relative flex shrink-0 items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-xs transition-colors',
                active
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
              )}
            >
              <WorkspaceAvatar workspace={ws} />
              <span className="max-w-[84px] truncate">{ws.name}</span>
              {/* 当前工作区在名称下加一条主题色底线，弱化「选项卡」与「标签卡片」区分 */}
              {active && (
                <span
                  className={cn(
                    'absolute bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full',
                    colorInfo.avatar,
                  )}
                />
              )}
              {active && (
                <span aria-hidden className={cn('ml-0.5', colorInfo.activeText)}>
                  <Check className="h-3 w-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-label="新建工作区"
        title="新建工作区"
        onClick={() => setCreating((v) => !v)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
      >
        <Plus className="h-4 w-4" />
      </button>

      {creating && (
        <>
          {/* 点击外部关闭 */}
          <div className="fixed inset-0 z-40" onClick={() => setCreating(false)} />
          <div className="absolute right-2 top-11 z-50 w-52 rounded-lg border border-border bg-surface p-3 shadow-dropdown">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="工作区名称"
              maxLength={32}
              className="w-full rounded-md border border-border bg-surface-secondary px-2 py-1.5 text-sm text-text outline-none focus:border-primary/50"
            />
            <div className="mt-2 flex items-center gap-1.5">
              {WORKSPACE_COLOR_KEYS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`颜色 ${c}`}
                  onClick={() => setColor(c)}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full transition-transform',
                    WORKSPACE_COLORS[c].avatar,
                    color === c
                      ? 'scale-110 ring-2 ring-primary/60'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {color === c && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={submitCreate}
              disabled={!name.trim()}
              className="mt-3 w-full rounded-md bg-primary py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              创建工作区
            </button>
          </div>
        </>
      )}
    </div>
  );
}
