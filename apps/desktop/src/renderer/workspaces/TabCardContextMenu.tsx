/**
 * 标签卡片右键菜单（TP7）：在另一工作区打开当前页 / 新建工作区 / 关闭标签。
 * 纯渲染浮层，业务动作由父级回调处理。
 */
import { useEffect } from 'react';
import { ExternalLink, Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Workspace } from './types';

/** 菜单消费的最小标签形状（无耦合 App 内部 TabSnapshot）。 */
export interface MenuTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly workspaceId: string;
}

export interface TabCardContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly tab: MenuTab;
  readonly workspaces: readonly Workspace[];
  readonly onClose: () => void;
  /** 以当前 URL 在指定工作区新建标签并激活。 */
  readonly onOpenInWorkspace: (workspaceId: string, tab: MenuTab) => void;
  /** 新建工作区后再在其中打开当前 URL。 */
  readonly onOpenInNewWorkspace: (tab: MenuTab) => void;
  readonly onCloseTab: (tabId: number) => void;
}

export function TabCardContextMenu({
  x,
  y,
  tab,
  workspaces,
  onClose,
  onOpenInWorkspace,
  onOpenInNewWorkspace,
  onCloseTab,
}: TabCardContextMenuProps): React.JSX.Element {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const others = workspaces.filter((w) => w.id !== tab.workspaceId);
  // 菜单尺寸 256x~380，简单防溢出
  const left = Math.max(8, Math.min(x, window.innerWidth - 264));
  const top = Math.max(8, Math.min(y, window.innerHeight - Math.min(380, 96 + others.length * 40)));

  return (
    <>
      {/* 点击外部关闭 */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-50 w-64 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-dropdown"
        style={{ left, top }}
        role="menu"
      >
        <div className="px-3 pb-1 pt-1.5 text-xs text-text-secondary">在另一工作区打开当前页</div>
        <div className="max-h-56 overflow-y-auto">
          {others.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-text-secondary/70">暂无可切换的工作区</div>
          )}
          {others.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text hover:bg-surface-secondary"
              onClick={() => {
                onOpenInWorkspace(w.id, tab);
                onClose();
              }}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-[9px] font-semibold text-white',
                  w.color === 'blue' && 'bg-blue-500',
                  w.color === 'green' && 'bg-emerald-500',
                  w.color === 'amber' && 'bg-amber-500',
                  w.color === 'rose' && 'bg-rose-500',
                  w.color === 'violet' && 'bg-violet-500',
                  w.color === 'cyan' && 'bg-cyan-500',
                )}
              >
                {w.name.trim().charAt(0).toUpperCase() || '默'}
              </span>
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <ExternalLink className="h-3 w-3 shrink-0 text-text-secondary" />
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text hover:bg-surface-secondary"
            onClick={() => {
              onOpenInNewWorkspace(tab);
              onClose();
            }}
          >
            <Plus className="h-4 w-4 shrink-0 text-text-secondary" />
            <span>新建工作区并在此打开…</span>
          </button>
        </div>
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-error hover:bg-error/10"
          onClick={() => {
            onCloseTab(tab.id);
            onClose();
          }}
        >
          <X className="h-4 w-4 shrink-0" />
          <span>关闭标签</span>
        </button>
      </div>
    </>
  );
}
