/**
 * 书签状态与 toggle（App 域 hook，refactor-plan-p2 §2.3 步骤 7，代码自 App.tsx 原样迁出）
 *
 * 收藏状态（bookmarkSaved）与提示（bookmarkToast）由 App 的悬浮状态栏快照
 * （statusBarState）消费，真源经 App 调用仍归 App 域；toggle 动作由
 * ui.statusbar.action 的 bookmark-toggle 分发调用。
 */
import { useCallback, useEffect, useState } from 'react';

/** URL → 是否可收藏（仅 http/https；内部页/文件页不入书签） */
export function isBookmarkable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function useBookmark(activeTabUrl: string | undefined) {
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkToast, setBookmarkToast] = useState<string | null>(null);

  // 当前 URL 对应的书签 ID（若已收藏），用于 toggle 时删除。
  // 通过 bookmark.search 查询当前 URL 是否已被收藏，实现按钮亮/灭状态同步。
  const [currentBookmarkId, setCurrentBookmarkId] = useState<string | null>(null);

  // 刷新当前 URL 的收藏状态：activeTab.url 变化时或创建/删除书签后调用
  const refreshBookmarkSaved = useCallback(async (url: string | undefined) => {
    if (!url || !isBookmarkable(url)) {
      setBookmarkSaved(false);
      setCurrentBookmarkId(null);
      return;
    }
    try {
      const result = (await window.urchin.invoke('bookmark.search', {
        query: url,
        limit: 50,
      })) as { bookmarks: readonly { id: string; title: string; url?: string }[] };
      // search 对 title/url 做子串匹配，需精确匹配 url 字段
      const match = result.bookmarks.find((bm) => bm.url === url);
      setBookmarkSaved(!!match);
      setCurrentBookmarkId(match ? match.id : null);
    } catch (e) {
      console.error('Failed to check bookmark status:', e);
      setBookmarkSaved(false);
      setCurrentBookmarkId(null);
    }
  }, []);

  // toggle 收藏：已收藏则删除，未收藏则弹出收藏夹面板选择文件夹保存（dev.120）。
  // 未收藏分支不再直接 bookmark.create 到根级——改由面板 picker 模式让用户选目标文件夹。
  const handleSaveBookmark = useCallback(async () => {
    if (!activeTabUrl || !isBookmarkable(activeTabUrl)) return;
    try {
      if (bookmarkSaved && currentBookmarkId) {
        // 已收藏 → 删除
        await window.urchin.invoke('bookmark.delete', { id: currentBookmarkId });
        setBookmarkSaved(false);
        setCurrentBookmarkId(null);
        setBookmarkToast('已从书签移除');
        setTimeout(() => setBookmarkToast(null), 2000);
        void refreshBookmarkSaved(activeTabUrl);
      } else {
        // 未收藏 → 弹出收藏夹面板（picker 模式）选文件夹保存
        await window.urchin.invoke('ui.panel.saveBookmarkPicker', {});
        // 实际保存由面板内完成；bookmark:changed 广播后 refreshBookmarkSaved 会刷新星标
      }
    } catch (e) {
      console.error('Failed to toggle bookmark:', e);
      setBookmarkToast('书签操作失败');
      setTimeout(() => setBookmarkToast(null), 2000);
    }
  }, [activeTabUrl, bookmarkSaved, currentBookmarkId, refreshBookmarkSaved]);

  // URL 变化时重新检查收藏状态（修复：此前仅 setBookmarkSaved(false) 未查询实际状态）
  useEffect(() => {
    void refreshBookmarkSaved(activeTabUrl);
  }, [activeTabUrl, refreshBookmarkSaved]);

  // 书签变更同步：主进程广播 bookmark:changed（收藏夹面板取消收藏等场景），
  // 重新查询当前 URL 收藏状态，让地址栏星标亮/灭与数据一致。
  useEffect(() => {
    const unsubscribe = window.urchin.on('bookmark:changed', () => {
      void refreshBookmarkSaved(activeTabUrl);
    });
    return () => {
      unsubscribe();
    };
  }, [activeTabUrl, refreshBookmarkSaved]);

  return { bookmarkSaved, bookmarkToast, handleSaveBookmark } as const;
}
