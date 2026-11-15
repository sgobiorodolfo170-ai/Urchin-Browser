/**
 * 收藏栏文件夹菜单 · 子窗口渲染根组件（panel.html?mode=folder-menu&folderId=<id>）
 *
 * 收藏栏点击文件夹时由主进程 FolderMenuWindow 打开本子窗口（定位在按钮下方，
 * 悬浮于网页之上——渲染层浮层会被 BrowserView 遮挡，故必须用独立窗口）。
 * 列表内容复用主页同款 BookmarkListPanel（图标 / 排版 / 层级下钻 / 取消收藏一致）。
 * 关闭：blur 由主进程处理；Esc 在此监听。选中书签：在主窗口活跃标签打开后自关。
 */
import { useEffect, useState } from 'react';
import type { Bookmark } from '@urchin/ipc-contract';
import { BookmarkListPanel } from '../components/bookmark-list-dialog';
import { invoke, openUrlInActiveTab } from './panel-ipc';

/** 取消收藏该页面：同一地址的全部收藏一并删除（与主页弹窗同语义）。 */
async function deleteBookmarksByUrl(url: string): Promise<void> {
  const res = await invoke<{ bookmarks: Bookmark[] }>('bookmark.list', {});
  for (const bookmark of res.bookmarks) {
    if (bookmark.type === 'bookmark' && bookmark.url === url) {
      await invoke('bookmark.delete', { id: bookmark.id });
    }
  }
}

export function FolderMenuApp() {
  const folderId = new URLSearchParams(location.search).get('folderId') ?? '';
  const [items, setItems] = useState<Bookmark[] | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const res = await invoke<{ bookmarks: Bookmark[] }>('bookmark.list', {});
        // 菜单展示按加入时间从新到旧（用户约定：新加入的标签自动排最前）；
        // 只影响菜单渲染顺序，不改 position 存储顺序（收藏夹面板内仍按原序管理）。
        if (!disposed) setItems([...res.bookmarks].sort((a, b) => b.createdAt - a.createdAt));
      } catch {
        if (!disposed) setItems([]);
      }
    };
    void refresh();
    const unsubscribe = window.urchin.on('bookmark:changed', () => {
      void refresh();
    });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  const folder = items?.find((b) => b.id === folderId && b.type === 'folder') ?? null;
  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface p-2">
      {folder ? (
        <BookmarkListPanel
          className="min-h-0 flex-1"
          heading={folder.title}
          entries={items ?? []}
          rootId={folderId}
          onNavigate={(url) => {
            void openUrlInActiveTab(url).then(() => window.close());
          }}
          onDelete={deleteBookmarksByUrl}
        />
      ) : (
        <p role="alert" className="p-3 text-sm text-text-secondary">
          {items === null ? '加载中…' : '收藏加载失败，请重试'}
        </p>
      )}
    </div>
  );
}
