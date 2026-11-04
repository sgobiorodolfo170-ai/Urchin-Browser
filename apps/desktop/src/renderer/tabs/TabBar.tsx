/**
 * 标签列表（右侧栏展开态卡片 / 折叠态图标 + 新建标签按钮）
 *
 * 仅负责标签列表渲染与列表内滚动平移；标签数据、激活态、开关动作均由 App
 * 通过 props 注入（状态单一真源仍在 App，避免列表组件持有可失同步的副本）。
 */
import { Plus, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { BOTTOM_HEIGHT } from '../lib/layout-constants';
import { useDragScroll } from '../lib/use-drag-scroll';
import { TabFavicon } from './TabFavicon';
import type { TabSnapshot } from './types';

export interface TabBarProps {
  /** true = 展开态卡片列表（含新建按钮）；false = 折叠态图标列表 */
  readonly expanded: boolean;
  readonly tabs: readonly TabSnapshot[];
  readonly activeTabId: number | null;
  readonly onSelectTab: (tabId: number) => void;
  readonly onCloseTab: (tabId: number) => void;
  readonly onNewTab: () => void;
  readonly onTabPointerDown: (e: React.PointerEvent, tab: TabSnapshot) => void;
  readonly onTabPointerMove: (e: React.PointerEvent) => void;
  readonly onTabPointerEnd: () => void;
  readonly onTabContextMenu: (e: React.MouseEvent, tab: TabSnapshot) => void;
}

export function TabBar({
  expanded,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onTabPointerDown,
  onTabPointerMove,
  onTabPointerEnd,
  onTabContextMenu,
}: TabBarProps): React.JSX.Element {
  /** 展开态标签列表滚动容器（隐藏滚动条；长按左键上下拖动平移）。 */
  const expandedTabListRef = useDragScroll<HTMLDivElement>();
  /** 折叠态标签图标列表滚动容器（同上）。 */
  const collapsedTabListRef = useDragScroll<HTMLDivElement>();

  if (expanded) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col">
        <div
          ref={expandedTabListRef}
          className="flex-1 select-none overflow-y-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-text-secondary">暂无标签页</p>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              data-tab-card
              draggable={false}
              onPointerDown={(e) => onTabPointerDown(e, tab)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerEnd}
              onPointerCancel={onTabPointerEnd}
              onContextMenu={(e) => onTabContextMenu(e, tab)}
              className={cn(
                // 凸起悬浮感：圆角卡片 + 投影 + 细边框 + 顶部高光线；
                // 激活态更亮（主色投影 + 高对比文字）
                'group relative mb-1.5 flex cursor-default items-center gap-2 rounded-lg border px-2.5 py-2 text-sm shadow-sm',
                'border-border/60 bg-surface',
                'before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:h-px before:rounded-full before:bg-white/70',
                tab.id === activeTabId
                  ? 'border-primary/40 bg-surface text-text shadow-[0_2px_8px_-2px_rgba(37,99,235,0.35)]'
                  : 'text-text-secondary shadow-[0_1px_4px_-1px_rgba(0,0,0,0.25)] hover:bg-surface-secondary hover:text-text',
              )}
              onClick={() => onSelectTab(tab.id)}
              onDoubleClick={() => onCloseTab(tab.id)}
            >
              {/* 图标铺满标签高度：36px 与折叠态一致，卡片高度随内容撑开约 52px，
               *  items-center 垂直居中，object-contain 保持比例不变形 */}
              <TabFavicon tab={tab} className="h-9 w-9" />
              <span className="flex-1 truncate">{tab.title || tab.url || '新标签页'}</span>
              {/* GenOffice 编辑器未保存修改标记（阶段 2） */}
              {tab.dirty && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  title="有未保存的修改"
                  aria-label="有未保存的修改"
                />
              )}
              <button
                className="shrink-0 rounded p-0.5 opacity-0 hover:bg-error/10 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                aria-label="关闭标签"
              >
                <X className="h-3 w-3 text-error" />
              </button>
            </div>
          ))}
        </div>
        {/* 新建标签：高度与底部地址栏一致（BOTTOM_HEIGHT=48），底边对齐 */}
        <div
          className="flex shrink-0 items-center border-t border-border px-2"
          style={{ height: BOTTOM_HEIGHT }}
        >
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-sm text-text-secondary hover:bg-surface hover:text-text"
            onClick={onNewTab}
            aria-label="新建标签"
          >
            <Plus className="h-4 w-4" />
            新建标签
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={collapsedTabListRef}
      className="mt-1 flex w-full flex-1 select-none flex-col items-center gap-0.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          draggable={false}
          onPointerDown={(e) => onTabPointerDown(e, tab)}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerEnd}
          onPointerCancel={onTabPointerEnd}
          onContextMenu={(e) => onTabContextMenu(e, tab)}
          className={cn(
            // 折叠态图标：方形小圆角（区别于展开态卡片的圆角更大），激活态带主色描边。
            // 尺寸 40px = 折叠栏宽 44px - 左右各留 2px 边界空隙
            'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-surface shadow-sm',
            'border-border/60 before:pointer-events-none before:absolute before:inset-x-1 before:top-0 before:h-px before:rounded-full before:bg-white/70',
            tab.id === activeTabId
              ? 'border-primary/50 text-text shadow-[0_2px_6px_-1px_rgba(37,99,235,0.4)]'
              : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
          )}
          onClick={() => onSelectTab(tab.id)}
          onDoubleClick={() => onCloseTab(tab.id)}
          aria-label={`切换到标签 ${tab.title || tab.url || '新标签页'}`}
          title={tab.title || tab.url || '新标签页'}
        >
          <TabFavicon tab={tab} className="h-9 w-9" />
          {/* GenOffice 编辑器未保存修改标记（折叠态角标） */}
          {tab.dirty && (
            <span
              className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
              aria-label="有未保存的修改"
            />
          )}
        </button>
      ))}
    </div>
  );
}
