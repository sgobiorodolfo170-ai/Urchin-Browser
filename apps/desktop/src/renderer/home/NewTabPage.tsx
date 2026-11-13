/** 主页：收藏夹与最近浏览按网站归集，保留完整网页地址。 */
import { useEffect, useRef, useState } from 'react';
import type { BookmarkListRes, HistoryListRes } from '@urchin/ipc-contract';
import { Loader2 } from 'lucide-react';
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
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [active]);

  const renderSites = (sites: SiteGroup[], isRecent: boolean) =>
    sites.map((site) => (
      <button
        key={site.key}
        onClick={() => {
          if (!isRecent && site.pages.length === 1 && site.pages[0]) onNavigate(site.pages[0].url);
          else setSelected({ key: site.key, recent: isRecent });
        }}
        className="group flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
        title={siteDisplayName(site.url, site.title)}
        aria-haspopup={isRecent || site.pages.length > 1 ? 'dialog' : undefined}
      >
        <SiteFavicon
          url={site.url}
          favicon={site.favicon}
          className="h-10 w-10 rounded-lg bg-white shadow-sm"
        />
        <span className="w-full truncate text-center text-xs text-text-secondary group-hover:text-text">
          {siteDisplayName(site.url, site.title)}
        </span>
      </button>
    ));

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-surface px-6 pt-16 pb-10 text-text">
      <img src={BROWSER_ICON} alt="" className="h-16 w-16 rounded-2xl shadow-lg" />
      <h1 className="mt-3 font-brand text-2xl font-semibold">
        {displayNameForLocale(navigator.language)}
      </h1>
      <div className="mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-red-500 via-orange-400 to-red-500" />
      {loading && <Loader2 aria-label="加载中" className="mt-4 h-4 w-4 animate-spin" />}
      {error && (
        <p role="alert" className="mt-4 text-sm text-text-secondary">
          加载失败，请重新打开主页重试
        </p>
      )}
      <section className="mt-8 w-4/5" aria-label="常用网站">
        <h2 className="text-xs font-medium text-text-secondary">常用网站</h2>
        <div
          data-testid="frequent-sites"
          className="mt-4 grid max-h-[40vh] grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6 overflow-y-auto p-4"
        >
          {renderSites(frequent, false)}
          {!loading && !error && !frequent.length && (
            <p className="col-span-full text-center text-sm text-text-secondary">
              收藏网页后，将自动显示在这里
            </p>
          )}
        </div>
      </section>
      <div className="mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-blue-500 via-teal-400 to-green-500" />
      <section className="mt-8 w-4/5" aria-label="最近浏览">
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
        <ul className="max-h-[60vh] overflow-y-auto">
          {active?.pages.map((page) => (
            <li key={page.url}>
              <button
                className="w-full rounded-lg p-3 text-left hover:bg-surface-secondary"
                onClick={() => {
                  setSelected(null);
                  onNavigate(page.url);
                }}
              >
                <span className="block truncate">{page.title || page.url}</span>
                <span className="block truncate text-xs text-text-secondary">{page.url}</span>
              </button>
            </li>
          ))}
        </ul>
      </dialog>
    </div>
  );
}
