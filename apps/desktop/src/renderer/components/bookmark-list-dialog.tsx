/**
 * 书签列表：主页「常用网站 / 最近浏览」弹窗与收藏栏文件夹菜单子窗口共用同一
 * 内容组件（BookmarkListPanel），保证两处的组件结构、设计风格与排版一致；
 * 列表行前统一显示网站图标。容器不同：主页为居中模态 <dialog>，收藏栏为
 * 定位在文件夹按钮下方的独立子窗口（悬浮于网页之上，见 folder-menu-window.ts）。
 * 层级模式在组件内部维护文件夹栈，支持进入子文件夹与返回，并沿用原原生菜单
 * 的循环文件夹禁用与空文件夹提示语义（原为 bookmark.openFolderMenu）。
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Folder, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';

export const BROWSER_ICON = './browser-icon.png';

/** 站点图标：优先用采集缓存的 favicon，加载失败逐级回退浏览器图标（弱化显示避免误导）。 */
export function SiteFavicon({
  url,
  favicon,
  className,
}: {
  url: string;
  favicon?: string;
  className?: string;
}) {
  const [srcIndex, setSrcIndex] = useState(0);
  const sources = [...(favicon ? [favicon] : []), BROWSER_ICON];
  useEffect(() => setSrcIndex(0), [url, favicon]);
  return (
    <img
      src={sources[Math.min(srcIndex, sources.length - 1)]}
      alt=""
      draggable={false}
      className={cn(className, srcIndex >= sources.length - 1 && 'opacity-40')}
      onError={() => setSrcIndex((i) => Math.min(i + 1, sources.length - 1))}
    />
  );
}

export interface BookmarkListEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: 'bookmark' | 'folder';
  readonly url?: string;
  readonly title: string;
  readonly favicon?: string;
}

