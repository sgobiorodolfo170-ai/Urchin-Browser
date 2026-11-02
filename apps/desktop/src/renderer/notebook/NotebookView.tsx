/**
 * 笔记 / 便利贴页（urchin://notebook，M27）
 *
 * 三区布局：
 * - 左：笔记本 + 页面树导航
 * - 中：笔记 / 任务清单（右上角切换）
 * - 右：无限画布便利贴
 *
 * 三区以比例（默认 1:2:2）铺满整个网页内容区，随主窗口尺寸变化自动伸缩；
 * 两条分割线可拖拽，拖拽后的比例写入 notebook.state.layout，重启恢复。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { NotebookNav } from './NotebookNav';
import { NotesTasksPane } from './NotesTasksPane';
import { StickyCanvas } from './StickyCanvas';
import { useNotebookStore } from './store';
import {
  defaultLayout,
  normalizeLayout,
  resizeLeftLayout,
  resizeRightLayout,
  SPLITTER_WIDTH,
  widthsFromLayout,
} from './layout';
import type { NotebookLayout } from './types';
import { cn } from '../lib/utils';

type SplitterKind = 'left' | 'right';

interface DragState {
  readonly kind: SplitterKind;
  readonly startX: number;
  readonly startLayout: NotebookLayout;
}

export function NotebookView() {
  const { state, update } = useNotebookStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1000);
  const [liveLayout, setLiveLayout] = useState<NotebookLayout | null>(null);
  const [dragging, setDragging] = useState<SplitterKind | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const loading = state === null;
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = (): void => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setContainerWidth(width);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
    // 状态从 null（加载中）变为可用后，grid 才挂载并拿到 containerRef；
    // 此前 effect 会因 ref 为空提前返回，故依赖 loading 标志在挂载后重跑一次。
  }, [loading]);

  if (!state) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface text-sm text-text-secondary">
        正在加载笔记…
      </div>
    );
  }

  const activeNotebook =
    state.notebooks.find((notebook) => notebook.id === state.activeNotebookId) ??
    state.notebooks[0];
  if (!activeNotebook) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface text-sm text-text-secondary">
        没有可用笔记本
      </div>
    );
  }

  const ratioLayout = normalizeLayout(state.layout ?? defaultLayout());
  const activeLayout = liveLayout ?? ratioLayout;
  const widths = widthsFromLayout(activeLayout, containerWidth);

  const startResize = (kind: SplitterKind, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = {
      kind,
      startX: event.clientX,
      startLayout: activeLayout,
    };
    setDragging(kind);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const next =
      drag.kind === 'left'
        ? resizeLeftLayout(drag.startLayout, delta, containerWidth)
        : resizeRightLayout(drag.startLayout, delta, containerWidth);
    setLiveLayout(next);
  };

  const endResize = () => {
    if (!dragRef.current) return;
    if (liveLayout) {
      update((prev) => ({
        ...prev,
        layout: { ...liveLayout, custom: true },
      }));
    }
    dragRef.current = null;
    setLiveLayout(null);
    setDragging(null);
  };

  const splitterProps = (kind: SplitterKind) => ({
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': kind === 'left' ? '调整导航区宽度' : '调整内容区宽度',
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => startResize(kind, e),
    onPointerMove: moveResize,
    onPointerUp: endResize,
    onPointerCancel: endResize,
  });

  return (
    <div
      ref={containerRef}
      data-notebook-page
      className="grid h-full w-full min-w-0 overflow-hidden bg-surface"
      style={{
        gridTemplateColumns: `${widths.left}px ${SPLITTER_WIDTH}px ${widths.middle}px ${SPLITTER_WIDTH}px ${widths.right}px`,
      }}
    >
      <NotebookNav state={state} update={update} />

      <div
        {...splitterProps('left')}
        className={cn(
          'relative h-full cursor-col-resize select-none',
          dragging === 'left' && 'bg-primary/20',
        )}
      >
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      </div>

      <NotesTasksPane state={state} notebook={activeNotebook} update={update} />

      <div
        {...splitterProps('right')}
        className={cn(
          'relative h-full cursor-col-resize select-none',
          dragging === 'right' && 'bg-primary/20',
        )}
      >
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      </div>

      <StickyCanvas state={state} notebookId={activeNotebook.id} update={update} />
    </div>
  );
}
