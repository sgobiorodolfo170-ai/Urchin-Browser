/** 主页：收藏夹与最近浏览按网站归集，保留完整网页地址。 */
import { useEffect, useRef, useState } from 'react';
import type { BookmarkCreateRes, BookmarkListRes, HistoryListRes } from '@urchin/ipc-contract';
import { Loader2, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { displayNameForLocale } from '../../shared/brand';
import { lookupBuiltinSite, builtinIconUrl } from './site-directory-lookup';
import { groupSitePages, type SiteGroup } from './site-groups';

export interface NewTabPageProps {
  readonly onNavigate: (url: string) => void;
}
const BROWSER_ICON = './browser-icon.png';
/** 主页复用浏览记录中的本地图标，避免向第三方服务发送浏览站点。 */
function SiteFavicon({
  url,
  favicon,
  className,
}: {
  url: string;
  favicon?: string;
  className?: string;
}) {
  const [srcIndex, setSrcIndex] = useState(0);
  const builtin = lookupBuiltinSite(url);
  const sources = [
    ...(favicon ? [favicon] : []),
    ...(builtin ? [builtinIconUrl(builtin)] : []),
    BROWSER_ICON,
  ];
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

/**
 * 站点显示名：内置目录命中用内置名（如 GitHub/哔哩哔哩），未命中用 history 标题。
 */
function siteDisplayName(url: string, fallbackTitle: string): string {
  const builtin = lookupBuiltinSite(url);
  return builtin ? builtin.name : fallbackTitle || url;
}

export function NewTabPage({ onNavigate }: NewTabPageProps) {
  const [frequent, setFrequent] = useState<SiteGroup[]>([]);
  const [recent, setRecent] = useState<SiteGroup[]>([]);
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const ordersRef = useRef<Record<string, string[]>>({});
  const refreshRef = useRef<() => Promise<void>>(async () => {
    await Promise.resolve();
  });
  const saving = useRef(false);
  const [drag, setDrag] = useState<{
    site: SiteGroup;
    recent: boolean;
    x: number;
    y: number;
  } | null>(null);
  const gesture = useRef<{
    site: SiteGroup;
    recent: boolean;
    x: number;
    y: number;
    ready: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClick = useRef(false);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<{ key: string; recent: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const active =
    selected && (selected.recent ? recent : frequent).find((s) => s.key === selected.key);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const [bookmarks, first] = await Promise.all([
          window.urchin.invoke('bookmark.list', {}) as Promise<BookmarkListRes>,
          window.urchin.invoke('history.list', {
            limit: 500,
            offset: 0,
          }) as Promise<HistoryListRes>,
        ]);
        const entries = [...first.entries];
        while (entries.length < first.total) {
          if (cancelled || current !== generation) return;
          const page = (await window.urchin.invoke('history.list', {
            limit: 500,
            offset: entries.length,
          })) as HistoryListRes;
          if (!page.entries.length) break;
          entries.push(...page.entries);
        }
        if (cancelled || current !== generation) return;
        setFrequent(
          groupSitePages(
            bookmarks.bookmarks.flatMap((b) =>
              b.type !== 'folder' && b.url ? [{ ...b, url: b.url, time: b.createdAt }] : [],
            ),
          ),
        );
        setRecent(groupSitePages(entries.map((e) => ({ ...e, time: e.visitedAt }))).slice(0, 20));
        setError(false);
      } catch {
        if (!cancelled && current === generation) setError(true);
      } finally {
        if (!cancelled && current === generation) setLoading(false);
      }
    };
    refreshRef.current = refresh;
    void (async () => {
      const values = await Promise.all(
        ['home.frequentSiteOrder', 'home.recentSiteOrder'].map(async (key) => {
          const res = (await window.urchin.invoke('settings.get', { key })) as { value: unknown };
          return [
            key,
            Array.isArray(res.value)
              ? res.value.filter((v): v is string => typeof v === 'string')
              : [],
          ] as const;
        }),
      );
      if (!cancelled) {
        ordersRef.current = Object.fromEntries(values);
        setOrders(ordersRef.current);
      }
    })().catch(() => {
      if (!cancelled) setNotice('图标顺序加载失败');
    });
    void refresh();
    const unsubscribe = window.urchin.on('bookmark:changed', () => {
      void refresh();
    });
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      if (gesture.current) clearTimeout(gesture.current.timer);
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [active]);

  const ordered = (sites: SiteGroup[], isRecent: boolean) => {
    const order = orders[isRecent ? 'home.recentSiteOrder' : 'home.frequentSiteOrder'] ?? [];
    const ranks = new Map(order.map((key, index) => [key, index]));
    return [...sites].sort(
      (a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity),
    );
  };

  const finishDrag = async (x: number, y: number) => {
    const source = gesture.current;
    if (!source) return;
    clearTimeout(source.timer);
    gesture.current = null;
    setDrag(null);
    if (!source.ready) return;
    suppressClick.current = source.moved;
    const hit = document.elementFromPoint(x, y);
    const zone = hit?.closest<HTMLElement>('[data-site-zone]')?.dataset.siteZone;
    if (saving.current || !source.moved) return;
    if (source.recent && !zone) return;
    const targetRecent = zone === 'recent';

    saving.current = true;
    setNotice('');
    try {
      if (!source.recent && zone !== 'frequent') {
        const res = (await window.urchin.invoke('bookmark.list', {})) as BookmarkListRes;
        const group = groupSitePages(
          res.bookmarks.flatMap((b) =>
            b.url && b.type === 'bookmark'
              ? [{ url: b.url, title: b.title, time: b.createdAt }]
              : [],
          ),
        ).find((site) => site.key === source.site.key);
        const urls = new Set(group?.pages.map((page) => page.url));
        for (const bookmark of res.bookmarks) {
          if (bookmark.type === 'bookmark' && bookmark.url && urls.has(bookmark.url)) {
            await window.urchin.invoke('bookmark.delete', { id: bookmark.id });
          }
        }
        await refreshRef.current();
        return;
      }
      if (source.recent && !targetRecent) {
        const res = (await window.urchin.invoke('bookmark.list', {})) as BookmarkListRes;
        const saved = new Set(res.bookmarks.map((b) => b.url));
        const missing = source.site.pages.filter((page) => !saved.has(page.url));
        if (missing.length) {
          let folder = res.bookmarks.find(
            (b) => b.type === 'folder' && b.parentId === null && b.title === '最近浏览',
          );
          folder ??= (
            (await window.urchin.invoke('bookmark.create', {
              type: 'folder',
              parentId: null,
              title: '最近浏览',
            })) as BookmarkCreateRes
          ).bookmark;
          // 从旧到新保存，使收藏列表仍保持最新网页在上。
          for (const page of [...missing].reverse()) {
            await window.urchin.invoke('bookmark.create', {
              type: 'bookmark',
              parentId: folder.id,
              url: page.url,
              title: page.title || page.url,
            });
          }
        }
        await refreshRef.current();
      }
      const key = targetRecent ? 'home.recentSiteOrder' : 'home.frequentSiteOrder';
      const sites = ordered(targetRecent ? recent : frequent, targetRecent);
      const next = sites.map((site) => site.key).filter((site) => site !== source.site.key);
      const target = hit?.closest<HTMLElement>('[data-site-key]')?.dataset.siteKey;
      if (target === source.site.key && source.recent === targetRecent) return;
      const index = target ? next.indexOf(target) : -1;
      next.splice(index < 0 ? next.length : index, 0, source.site.key);
      await window.urchin.invoke('settings.set', { key, value: next });
      ordersRef.current = { ...ordersRef.current, [key]: next };
      setOrders(ordersRef.current);
    } catch {
      setNotice('保存失败，请重试');
      await refreshRef.current();
    } finally {
      saving.current = false;
    }
  };

  const deleteBookmark = async (url: string) => {
    if (saving.current) return;
    saving.current = true;
    setDeletingUrl(url);
    setDeleteError('');
    try {
      const res = (await window.urchin.invoke('bookmark.list', {})) as BookmarkListRes;
      for (const bookmark of res.bookmarks) {
        if (bookmark.type === 'bookmark' && bookmark.url === url) {
          await window.urchin.invoke('bookmark.delete', { id: bookmark.id });
        }
      }
      await refreshRef.current();
    } catch {
      setDeleteError('取消收藏失败，请重试');
      await refreshRef.current();
    } finally {
      setDeletingUrl(null);
      saving.current = false;
    }
  };

  const renderSites = (sites: SiteGroup[], isRecent: boolean) =>
    ordered(sites, isRecent).map((site) => (
      <button
        key={site.key}
        data-site-key={site.key}
        style={{
          touchAction: 'none',
          opacity: drag?.site.key === site.key && drag.recent === isRecent ? 0 : 1,
        }}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0 || saving.current) return;
          suppressClick.current = false;
          if (gesture.current) clearTimeout(gesture.current.timer);
          const source = {
            site,
            recent: isRecent,
            x: e.clientX,
            y: e.clientY,
            ready: false,
            moved: false,
            startX: e.clientX,
            startY: e.clientY,
            timer: setTimeout(() => {
              source.ready = true;
              setDrag({ site, recent: isRecent, x: source.x, y: source.y });
            }, 120),
          };
          gesture.current = source;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const source = gesture.current;
          if (!source) return;
          source.moved ||= Math.hypot(e.clientX - source.startX, e.clientY - source.startY) > 6;
          source.x = e.clientX;
          source.y = e.clientY;
          if (source.ready) setDrag({ site, recent: isRecent, x: e.clientX, y: e.clientY });
        }}
        onPointerUp={(e) => {
          if (gesture.current)
            gesture.current.moved ||=
              Math.hypot(e.clientX - gesture.current.startX, e.clientY - gesture.current.startY) >
              6;
          void finishDrag(e.clientX, e.clientY);
        }}
        onPointerCancel={() => {
          if (gesture.current) clearTimeout(gesture.current.timer);
          gesture.current = null;
          setDrag(null);
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (!isRecent && site.pages.length === 1 && site.pages[0]) onNavigate(site.pages[0].url);
          else {
            setDeleteError('');
            setSelected({ key: site.key, recent: isRecent });
          }
        }}
        className="group flex min-w-0 cursor-grab select-none flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
        aria-label={siteDisplayName(site.url, site.title)}
        title={siteDisplayName(site.url, site.title)}
        aria-haspopup={isRecent || site.pages.length > 1 ? 'dialog' : undefined}
      >
        <SiteFavicon
          url={site.url}
          favicon={site.favicon}
          className="h-10 w-10 rounded-lg bg-white shadow-sm"
        />
        {isRecent && (
          <span className="w-full truncate text-center text-xs text-text-secondary group-hover:text-text">
            {siteDisplayName(site.url, site.title)}
          </span>
        )}
      </button>
    ));

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-surface px-6 pt-16 pb-10 text-text">
      <img src={BROWSER_ICON} alt="" className="h-16 w-16 rounded-2xl shadow-lg" />
      <h1 className="mt-3 font-brand text-2xl font-semibold">
        {displayNameForLocale(navigator.language)}
      </h1>
      <div className="mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-red-500 via-orange-400 to-red-500" />
      {drag && (
        <div
          data-testid="dragged-site-icon"
          className="pointer-events-none fixed z-50"
          style={{ left: drag.x - 20, top: drag.y - 20 }}
        >
          <SiteFavicon url={drag.site.url} favicon={drag.site.favicon} className="h-10 w-10" />
        </div>
      )}
      <section className="mt-8 w-4/5" aria-label="常用网站" data-site-zone="frequent">
        <div
          data-testid="frequent-sites"
          className="mt-4 grid min-h-[72px] max-h-[40vh] grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6 overflow-y-auto p-4"
        >
          {renderSites(frequent, false)}
        </div>
      </section>
      <div className="mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-blue-500 via-teal-400 to-green-500" />
      {loading && <Loader2 aria-label="加载中" className="mt-4 h-4 w-4 animate-spin" />}
      {error && (
        <p role="alert" className="mt-4 text-sm text-text-secondary">
          加载失败，请重新打开主页重试
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          {notice}
        </p>
      )}
      <section className="mt-8 w-4/5" aria-label="最近浏览" data-site-zone="recent">
        <h2 className="text-xs font-medium text-text-secondary">最近浏览</h2>
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6">
          {renderSites(recent, true)}
          {!loading && !error && !recent.length && (
            <p className="col-span-full text-center text-sm text-text-secondary">暂无浏览记录</p>
          )}
        </div>
      </section>
      <dialog
        ref={dialog}
        onCancel={() => setSelected(null)}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            const r = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              setSelected(null);
          }
        }}
        aria-label={selected?.recent ? '最近浏览列表' : '书签列表'}
        className="m-auto w-[min(560px,90vw)] rounded-xl border border-border bg-surface p-5 text-text shadow-xl backdrop:bg-black/30"
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="truncate font-medium">
            {active && siteDisplayName(active.url, active.title)} ·{' '}
            {selected?.recent ? '最近浏览' : '书签列表'}
          </h2>
          <button onClick={() => setSelected(null)} aria-label="关闭列表">
            关闭
          </button>
        </div>
        {deleteError && (
          <p role="alert" className="mb-2 text-sm text-red-500">
            {deleteError}
          </p>
        )}
        <ul className="max-h-[60vh] overflow-y-auto">
          {active?.pages.map((page) => (
            <li key={page.url} className="flex items-center gap-2">
              <button
                className="min-w-0 flex-1 rounded-lg p-3 text-left hover:bg-surface-secondary"
                onClick={() => {
                  setSelected(null);
                  onNavigate(page.url);
                }}
              >
                <span className="block truncate">{page.title || page.url}</span>
                <span className="block truncate text-xs text-text-secondary">{page.url}</span>
              </button>
              {!selected?.recent && (
                <button
                  type="button"
                  aria-label={`取消收藏：${page.title || page.url}`}
                  title="取消收藏"
                  disabled={deletingUrl !== null}
                  onClick={() => {
                    void deleteBookmark(page.url);
                  }}
                  className="shrink-0 rounded-lg p-2 text-text-secondary hover:bg-surface-secondary hover:text-red-500 disabled:opacity-40"
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </dialog>
    </div>
  );
}