/** 列表内容（无容器）：标题行 + 条目列表 + 层级栈导航，由调用方选择容器承载。 */
export function BookmarkListPanel({
  heading,
  entries,
  rootId = null,
  onNavigate,
  onDelete,
  showClose = false,
  onClose,
  className,
}: {
  /** 标题：扁平模式直接显示；层级模式显示当前所在文件夹名。 */
  readonly heading: string;
  /** 平铺条目；调用方保证排序，组件按 parentId 过滤后保持原顺序。 */
  readonly entries: readonly BookmarkListEntry[];
  /** 层级模式根文件夹 id；null 为扁平模式（直接展示 entries，无文件夹导航）。 */
  readonly rootId?: string | null;
  readonly onNavigate: (url: string) => void;
  /** 提供后书签行显示「取消收藏」；失败时由组件内展示错误提示。 */
  readonly onDelete?: (url: string) => Promise<void>;
  /** 显示「关闭」按钮（主页模态弹窗用；菜单子窗口靠 blur/Esc 关闭，不显示）。 */
  readonly showClose?: boolean;
  readonly onClose?: () => void;
  readonly className?: string;
}) {
  const [stack, setStack] = useState<string[]>([]);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const hierarchical = rootId !== null;
  const currentId = hierarchical ? (stack[stack.length - 1] ?? rootId) : null;
  const rows = hierarchical ? entries.filter((e) => e.parentId === currentId) : entries;
  // 祖先链含根文件夹：回到自身或祖先的文件夹一律禁用，防止循环引用死循环。
  const ancestors = hierarchical ? [rootId, ...stack] : [];
  const currentHeading =
    hierarchical && stack.length
      ? (entries.find((e) => e.id === currentId)?.title ?? heading)
      : heading;
  const openEntry = (entry: BookmarkListEntry) => {
    if (entry.type === 'folder') {
      setStack((s) => [...s, entry.id]);
      return;
    }
    if (!entry.url) return;
    setDeleteError('');
    onNavigate(entry.url);
  };
  const remove = async (entry: BookmarkListEntry) => {
    if (!onDelete || deletingUrl || !entry.url) return;
    setDeletingUrl(entry.url);
    setDeleteError('');
    try {
      await onDelete(entry.url);
    } catch {
      setDeleteError('取消收藏失败，请重试');
    } finally {
      setDeletingUrl(null);
    }
  };
  return (
    <div className={cn('flex min-h-0 flex-col text-text', className)}>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-1">
          {stack.length > 0 && (
            <button
              type="button"
              aria-label="返回上一级"
              title="返回上一级"
              onClick={() => setStack((s) => s.slice(0, -1))}
              className="shrink-0 rounded-lg p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            </button>
          )}
          <h2 className="truncate text-sm font-medium">{currentHeading}</h2>
        </div>
        {showClose && (
          <button
            type="button"
            className="ui-icon-button rounded-md px-2 py-1 text-xs text-text-secondary"
            onClick={onClose}
            aria-label="关闭列表"
          >
            关闭
          </button>
        )}
      </div>
      {deleteError && (
        <p role="alert" data-tone="error" className="ui-feedback mb-2 shrink-0">
          {deleteError}
        </p>
      )}
      <ul className="ui-bookmark-list min-h-0 flex-1 overflow-y-auto">
        {rows.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            {entry.type === 'folder' ? (
              ancestors.includes(entry.id) ? (
                <div
                  className="flex min-w-0 flex-1 cursor-not-allowed items-center gap-2.5 rounded-lg p-3 opacity-50"
                  title="无法打开循环文件夹"
                >
                  <Folder
                    aria-hidden="true"
                    className="h-8 w-8 shrink-0 rounded-lg bg-surface-secondary p-1.5"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="ui-interactive flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-3 text-left hover:bg-surface-secondary"
                  title={entry.title}
                  onClick={() => openEntry(entry)}
                >
                  <Folder
                    aria-hidden="true"
                    className="h-8 w-8 shrink-0 rounded-lg bg-surface-secondary p-1.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.title}</span>
                    <span className="block truncate text-xs text-text-secondary">文件夹</span>
                  </span>
                </button>
              )
            ) : (
              <>
                <button
                  type="button"
                  className="ui-interactive flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-3 text-left hover:bg-surface-secondary"
                  title={entry.title || entry.url}
                  onClick={() => openEntry(entry)}
                >
                  <SiteFavicon
                    url={entry.url ?? ''}
                    favicon={entry.favicon}
                    className="h-8 w-8 shrink-0 rounded-lg bg-white shadow-sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.title || entry.url}</span>
                    <span className="block truncate text-xs text-text-secondary">{entry.url}</span>
                  </span>
                </button>
                {onDelete && entry.url && (
                  <button
                    type="button"
                    aria-label={`取消收藏：${entry.title || entry.url}`}
                    title="取消收藏"
                    disabled={deletingUrl !== null}
                    onClick={() => {
                      void remove(entry);
                    }}
                    className="ui-interactive shrink-0 rounded-lg p-2 text-text-secondary hover:bg-surface-secondary hover:text-error disabled:opacity-40"
                  >
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li aria-disabled="true" className="ui-empty select-none">
            此文件夹为空
          </li>
        )}
      </ul>
    </div>
  );
}

/** 主页用容器：居中模态 dialog（backdrop 点击 / Esc 关闭），内容复用 BookmarkListPanel。 */
export function BookmarkListDialog({
  open,
  heading,
  entries,
  rootId = null,
  onClose,
  onNavigate,
  onDelete,
}: {
  readonly open: boolean;
  readonly heading: string;
  readonly entries: readonly BookmarkListEntry[];
  readonly rootId?: string | null;
  readonly onClose: () => void;
  readonly onNavigate: (url: string) => void;
  readonly onDelete?: (url: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialogRef}
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-label={heading}
      className="m-auto w-[min(560px,90vw)] rounded-xl border border-border bg-surface p-5 text-text shadow-xl backdrop:bg-black/30"
    >
      {/* key 强制切换站点/打开状态时重挂载，重置层级栈与删除状态 */}
      <BookmarkListPanel
        key={`${open}-${heading}`}
        className="max-h-[65vh]"
        heading={heading}
        entries={entries}
        rootId={rootId}
        onNavigate={(url) => {
          onNavigate(url);
          onClose();
        }}
        onDelete={onDelete}
        showClose
        onClose={onClose}
      />
    </dialog>
  );
}
