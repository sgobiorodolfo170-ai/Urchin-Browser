/**
 * 工作区选项卡条（TP7）：右侧栏展开态标题位。
 * 每个选项卡 = 纯色方形色块（不显示文字/首字，仅以颜色区分）；右键弹出管理工作区菜单；末尾「+」快速创建。
 */
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Plus, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Workspace, WorkspaceColor } from './types';
import { WORKSPACE_COLORS, WORKSPACE_COLOR_KEYS } from './workspace-colors';

export interface WorkspaceBarProps {
  readonly workspaces: readonly Workspace[];
  readonly currentWorkspaceId: string;
  readonly onSelect: (id: string) => void;
  readonly onCycle: (dir: 1 | -1) => void;
  readonly onCreate: (name: string, color: WorkspaceColor) => Promise<void>;
  readonly onContextMenu: (e: React.MouseEvent, workspace: Workspace) => void;
}

export function WorkspaceBar({
  workspaces,
  currentWorkspaceId,
  onSelect,
  onCycle,
  onCreate,
  onContextMenu,
}: WorkspaceBarProps): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkspaceColor>('blue');

  /** 滚动容器 ref + 活动按钮 ref + 鼠标位置（用于滚轮切换后将选中图标滚动到鼠标处）。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeBtnRef = useRef<HTMLButtonElement>(null);
  const mouseClientXRef = useRef<number | null>(null);

  /**
   * 原生非被动 wheel 监听：React onWheel 在 17+ 为 passive，preventDefault 无效——
   * 容器 overflow-x-auto 会同时原生滚动，与我们的 scrollBy 修正互相打架。
   * 改用 addEventListener({ passive: false }) 确保 preventDefault 生效：滚轮只触发
   * onCycle 切换，不触发容器原生滚动；切换后 useEffect 再把选中图标 scrollBy 到鼠标处。
   */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // 从 wheel 事件直接取鼠标 X（比 onMouseMove 更可靠——快速滚轮时鼠标可能没移动）
      mouseClientXRef.current = e.clientX;
      onCycle(e.deltaY > 0 ? 1 : -1);
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [onCycle]);

  /**
   * 选中工作区变化后：把选中图标滚动到鼠标当前位置（鼠标即焦点，不因切换而失焦）。
   * 用 useLayoutEffect（DOM 提交后、绘制前同步执行）：避免按钮先闪现在旧位置再跳到鼠标处。
   * 用 behavior:'auto'（瞬移）而非 'smooth'：快速连续滚轮时 smooth 动画会互相打断抖动。
   */
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const btn = activeBtnRef.current;
    if (!container || !btn) return;
    const mouseX = mouseClientXRef.current;
    if (mouseX === null) {
      btn.scrollIntoView({ inline: 'center', block: 'nearest' });
      return;
    }
    // 计算使选中按钮中心对齐鼠标 X 的滚动量。
    // scrollBy({ left: delta })：delta>0 = 向右滚动 → 内容向左移 → 按钮视口位置减小。
    // 按钮中心在鼠标右侧时需向右滚动（delta>0），故 delta = btnCenter - mouseX。
    const btnRect = btn.getBoundingClientRect();
    const btnCenter = btnRect.left + btnRect.width / 2;
    const delta = btnCenter - mouseX;
    if (Math.abs(delta) > 1) {
      container.scrollBy({ left: delta, behavior: 'auto' });
    }
  }, [currentWorkspaceId]);

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
      <div
        ref={scrollRef}
        onMouseMove={(e) => {
          mouseClientXRef.current = e.clientX;
        }}
        onMouseLeave={() => {
          mouseClientXRef.current = null;
        }}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {workspaces.map((ws) => {
          const active = ws.id === currentWorkspaceId;
          const colorInfo = WORKSPACE_COLORS[ws.color];
          return (
            <button
              key={ws.id}
              ref={active ? activeBtnRef : undefined}
              type="button"
              aria-label={ws.name}
              title={`${ws.name}${active ? '（当前工作区）' : ''} — 右键管理 / 滚轮切换`}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(e, ws);
              }}
              onClick={() => onSelect(ws.id)}
              className={cn(
                'shrink-0 rounded-none transition-all',
                active ? 'h-9 w-9 z-10 shadow-lg' : 'h-7 w-7 opacity-70 hover:opacity-100',
                colorInfo.avatar,
              )}
            />
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
                    'flex h-5 w-5 items-center justify-center rounded-md transition-transform',
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
