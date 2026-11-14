import { useEffect, useState } from 'react';
import { ArrowLeft, Folder, Globe } from 'lucide-react';
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
export function BookmarksBar({ onNavigate }: { readonly onNavigate: (url: string) => void }) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const res = (await window.urchin.invoke('bookmark.list', {})) as { bookmarks: Bookmark[] };
        if (!disposed) {
          setItems(res.bookmarks);
          setError(false);
          setFolderId((id) =>
            res.bookmarks.some((b) => b.id === id && b.type === 'folder') ? id : null,
          );
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
  const children = items
    .filter((b) => b.parentId === folderId)
    .sort((a, b) => a.position - b.position);
  const folder = items.find((b) => b.id === folderId);
  return (
    <nav
      id="bookmarks-bar"
      aria-label="收藏栏"
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 text-xs"
    >
      {folder && (
        <button
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-surface-secondary"
          onClick={() => setFolderId(folder.parentId)}
          title="返回上级文件夹"
        >
          <ArrowLeft size={14} />
          {folder.title}
        </button>
      )}
      {error ? (
        <span role="alert">收藏加载失败，请折叠后重试</span>
      ) : children.length === 0 ? (
        <span className="text-text-secondary">
          {folder ? '此文件夹为空' : '暂无收藏，可通过地址栏收藏按钮添加'}
        </span>
      ) : (
        children.map((item) => (
          <button
            key={item.id}
            title={item.url ?? item.title}
            className="flex max-w-48 shrink-0 items-center gap-1.5 rounded px-2 py-1 hover:bg-surface-secondary"
            onClick={() =>
              item.type === 'folder' ? setFolderId(item.id) : item.url && onNavigate(item.url)
            }
          >
            {item.type === 'folder' ? (
              <Folder size={14} className="shrink-0" />
            ) : (
              <Globe size={14} className="shrink-0" />
            )}
            <span className="truncate">{item.title}</span>
          </button>
        ))
      )}
    </nav>
  );
}
