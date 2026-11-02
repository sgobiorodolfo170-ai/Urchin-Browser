/**
 * 笔记页 · 右区无限画布便利贴
 *
 * 交互：
 * - 滚轮以鼠标停留处为焦点缩放；拖拽空白区域平移
 * - 双击空白 / 点击 + 新建便利贴；Ctrl+V 粘贴文本时在视口中心新建
 * - 便利贴：左键拖标题栏移动；中键（滚轮中键）按住便利贴任意位置拖动移动；
 *   右下角调整尺寸；切换颜色；删除
 * - 无限十字坐标系标尺：过世界原点的 X/Y 轴 + 数值刻度，随平移/缩放联动
 *
 * 坐标约定：便利贴 x/y 为世界坐标，视口只改变 translate/scale，
 * 因此缩放/平移不会改变便利贴之间的相对位置。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  GripVertical,
  Plus,
  RotateCcw,
  StickyNote as StickyNoteIcon,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { makeNotebookId } from './normalize';
import {
  DEFAULT_CANVAS_VIEWPORT,
  type CanvasViewport,
  type NotebookState,
  type StickyColor,
  type StickyNote,
} from './types';

export interface StickyCanvasProps {
  readonly state: NotebookState;
  readonly notebookId: string;
  readonly update: (updater: (prev: NotebookState) => NotebookState) => void;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const STICKY_DEFAULT_WIDTH = 220;
const STICKY_DEFAULT_HEIGHT = 160;

const COLOR_CLASSES: Record<StickyColor, string> = {
  amber: 'bg-amber-200 text-amber-950 dark:bg-amber-500/30 dark:text-amber-50',
  pink: 'bg-pink-200 text-pink-950 dark:bg-pink-500/30 dark:text-pink-50',
  sky: 'bg-sky-200 text-sky-950 dark:bg-sky-500/30 dark:text-sky-50',
  emerald: 'bg-emerald-200 text-emerald-950 dark:bg-emerald-500/30 dark:text-emerald-50',
  violet: 'bg-violet-200 text-violet-950 dark:bg-violet-500/30 dark:text-violet-50',
};

const COLOR_DOTS: Record<StickyColor, string> = {
  amber: 'bg-amber-300',
  pink: 'bg-pink-300',
  sky: 'bg-sky-300',
  emerald: 'bg-emerald-300',
  violet: 'bg-violet-300',
};

const COLORS: readonly StickyColor[] = ['amber', 'pink', 'sky', 'emerald', 'violet'];

const TOOL_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface/90 text-text-secondary shadow-sm backdrop-blur hover:bg-surface hover:text-text';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 选择「漂亮」的刻度步长，使屏幕间距接近 targetPx */
function niceStep(targetWorldStep: number): number {
  const abs = Math.abs(targetWorldStep);
  if (abs <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(abs)));
  const norm = abs / pow;
  let base: number;
  if (norm < 1.5) base = 1;
  else if (norm < 3) base = 2;
  else if (norm < 7) base = 5;
  else base = 10;
  return targetWorldStep < 0 ? -base * pow : base * pow;
}

function formatTick(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(decimals);
}

