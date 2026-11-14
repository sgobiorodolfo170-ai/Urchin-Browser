import { useEffect, useRef, useState } from 'react';
import { Folder, Globe } from 'lucide-react';
import {
  computeStatusBarCardWidth,
  STATUS_BALL_RESERVED_WIDTH,
} from '../../shared/status-bar-layout';
import type { Bookmark } from '@urchin/ipc-contract';

export function useTitlebarBookmarks() {
  const [enabled, setEnabled] = useState(true);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = (await window.urchin.invoke('settings.get', {
          key: 'ui.titlebarBookmarksToggle',
        })) as { value: unknown };
        if (!disposed) {
          setEnabled(res.value !== false);
          if (res.value === false) setExpanded(false);
        }
      } catch {
        /* 保留默认值，后续设置通知可重试。 */
      }
    };
    void load();
    const onChanged = () => {
      void load();
    };
    window.addEventListener('urchin:settings-changed', onChanged);
    return () => {
      disposed = true;
      window.removeEventListener('urchin:settings-changed', onChanged);
    };
  }, []);
  return { enabled, expanded, toggle: () => setExpanded((value) => !value) };
}

/** 收藏栏占据真实布局空间，避免原生网页视图覆盖收藏项。 */
export function BookmarksBar({
  onNavigate,
  addressBarExtraWidth = 0,
}: {
  readonly onNavigate: (url: string) => void;
  readonly addressBarExtraWidth?: number;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const [minimumWidth, setMinimumWidth] = useState(0);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () =>
      setMinimumWidth(
        computeStatusBarCardWidth(
          row.clientWidth + addressBarExtraWidth,
          STATUS_BALL_RESERVED_WIDTH,
        ) / 2,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [addressBarExtraWidth]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    // 使用非 passive 原生监听，阻止纵向滚轮传到下方页面，同时保留 Ctrl+滚轮缩放。
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey || bar.scrollWidth <= bar.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 28 : event.deltaMode === 2 ? bar.clientWidth : 1;
      bar.scrollLeft += delta * unit;
    };
    bar.addEventListener('wheel', scroll, { passive: false });
    return () => bar.removeEventListener('wheel', scroll);
  }, []);
  const [items, setItems] = useState<Bookmark[]>([]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const res = (await window.urchin.invoke('bookmark.list', {})) as { bookmarks: Bookmark[] };
        if (!disposed) {
          setItems(res.bookmarks);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      }
    };
    void refresh();
    const unsubscribe = window.urchin.on('bookmark:changed', () => {
      void refresh();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const children = items.filter((b) => b.parentId === null).sort((a, b) => a.position - b.position);
  const openFolder = async (item: Bookmark, button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    setOpenFolderId(item.id);
    try {
      const res = (await window.urchin.invoke('bookmark.openFolderMenu', {
        folderId: item.id,
        x: Math.round(bounds.left),
        y: Math.round(bounds.bottom),
      })) as { url: string | null };
      if (res.url) onNavigate(res.url);
    } catch {
      setError(true);
    } finally {
      setOpenFolderId(null);
    }
  };
  return (
    <div
      ref={rowRef}
      className="flex h-9 min-w-0 shrink-0 items-center justify-center bg-transparent px-2"
    >
      <nav
        ref={barRef}
        id="bookmarks-bar"
        aria-label="收藏栏"
        className="bookmarks-bar h-7 w-max max-w-full overflow-x-auto overflow-y-hidden rounded-full border border-border/70 text-xs"
        style={{ minWidth: `min(100%, ${minimumWidth}px)` }}
      >
        <div className="flex h-full w-max min-w-full items-center justify-center gap-1 px-3">
          {error ? (
            <span role="alert">收藏加载失败，请折叠后重试</span>
          ) : children.length === 0 ? (
            <span
              className="whitespace-nowrap text-text-secondary"
              title="可通过地址栏收藏按钮添加"
            >
              暂无收藏
            </span>
          ) : (
            children.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.url ?? item.title}
                aria-haspopup={item.type === 'folder' ? 'menu' : undefined}
                aria-expanded={item.type === 'folder' ? openFolderId === item.id : undefined}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 hover:bg-surface-secondary"
                onClick={(event) => {
                  if (item.type === 'folder') void openFolder(item, event.currentTarget);
                  else if (item.url) onNavigate(item.url);
                }}
              >
                {item.type === 'folder' ? (
                  <Folder size={14} className="shrink-0" />
                ) : (
                  <Globe size={14} className="shrink-0" />
                )}
                <span>{item.title}</span>
              </button>
            ))
          )}
        </div>
      </nav>
    </div>
  );
}
