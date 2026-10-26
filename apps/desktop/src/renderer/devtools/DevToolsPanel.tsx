/**
 * M15 DevTools · 检视列面板（右侧第三列）
 *
 * 依据：实施规划 §9 / 契约 G §8。
 * 职责：列容器 + 头部（目标/状态/开始停止/绑定当前标签/清空）+ 三视图切换 +
 * 拖宽手柄。数据逻辑由 useDevtools hook 管理。
 */
import { useState, useCallback, useRef } from 'react';
import { useDevtools } from './use-devtools';
import { NetworkView } from './network-view';
import { ConsoleView } from './console-view';
import { EvaluateBox } from './evaluate-box';

/** 检视列范围尺寸 */
const MIN_WIDTH = 260;
const MAX_WIDTH = 720;

export interface DevToolsPanelProps {
  /** 当前活跃标签 id（用于「绑定当前标签」按钮） */
  activeTabId: number | null;
  /** 当前活跃标签标题（面板头部显示） */
  activeTabTitle: string;
  /** 当前活跃标签是否可检视（非内部页/genoffice） */
  activeTabInspectable: boolean;
  /** 列宽变化通知（同步主进程 BrowserView bounds） */
  onWidthChange: (width: number) => void;
  /** 当前面板宽度（受外部折叠/展开控制） */
  width: number;
}

type ViewTab = 'network' | 'console' | 'evaluate';

export function DevToolsPanel(props: DevToolsPanelProps): React.ReactElement {
  const { activeTabId, activeTabTitle, activeTabInspectable, onWidthChange, width } = props;
  const dt = useDevtools();
  const [view, setView] = useState<ViewTab>('network');
  const [resizing, setResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  // 拖宽
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setResizing(true);
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      const onMove = (ev: PointerEvent): void => {
        // 从右往左拖增宽（手柄在面板左缘）
        const delta = startXRef.current - ev.clientX;
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
        onWidthChange(next);
      };
      const onUp = (): void => {
        setResizing(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [width, onWidthChange],
  );

  const handleAttach = useCallback(() => {
    if (activeTabId !== null) void dt.attach(activeTabId);
  }, [activeTabId, dt]);

  const stateLabel =
    dt.state === 'attached' ? '采集中' : dt.state === 'unavailable' ? '不可检视' : '已停止';
  const stateColor =
    dt.state === 'attached'
      ? 'text-emerald-500'
      : dt.state === 'unavailable'
        ? 'text-error'
        : 'text-text-secondary';

  return (
    <div
      className="flex shrink-0 flex-col border-l border-border bg-surface"
      style={{ width }}
      aria-label="开发者工具检视列"
      role="region"
    >
      {/* 左缘拖宽手柄 */}
      <div
        className="absolute top-0 bottom-0 -left-1 z-20 w-2 cursor-col-resize"
        onPointerDown={onResizeStart}
        aria-label="调节检视列宽度"
        role="separator"
        style={{ cursor: resizing ? 'col-resize' : undefined }}
      />
      {/* 头部 */}
      <div className="flex flex-col gap-1 border-b border-border px-2 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text">检视</span>
          <span className={stateColor}>{stateLabel}</span>
          {dt.target && (
            <span className="truncate text-text-secondary" title={dt.target.title}>
              {dt.target.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {dt.state === 'attached' ? (
            <button
              className="rounded px-2 py-0.5 text-text-secondary hover:bg-surface-secondary"
              onClick={() => void dt.detach()}
            >
              停止
            </button>
          ) : (
            <button
              className="rounded bg-primary px-2 py-0.5 text-white disabled:opacity-40"
              onClick={handleAttach}
              disabled={activeTabId === null || !activeTabInspectable}
              title={
                activeTabInspectable ? '开始检视当前标签' : '当前标签不可检视（内部页/编辑器）'
              }
            >
              开始检视
            </button>
          )}
          {dt.state === 'attached' && (
            <>
              <button
                className="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-secondary"
                onClick={() =>
                  view === 'network' ? void dt.clearNetwork() : void dt.clearConsole()
                }
              >
                清空
              </button>
            </>
          )}
        </div>
        {dt.state === 'unavailable' && dt.unavailableReason && (
          <div className="text-error">
            {dt.unavailableReason === 'internal-page'
              ? '内部页面不可检视'
              : dt.unavailableReason === 'genoffice-tab'
                ? '编辑器标签不可检视'
                : dt.unavailableReason === 'already-attached'
                  ? '调试器已被占用'
                  : '目标已关闭'}
          </div>
        )}
      </div>
      {/* 视图切换 */}
      <div className="flex border-b border-border text-xs">
        {(['network', 'console', 'evaluate'] as const).map((tab) => (
          <button
            key={tab}
            className={`flex-1 px-2 py-1 ${view === tab ? 'border-b-2 border-primary text-text' : 'text-text-secondary hover:bg-surface-secondary'}`}
            onClick={() => setView(tab)}
          >
            {tab === 'network' ? '网络' : tab === 'console' ? '控制台' : '求值'}
          </button>
        ))}
      </div>
      {/* 内容 */}
      <div className="flex-1 overflow-hidden">
        {view === 'network' ? (
          <NetworkView
            entries={dt.network}
            dropped={dt.networkDropped}
            attached={dt.state === 'attached'}
          />
        ) : view === 'console' ? (
          <ConsoleView
            entries={dt.console}
            dropped={dt.consoleDropped}
            attached={dt.state === 'attached'}
          />
        ) : (
          <EvaluateBox evaluate={dt.evaluate} attached={dt.state === 'attached'} />
        )}
      </div>
      {/* 当前列宽显示（调试） */}
      <div className="border-t border-border px-2 py-0.5 text-[10px] text-text-secondary">
        {activeTabTitle}
      </div>
    </div>
  );
}
