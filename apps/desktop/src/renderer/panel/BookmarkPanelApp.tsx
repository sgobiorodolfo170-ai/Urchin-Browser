/**
 * 收藏夹悬浮面板 · React 根组件（P2 Session 4：自 bookmark-panel.ts 内联脚本迁移）
 *
 * 结构：三 tab 头（收藏夹/历史记录/下载列表）+ 内容区。
 *
 * 状态持久语义（原内联脚本的 IIFE 模块变量，必须完整复现）：
 * - 收藏夹目录轨迹、历史展开状态、下载速度采样在面板生命周期内跨 tab 切换保留
 *   → 三个 tab 面板保持挂载、以 hidden 切换可见性（卸载会丢失上述状态）；
 * - 切入某 tab 时该 tab 重新拉取数据（原 loadTab 每次调用 renderX()）；
 * - 下载轮询仅在 downloads tab 激活期间运行（原 loadTab → stopDownloadPolling）。
 *
 * 书签拖出浏览器窗口（原 contentEl 指针拖拽，v2 自定义拖拽而非系统拖放）：
 * pointerdown 落在带 data-url 的条目主体（非星标/行操作/下载操作/重命名输入框）时
 * 捕获指针，指针移出面板窗口边界 → 经 window.createWithUrl 在新浏览器窗口打开
 * 该 URL（定位到出界屏幕坐标）。此逻辑挂在共享内容区上：收藏夹/历史条目均生效
 * （与原 contentEl 监听范围一致）。
 */
import { useRef, useState } from 'react';
import { BookmarksTab } from './BookmarksTab';
import { HistoryTab } from './HistoryTab';
import { DownloadsTab } from './DownloadsTab';
import { invoke } from './panel-ipc';

export type PanelTab = 'bookmarks' | 'history' | 'downloads';

const TABS: readonly { key: PanelTab; label: string }[] = [
  { key: 'bookmarks', label: '收藏夹' },
  { key: 'history', label: '历史记录' },
  { key: 'downloads', label: '下载列表' },
];

/** 进行中的书签拖拽（原 dragBookmark 模块变量） */
interface BookmarkDrag {
  url: string;
  pointerId: number;
  el: HTMLElement;
}

export function BookmarkPanelApp() {
  const [activeTab, setActiveTab] = useState<PanelTab>('bookmarks');
  // picker 模式（星标按钮未收藏时以 ?mode=picker 打开）：收藏夹 tab 进入「选择文件夹保存」
  const pickerMode = new URLSearchParams(location.search).get('mode') === 'picker';

  // ── 书签拖出（原 contentEl pointerdown/move/up/cancel 监听）──
  const dragRef = useRef<BookmarkDrag | null>(null);

  const onContentPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    const item = target.closest('.item');
    if (!item) return;
    // 星标/行内按钮/下载操作/重命名输入框不启动拖拽：setPointerCapture 会重定向
    // pointerup 目标，使随后的 click 派发到 .item 而非按钮——删除点击被劫持为打开网址。
    if (
      target.closest('.star') ||
      target.closest('.row-act') ||
      target.closest('.dl-actions') ||
      target.closest('.rename-input')
    ) {
      return;
    }
    const url = (item as HTMLElement).dataset.url;
    if (!url) return;
    dragRef.current = { url, pointerId: e.pointerId, el: item as HTMLElement };
    const el = item as HTMLElement;
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败忽略 */
      }
    }
  };

  const onContentPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    // 指针移出面板窗口边界 → 在新窗口打开（定位到出界屏幕坐标，不重叠在面板窗口上）
    if (
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight
    ) {
      dragRef.current = null;
      try {
        drag.el.releasePointerCapture(drag.pointerId);
      } catch {
        /* 未捕获忽略 */
      }
      invoke('window.createWithUrl', { url: drag.url, x: e.screenX, y: e.screenY }).catch(() => {
        /* 打开失败静默 */
      });
    }
  };

  const endBookmarkDrag = (): void => {
    dragRef.current = null;
  };

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <div
            key={t.key}
            className={'tab' + (activeTab === t.key ? ' active' : '')}
            data-tab={t.key}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </div>
        ))}
      </div>
      <div
        className="content"
        id="content"
        onPointerDown={onContentPointerDown}
        onPointerMove={onContentPointerMove}
        onPointerUp={endBookmarkDrag}
        onPointerCancel={endBookmarkDrag}
      >
        <div className={'tab-panel' + (activeTab === 'bookmarks' ? '' : ' hidden')}>
          <BookmarksTab active={activeTab === 'bookmarks'} pickerMode={pickerMode} />
        </div>
        <div className={'tab-panel' + (activeTab === 'history' ? '' : ' hidden')}>
          <HistoryTab active={activeTab === 'history'} />
        </div>
        <div className={'tab-panel' + (activeTab === 'downloads' ? '' : ' hidden')}>
          <DownloadsTab active={activeTab === 'downloads'} />
        </div>
      </div>
    </>
  );
}
