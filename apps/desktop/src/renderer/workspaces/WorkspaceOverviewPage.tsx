/**
 * 工作区总览页（urchin://workspaces，参考 ego-lite Space 卡片设计）。
 *
 * 折叠态「点击卡片切换」模式的核心页面：只保留卡片网格，无标题/说明文字。
 * 每张卡片是该工作区**整个浏览器窗口**的截图（由 App 采集并注入 snapshot）：
 * - 窗口 UI（侧栏/地址栏）来自 window.captureUi
 * - 激活标签网页来自 tab.captureThumbnail，按内容区矩形叠加
 * 卡片宽高比 = 浏览器窗口宽高比（随窗口 resize 更新）；卡片内禁用阴影，
 * 工作区名用实色胶囊标签；页面背景透明，直接透出 App 根节点的窗口级统一渐变。
 *
 * 数据全部由 App 推导注入；本组件只负责展示与交互（切换/新建）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Workspace, WorkspaceColor } from './types';
import { WORKSPACE_COLORS, WORKSPACE_COLOR_KEYS, workspaceInitial } from './workspace-colors';
import { extractIpcMessage } from './types';

/** 单个工作区在总览页的展示数据（App 计算后注入）。 */
export interface WorkspaceOverviewItem {
  readonly workspace: Workspace;
  /** 整窗截图（JPEG data URL）；无快照时渲染占位色块。 */
  readonly snapshot?: string;
}

export interface WorkspaceOverviewPageProps {
  readonly items: readonly WorkspaceOverviewItem[];
  readonly currentWorkspaceId: string;
  /** 切换工作区并关闭本页（App 处理）。 */
  readonly onSwitch: (workspaceId: string) => void;
  /** 新建工作区（命名 + 颜色），成功后切过去并关闭本页。 */
  readonly onCreate: (name: string, color: WorkspaceColor) => Promise<void>;
}

/** 读取浏览器窗口宽高比（含 UI）。 */
function readWindowAspect(): number {
  return window.innerWidth / Math.max(1, window.innerHeight);
}