export function StickyCanvas({ state, notebookId, update }: StickyCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const persistedView = state.viewports[notebookId] ?? DEFAULT_CANVAS_VIEWPORT;
  const [view, setView] = useState<CanvasViewport>(persistedView);
  const viewRef = useRef<CanvasViewport>(persistedView);
  const viewSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(
    null,
  );
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const resizeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);

  const commitView = (next: CanvasViewport) => {
    update((prev) => ({
      ...prev,
      viewports: { ...prev.viewports, [notebookId]: next },
    }));
  };

  const scheduleViewCommit = (next: CanvasViewport) => {
    if (viewSaveTimerRef.current !== null) clearTimeout(viewSaveTimerRef.current);
    viewSaveTimerRef.current = setTimeout(() => {
      viewSaveTimerRef.current = null;
      commitView(next);
    }, 200);
  };

  useEffect(() => {
    const next = state.viewports[notebookId] ?? DEFAULT_CANVAS_VIEWPORT;
    setView(next);
    viewRef.current = next;
  }, [notebookId, state.viewports]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 测量容器尺寸，用于标尺刻度计算与视口居中
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoomAtPoint = (clientX: number, clientY: number, zoom: number) => {
    const element = containerRef.current;
    const rect = element?.getBoundingClientRect();
    const screenX = rect ? clientX - rect.left : 0;
    const screenY = rect ? clientY - rect.top : 0;
    const current = viewRef.current;
    const worldX = (screenX - current.panX) / current.zoom;
    const worldY = (screenY - current.panY) / current.zoom;
    const next = { panX: screenX - worldX * zoom, panY: screenY - worldY * zoom, zoom };
    viewRef.current = next;
    setView(next);
    scheduleViewCommit(next);
  };

  // 原生 wheel 监听：以鼠标停留处为焦点缩放（React onWheel 为 passive，无法 preventDefault）
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const current = viewRef.current;
      const zoom = clamp(current.zoom * (event.deltaY < 0 ? 1.1 : 0.9), ZOOM_MIN, ZOOM_MAX);
      zoomAtPoint(event.clientX, event.clientY, zoom);
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  const screenToWorld = (clientX: number, clientY: number) => {
    const element = containerRef.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: (clientX - rect.left - current.panX) / current.zoom,
      y: (clientY - rect.top - current.panY) / current.zoom,
    };
  };

  const addSticky = (text = '', at?: { x: number; y: number }) => {
    const element = containerRef.current;
    const current = viewRef.current;
    const rect = element?.getBoundingClientRect();
    const center = {
      x: ((rect?.width ?? 600) / 2 - current.panX) / current.zoom,
      y: ((rect?.height ?? 400) / 2 - current.panY) / current.zoom,
    };
    const point = at ?? center;
    const now = Date.now();
    const sticky: StickyNote = {
      id: makeNotebookId('sticky'),
      notebookId,
      text: text.slice(0, 20_000),
      x: point.x - STICKY_DEFAULT_WIDTH / 2,
      y: point.y - STICKY_DEFAULT_HEIGHT / 2,
      width: STICKY_DEFAULT_WIDTH,
      height: STICKY_DEFAULT_HEIGHT,
      color: 'amber',
      createdAt: now,
      updatedAt: now,
    };
    update((prev) => ({ ...prev, stickies: [...prev.stickies, sticky] }));
    setLastAddedId(sticky.id);
  };

  const updateSticky = (id: string, patch: Partial<StickyNote>) => {
    update((prev) => ({
      ...prev,
      stickies: prev.stickies.map((sticky) =>
        sticky.id === id ? { ...sticky, ...patch, updatedAt: Date.now() } : sticky,
      ),
    }));
  };

  const deleteSticky = (id: string) => {
    update((prev) => ({ ...prev, stickies: prev.stickies.filter((sticky) => sticky.id !== id) }));
  };

  const resetView = () => {
    const next = DEFAULT_CANVAS_VIEWPORT;
    viewRef.current = next;
    setView(next);
    commitView(next);
  };

  const zoomBy = (factor: number) => {
    const element = containerRef.current;
    const rect = element?.getBoundingClientRect();
    zoomAtPoint(
      (rect?.width ?? 600) / 2 + (rect?.left ?? 0),
      (rect?.height ?? 400) / 2 + (rect?.top ?? 0),
      clamp(viewRef.current.zoom * factor, ZOOM_MIN, ZOOM_MAX),
    );
    // 工具栏按钮为离散操作，立即落盘（zoomAtPoint 本身已防抖）
    commitView(viewRef.current);
  };

  const notebookStickies = state.stickies.filter((sticky) => sticky.notebookId === notebookId);

  const ruler = computeRuler(view, size.width, size.height);

  return (
    <section
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-surface-secondary outline-none"
      style={{
        backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
        backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
        backgroundPosition: `${view.panX}px ${view.panY}px`,
      }}
      tabIndex={0}
      aria-label="便利贴画布"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.currentTarget.focus();
        if (e.button !== 0) return;
        panRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          panX: viewRef.current.panX,
          panY: viewRef.current.panY,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const pan = panRef.current;
        if (!pan) return;
        const next = {
          panX: pan.panX + (e.clientX - pan.startX),
          panY: pan.panY + (e.clientY - pan.startY),
          zoom: viewRef.current.zoom,
        };
        viewRef.current = next;
        setView(next);
      }}
      onPointerUp={() => {
        if (!panRef.current) return;
        panRef.current = null;
        commitView(viewRef.current);
      }}
      onPointerCancel={() => {
        if (!panRef.current) return;
        panRef.current = null;
        commitView(viewRef.current);
      }}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const point = screenToWorld(e.clientX, e.clientY);
        addSticky('', point);
      }}
      onPaste={(e) => {
        const active = document.activeElement;
        if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
        const text = e.clipboardData.getData('text/plain');
        if (!text) return;
        e.preventDefault();
        addSticky(text);
      }}
    >
      {/* 无限十字坐标系标尺（屏幕空间，文字保持固定大小） */}
      <svg
        className="pointer-events-none absolute inset-0 text-text-secondary"
        width={size.width}
        height={size.height}
        aria-hidden
      >
        {/* 过原点的纵轴（x=0） */}
        {ruler.axisScreenX >= 0 && ruler.axisScreenX <= size.width && (
          <line
            x1={ruler.axisScreenX}
            y1={0}
            x2={ruler.axisScreenX}
            y2={size.height}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
        )}
        {/* 过原点的横轴（y=0） */}
        {ruler.axisScreenY >= 0 && ruler.axisScreenY <= size.height && (
          <line
            x1={0}
            y1={ruler.axisScreenY}
            x2={size.width}
            y2={ruler.axisScreenY}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
        )}
        {ruler.xTicks.map((tick) => (
          <g key={`x${tick.value}`}>
            <line
              x1={tick.screen}
              y1={ruler.axisScreenY - 5}
              x2={tick.screen}
              y2={ruler.axisScreenY + 5}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={tick.screen}
              y={ruler.axisScreenY - 8}
              fill="currentColor"
              fontSize={10}
              textAnchor="middle"
              className="select-none"
            >
              {tick.label}
            </text>
          </g>
        ))}
        {ruler.yTicks.map((tick) => (
          <g key={`y${tick.value}`}>
            <line
              x1={ruler.axisScreenX - 5}
              y1={tick.screen}
              x2={ruler.axisScreenX + 5}
              y2={tick.screen}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={ruler.axisScreenX - 8}
              y={tick.screen + 3}
              fill="currentColor"
              fontSize={10}
              textAnchor="end"
              className="select-none"
            >
              {tick.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="absolute left-2 top-2 z-20 flex items-center gap-1">
        <span className="mr-1 hidden items-center gap-1 rounded-md border border-border bg-surface/90 px-2 py-1 text-xs text-text-secondary shadow-sm backdrop-blur sm:flex">
          <StickyNoteIcon className="h-3.5 w-3.5" />
          便利贴
        </span>
        <button
          type="button"
          className={TOOL_BUTTON}
          onClick={() => addSticky('')}
          aria-label="新建便利贴"
          title="新建便利贴"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={TOOL_BUTTON}
          onClick={() => zoomBy(1.15)}
          aria-label="放大画布"
          title="放大画布"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={TOOL_BUTTON}
          onClick={() => zoomBy(0.87)}
          aria-label="缩小画布"
          title="缩小画布"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={TOOL_BUTTON}
          onClick={resetView}
          aria-label="重置画布视图"
          title="重置画布视图"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <span className="ml-1 rounded bg-surface/80 px-1.5 py-0.5 text-[10px] text-text-secondary">
          {Math.round(view.zoom * 100)}%
        </span>
      </div>

      <div
        className="pointer-events-none absolute left-0 top-0 z-10"
        style={{
          transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {notebookStickies.map((sticky) => (
          <StickyCard
            key={sticky.id}
            sticky={sticky}
            autoFocus={sticky.id === lastAddedId}
            onTextChange={(text) => updateSticky(sticky.id, { text })}
            onColorChange={(color) => updateSticky(sticky.id, { color })}
            onDelete={() => deleteSticky(sticky.id)}
            onDragStart={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = {
                id: sticky.id,
                startX: e.clientX,
                startY: e.clientY,
                x: sticky.x,
                y: sticky.y,
              };
            }}
            onDragMove={(e) => {
              const drag = dragRef.current;
              if (drag?.id !== sticky.id) return;
              updateSticky(sticky.id, {
                x: drag.x + (e.clientX - drag.startX) / viewRef.current.zoom,
                y: drag.y + (e.clientY - drag.startY) / viewRef.current.zoom,
              });
            }}
            onDragEnd={() => {
              dragRef.current = null;
            }}
            onResizeStart={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              resizeRef.current = {
                id: sticky.id,
                startX: e.clientX,
                startY: e.clientY,
                width: sticky.width,
                height: sticky.height,
              };
            }}
            onResizeMove={(e) => {
              const resize = resizeRef.current;
              if (resize?.id !== sticky.id) return;
              updateSticky(sticky.id, {
                width: Math.max(
                  120,
                  resize.width + (e.clientX - resize.startX) / viewRef.current.zoom,
                ),
                height: Math.max(
                  80,
                  resize.height + (e.clientY - resize.startY) / viewRef.current.zoom,
                ),
              });
            }}
            onResizeEnd={() => {
              resizeRef.current = null;
            }}
          />
        ))}
      </div>

      {notebookStickies.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="max-w-xs rounded-lg border border-dashed border-border bg-surface/70 px-6 py-4 text-center text-xs text-text-secondary">
            双击空白处、点击 + 或 Ctrl+V 粘贴文本，添加第一张便利贴。
          </div>
        </div>
      )}
    </section>
  );
}

interface Tick {
  readonly value: number;
  readonly screen: number;
  readonly label: string;
}

interface RulerData {
  readonly axisScreenX: number;
  readonly axisScreenY: number;
  readonly xTicks: readonly Tick[];
  readonly yTicks: readonly Tick[];
}

function computeRuler(view: CanvasViewport, width: number, height: number): RulerData {
  const { panX, panY, zoom } = view;
  const axisScreenX = panX;
  const axisScreenY = panY;
  if (width <= 0 || height <= 0 || zoom <= 0) {
    return { axisScreenX, axisScreenY, xTicks: [], yTicks: [] };
  }

  // 屏幕目标间距 80px → 世界步长
  const step = niceStep(80 / zoom);
  const worldLeft = -panX / zoom;
  const worldRight = (width - panX) / zoom;
  const worldTop = -panY / zoom;
  const worldBottom = (height - panY) / zoom;

  const xTicks: Tick[] = [];
  const start = Math.ceil(worldLeft / step) * step;
  for (let x = start; x <= worldRight + step; x += step) {
    const screen = panX + x * zoom;
    if (screen < -20 || screen > width + 20) continue;
    xTicks.push({ value: x, screen, label: formatTick(x, step) });
  }

  const yTicks: Tick[] = [];
  const startTop = Math.ceil(worldTop / step) * step;
  for (let y = startTop; y <= worldBottom + step; y += step) {
    const screen = panY + y * zoom;
    if (screen < -20 || screen > height + 20) continue;
    yTicks.push({ value: y, screen, label: formatTick(y, step) });
  }

  return { axisScreenX, axisScreenY, xTicks, yTicks };
}

interface StickyCardProps {
  readonly sticky: StickyNote;
  readonly autoFocus: boolean;
  readonly onTextChange: (text: string) => void;
  readonly onColorChange: (color: StickyColor) => void;
  readonly onDelete: () => void;
  readonly onDragStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onDragMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onDragEnd: () => void;
  readonly onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onResizeMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onResizeEnd: () => void;
}

function StickyCard({
  sticky,
  autoFocus,
  onTextChange,
  onColorChange,
  onDelete,
  onDragStart,
  onDragMove,
  onDragEnd,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: StickyCardProps) {
  return (
    <div
      data-sticky
      className={cn(
        'pointer-events-auto absolute flex flex-col rounded-md shadow-md ring-1 ring-black/5',
        COLOR_CLASSES[sticky.color],
      )}
      style={{
        left: sticky.x,
        top: sticky.y,
        width: sticky.width,
        height: sticky.height,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        // 中键（滚轮中键）按住便利贴任意位置拖动该便利贴
        if (e.button === 1) {
          e.preventDefault();
          onDragStart(e);
        }
      }}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      <div
        className="group flex h-7 shrink-0 cursor-move items-center gap-1 px-1.5"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <GripVertical className="h-3.5 w-3.5 opacity-50" />
        <div className="flex flex-1 items-center gap-1">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={cn(
                'h-2.5 w-2.5 rounded-full ring-1 ring-black/10',
                COLOR_DOTS[color],
                sticky.color === color ? 'ring-2 ring-black/40' : '',
              )}
              onPointerDown={(e) => {
                if (e.button !== 1) e.stopPropagation();
              }}
              onClick={() => onColorChange(color)}
              aria-label={`切换为 ${color} 色`}
              title="切换颜色"
            />
          ))}
        </div>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded opacity-50 hover:bg-black/10 hover:opacity-100"
          onPointerDown={(e) => {
            if (e.button !== 1) e.stopPropagation();
          }}
          onClick={onDelete}
          aria-label="删除便利贴"
          title="删除便利贴"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <textarea
        className="min-h-0 flex-1 resize-none bg-transparent px-2.5 pb-2 text-sm leading-relaxed outline-none placeholder:text-black/35 dark:placeholder:text-white/35"
        placeholder="写点什么…"
        value={sticky.text}
        autoFocus={autoFocus}
        onChange={(e) => onTextChange(e.target.value)}
        onPointerDown={(e) => {
          // 左键仍阻止冒泡（避免触发画布平移）；中键放行到卡片以启动拖动
          if (e.button !== 1) e.stopPropagation();
        }}
        onMouseDown={(e) => {
          // 阻止中键粘贴/自动滚动，拖动由 pointer 事件处理
          if (e.button === 1) e.preventDefault();
        }}
        aria-label="便利贴内容"
      />

      <div
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        aria-label="调整便利贴大小"
        title="拖动调整大小"
      >
        <div className="absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-black/30" />
      </div>
    </div>
  );
}