/** 浏览器窗口宽高比（含 UI），随窗口 resize 更新；卡片按该比例展示整窗截图。 */
function useWindowAspect(): number {
  const [aspect, setAspect] = useState(readWindowAspect);
  useEffect(() => {
    const onResize = (): void => setAspect(readWindowAspect());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return aspect;
}

/**
 * 工作区卡片：整窗截图 + 指针跟随的 3D 悬浮。
 *
 * 结构为什么分两层：
 * - 外层 button 是**固定比例的平面命中区**：3D transform 若直接加在按钮上，
 *   倾斜/上浮会把指针“推离”命中区，触发 pointerleave → 复位抖动；
 * - 内层视觉层承载截图/边框/名称/高光并执行 transform，命中区保持稳定。
 * 指针移动只写 CSS 变量（不触发 React 重渲染），倾斜与高光共用同一组变量；
 * 卡片内不使用任何阴影（名称用实色胶囊标签），激活态用 outline 描边表达。
 */
function WorkspaceCard({
  item,
  active,
  aspect,
  onSwitch,
}: {
  readonly item: WorkspaceOverviewItem;
  readonly active: boolean;
  readonly aspect: number;
  readonly onSwitch: (workspaceId: string) => void;
}): React.JSX.Element {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const colorInfo = WORKSPACE_COLORS[item.workspace.color];

  const resetTilt = useCallback((): void => {
    const el = cardRef.current;
    if (!el) return;
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
    el.style.setProperty('--lift', '0px');
    el.style.setProperty('--scale', '1');
    el.style.setProperty('--glow-opacity', '0');
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offsetX = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
    const offsetY = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
    // 倾斜幅度 ±10°/±15°、抬升 16px、放大 5%：比上一版更明显的 3D 悬浮，
    // 但仍控制整窗截图的透视拉伸，避免文字与网页缩略图失真。
    el.style.setProperty('--tilt-x', `${(-offsetY * 10).toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${(offsetX * 15).toFixed(2)}deg`);
    el.style.setProperty('--lift', '-16px');
    el.style.setProperty('--scale', '1.05');
    el.style.setProperty('--glow-x', `${((offsetX + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--glow-y', `${((offsetY + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--glow-opacity', '1');
  }, []);

  return (
    <button
      ref={cardRef}
      type="button"
      title={`切换到工作区 ${item.workspace.name}`}
      onClick={() => onSwitch(item.workspace.id)}
      onPointerMove={handlePointerMove}
      onPointerLeave={resetTilt}
      onPointerCancel={resetTilt}
      onBlur={resetTilt}
      className="relative block w-full rounded-xl text-left outline-none hover:z-10 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      style={{ aspectRatio: String(aspect) }}
    >
      <span
        data-workspace-card-visual="true"
        className={cn(
          'absolute inset-0 block overflow-hidden rounded-xl border bg-surface-secondary',
          'transition-[transform,border-color] duration-150 ease-out will-change-transform motion-reduce:transition-none',
          active
            ? 'border-primary/70 outline outline-2 outline-primary/50 outline-offset-2'
            : 'border-border hover:border-primary/60',
        )}
        style={{
          transform:
            'perspective(900px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg)) translateY(var(--lift, 0px)) scale(var(--scale, 1))',
        }}
      >
        {item.snapshot ? (
          <img
            src={item.snapshot}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className={cn('absolute inset-0 flex items-center justify-center', colorInfo.avatar)}
          >
            <span className="text-3xl font-semibold text-white/90">
              {workspaceInitial(item.workspace.name)}
            </span>
          </span>
        )}
        {/* 指针跟随高光：只做受光提亮，不遮挡截图内容 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-200 motion-reduce:transition-none"
          style={{
            opacity: 'var(--glow-opacity, 0)',
            background:
              'radial-gradient(380px circle at var(--glow-x, 50%) var(--glow-y, 50%), rgba(255,255,255,0.4), transparent 64%)',
          }}
        />
        {/* 工作区名：实色胶囊标签（无渐变/无阴影），保持整窗截图比例不被底部遮罩侵占 */}
        <span className="absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', colorInfo.avatar)} />
          <span className="min-w-0 truncate">{item.workspace.name}</span>
        </span>
      </span>
    </button>
  );
}

/** 新建工作区卡片（虚线边框 + 命名 + 色板），比例与窗口一致。 */
function NewWorkspaceCard({
  onCreate,
  aspect,
}: {
  readonly onCreate: (name: string, color: WorkspaceColor) => Promise<void>;
  readonly aspect: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkspaceColor>('blue');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = useCallback(async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError('');
    try {
      await onCreate(trimmed, color);
      // 成功：App 负责切换并关页，本组件无需自关
    } catch (err) {
      setError(extractIpcMessage(err));
      setSaving(false);
    }
  }, [name, color, onCreate]);

  return (
    <div className="relative" style={{ aspectRatio: String(aspect) }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-full w-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-black/[0.14] text-text-secondary transition-all duration-150 hover:-translate-y-1.5 hover:border-primary/50 hover:bg-black/20 hover:text-text dark:bg-black/30 dark:hover:bg-black/40"
        aria-label="新建工作区"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-secondary">
          <Plus className="h-5 w-5" />
        </span>
      </button>

      {open && (
        <>
          <span
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <span
            className="absolute left-1/2 top-1/2 z-50 w-64 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-3 shadow-dropdown"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="工作区名称"
              maxLength={32}
              className="w-full rounded-md border border-border bg-surface-secondary px-2 py-1.5 text-sm text-text outline-none focus:border-primary/50"
            />
            <div className="mt-2 flex items-center gap-1.5">
              {WORKSPACE_COLOR_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={`颜色 ${key}`}
                  onClick={() => setColor(key)}
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full transition-transform',
                    WORKSPACE_COLORS[key].avatar,
                    color === key
                      ? 'scale-110 ring-2 ring-primary/60'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {color === key && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </button>
              ))}
            </div>
            {error && <p className="mt-2 text-xs text-error">{error}</p>}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!name.trim() || saving}
              className="mt-3 w-full rounded-md bg-primary py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {saving ? '创建中…' : '创建工作区'}
            </button>
          </span>
        </>
      )}
    </div>
  );
}

export function WorkspaceOverviewPage({
  items,
  currentWorkspaceId,
  onSwitch,
  onCreate,
}: WorkspaceOverviewPageProps): React.JSX.Element {
  const aspect = useWindowAspect();

  return (
    <div
      className="flex min-h-full w-full items-center justify-center overflow-y-auto bg-transparent px-10 py-8 text-text"
      aria-label="工作区总览"
    >
      <div
        className="grid w-full max-w-6xl gap-5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
      >
        {items.map((item) => (
          <WorkspaceCard
            key={item.workspace.id}
            item={item}
            active={item.workspace.id === currentWorkspaceId}
            aspect={aspect}
            onSwitch={onSwitch}
          />
        ))}

        <NewWorkspaceCard onCreate={onCreate} aspect={aspect} />
      </div>
    </div>
  );
}
