/**
 * 主页（urchin://newtab · React 渲染）
 *
 * 布局（自上而下）：
 * 1. 顶部居中：浏览器图标 + 浏览器名
 * 2. 红橙渐变分割线（宽度不到边、留空，高 2px）
 * 3. 常用网站书签区（favicon 网格）—— 由最近浏览手动拖入，不可重复，可拖拽排序
 * 4. 蓝绿渐变分割线
 * 5. 最近浏览书签区（自动派生自 history，仅根网址，去重，最新浏览在前）
 *
 * 数据：
 * - 常用书签持久化于 settings（home.frequentSites: { url, title }[]，仅根网址）
 * - 最近浏览由 history.list 派生（取根域 origin，按最近浏览时间去重排序）
 * - favicon 用 Google favicon 服务（真实网站图标）
 *
 * 交互：
 * - 最近浏览区卡片可拖入常用区（自动去重：已存在则不添加）
 * - 常用区卡片可拖拽排序（drop 后持久化）
 * - 点击任意卡片 → 在当前标签页打开该网址
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

/** 常用网站条目（仅根网址） */
export interface FrequentSite {
  readonly url: string;
  readonly title: string;
}

/** 主页 props */
export interface NewTabPageProps {
  /** 打开网址（当前标签页导航） */
  readonly onNavigate: (url: string) => void;
}

/** 最近浏览区最大展示数 */
const RECENT_LIMIT = 20;

/** 浏览器内置图标（主页顶部标题用；随 renderer 打包） */
const BROWSER_ICON = '/browser-icon.png';

/**
 * 网站 favicon 候选源（按序尝试；Google 服务不可达时回退到 DuckDuckGo）。
 * 全部失败时组件显示内置浏览器图标。
 */
const FAVICON_SOURCES = [
  (host: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
  (host: string) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
];

/**
 * 网站去重键：origin 去掉 www. 前缀。
 * 同一网站的不同形式（https://github.com / https://www.github.com / 带尾斜杠）视为同一网站，
 * 用于常用区去重与最近区前移判断。
 */
function siteKey(url: string): string {
  const root = toRootUrl(url);
  if (!root) return url;
  return root.replace(/^https?:\/\/www\./i, root.startsWith('https://') ? 'https://' : 'http://');
}

/** 提取根网址（origin，如 https://www.baidu.com；无协议则补 https） */
function toRootUrl(url: string): string | null {
  try {
    // 显式非 http(s) 协议（file:/data:/javascript: 等）直接拒绝；
    // 避免 URL 容错把 file:///C:/x.html 拼 https: 前缀后误判为合法
    const lower = url.trim().toLowerCase();
    if (lower.includes('://') && !lower.startsWith('http://') && !lower.startsWith('https://')) {
      return null;
    }
    const u = lower.startsWith('http') ? new URL(lower) : new URL(`https://${lower}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 拖拽数据类型（区分来源：常用区重排 vs 最近区拖入） */
type DragPayload = { kind: 'frequent'; index: number } | { kind: 'recent'; site: FrequentSite };

/**
 * 网站 favicon（多源回退）。
 *
 * Google 服务不可达（如网络受限）时依次尝试 DuckDuckGo；全部失败则显示浏览器内置图标，
 * 不再隐藏（此前隐藏导致卡片图标空白）。
 */
function SiteFavicon({ url, className }: { url: string; className?: string }) {
  const [srcIndex, setSrcIndex] = useState(0);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  const source = srcIndex < FAVICON_SOURCES.length && host ? FAVICON_SOURCES[srcIndex] : undefined;
  const src = source ? source(host) : '';
  // 所有源失败 → 显示内置图标（最终回退）
  const finalUrl = src || BROWSER_ICON;

  return (
    <img
      src={finalUrl}
      alt=""
      className={className}
      draggable={false}
      onError={() => {
        // 当前源失败 → 尝试下一源；已到末尾则用内置图标（不会再触发 onError）
        if (srcIndex < FAVICON_SOURCES.length) {
          setSrcIndex((i) => i + 1);
        }
      }}
    />
  );
}

/**
 * 主页组件。
 *
 * 挂载时：加载常用书签（settings.home.frequentSites）+ 最近浏览（history.list 派生根域）。
 * 常用书签变更即持久化。
 */
export function NewTabPage({ onNavigate }: NewTabPageProps) {
  const [frequent, setFrequent] = useState<readonly FrequentSite[]>([]);
  const [recent, setRecent] = useState<readonly FrequentSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOverFrequent, setDragOverFrequent] = useState(false);
  /** 拖拽期间是否已落在常用区内（dragend 判断"拖出即删除"用） */
  const droppedInFrequentRef = useRef(false);

  // 加载常用书签 + 最近浏览
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settingsRes, historyRes] = await Promise.all([
          window.urchin.invoke('settings.get', { key: 'home.frequentSites' }),
          window.urchin.invoke('history.list', { limit: RECENT_LIMIT, offset: 0 }),
        ]);
        if (cancelled) return;
        const saved = (settingsRes as { value: unknown }).value;
        const frequentSites = Array.isArray(saved)
          ? (saved as FrequentSite[]).filter(
              (s) => typeof s.url === 'string' && typeof s.title === 'string',
            )
          : [];
        // 清洗：按 siteKey 去重（整个常用区不可有相同网站，含历史脏数据/跨行重复）
        const freqSeen = new Set<string>();
        const dedupedFrequent: FrequentSite[] = [];
        for (const s of frequentSites) {
          const key = siteKey(s.url);
          if (freqSeen.has(key)) continue;
          freqSeen.add(key);
          dedupedFrequent.push(s);
        }
        setFrequent(dedupedFrequent);
        // 最近浏览：history 按 visitedAt 降序 → 取根域去重（保序=最新在前）
        const entries = (historyRes as { entries: { url: string; title: string }[] }).entries ?? [];
        const seen = new Set<string>();
        const recentSites: FrequentSite[] = [];
        for (const e of entries) {
          const root = toRootUrl(e.url);
          if (!root) continue;
          const key = siteKey(root);
          if (seen.has(key)) continue;
          seen.add(key);
          recentSites.push({ url: root, title: e.title || root });
        }
        setRecent(recentSites);
      } catch {
        // 加载失败保持空
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 持久化常用书签 */
  const persistFrequent = useCallback((next: readonly FrequentSite[]) => {
    setFrequent(next);
    void window.urchin
      .invoke('settings.set', { key: 'home.frequentSites', value: [...next] })
      .catch(() => {
        // 持久化失败静默（UI 仍生效）
      });
  }, []);

  /** 常用区 drop：最近区拖入（去重）或常用区内重排 */
  const handleFrequentDrop = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      setDragOverFrequent(false);
      droppedInFrequentRef.current = true;
      let payload: DragPayload | null = null;
      try {
        payload = JSON.parse(e.dataTransfer.getData('text/plain')) as DragPayload;
      } catch {
        return;
      }
      if (!payload) return;

      if (payload.kind === 'recent') {
        // 最近区拖入常用区：按 siteKey 去重（整个常用区不可重复，跨行亦不重复）
        const url = payload.site.url;
        const key = siteKey(url);
        if (frequent.some((s) => siteKey(s.url) === key)) return;
        const next = [...frequent];
        next.splice(targetIndex, 0, { url, title: payload.site.title });
        persistFrequent(next);
      } else if (payload.kind === 'frequent' && payload.index !== targetIndex) {
        // 常用区内拖拽排序
        const next = [...frequent];
        const [moved] = next.splice(payload.index, 1);
        if (!moved) return;
        next.splice(targetIndex, 0, moved);
        persistFrequent(next);
      }
    },
    [frequent, persistFrequent],
  );

  const handleDragStart = useCallback((e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    // 重置"已落在常用区"标记
    droppedInFrequentRef.current = false;
    // 自定义拖拽 ghost：只显示图标（避免整卡/整行被一起拖动的视觉）
    const img = (e.currentTarget as HTMLElement).querySelector('img');
    if (img && typeof e.dataTransfer.setDragImage === 'function') {
      e.dataTransfer.setDragImage(img, 16, 16);
    }
  }, []);

  /**
   * 常用区书签拖拽结束：若拖出常用区（两条分割线间的矩形区域），将该书签移出常用区。
   */
  const handleFrequentDragEnd = useCallback(
    (url: string) => {
      // 已落在常用区内（重排或追加）→ 保留；否则视为拖出 → 删除
      if (droppedInFrequentRef.current) {
        droppedInFrequentRef.current = false;
        return;
      }
      droppedInFrequentRef.current = false;
      persistFrequent(frequent.filter((s) => s.url !== url));
    },
    [frequent, persistFrequent],
  );

  /** 打开网址（当前标签页） */
  const openSite = useCallback(
    (url: string) => {
      onNavigate(url);
    },
    [onNavigate],
  );

  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-surface px-6 pt-16 pb-10 text-text">
      {/* 顶部：浏览器图标（本浏览器内置图标）+ 浏览器名（居中） */}
      <div className="flex flex-col items-center">
        <img
          src={BROWSER_ICON}
          alt="Urchin Browser"
          className="h-16 w-16 rounded-2xl shadow-lg"
          draggable={false}
        />
        <h1 className="mt-3 text-2xl font-semibold">Urchin Browser</h1>
      </div>

      {/* 红橙渐变分割线（宽度不到边、留空，高 2px；sticky 吸顶，常用区新增行/页面
       *  滚动后仍保持可见，不随内容滚出顶部） */}
      <div className="sticky top-0 z-10 mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-red-500 via-orange-400 to-red-500" />

      {/* 常用网站书签区 */}
      <div className="mt-8 w-4/5">
        <div
          className={cn(
            // 限高 40vh + 内部滚动：常用区多行时在区内滚动查看，蓝绿分割线保持在首屏可见
            'max-h-[40vh] grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6 overflow-y-auto rounded-xl p-4 transition-colors',
            dragOverFrequent && 'bg-surface-secondary',
          )}
          data-testid="frequent-sites"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverFrequent(true);
          }}
          onDragLeave={() => setDragOverFrequent(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverFrequent(false);
            // 拖到区域空白处：标记已落在常用区内（防止 dragend 误删），并处理追加
            droppedInFrequentRef.current = true;
            const payload = (() => {
              try {
                return JSON.parse(e.dataTransfer.getData('text/plain')) as DragPayload;
              } catch {
                return null;
              }
            })();
            if (payload?.kind === 'recent') {
              const key = siteKey(payload.site.url);
              if (!frequent.some((s) => siteKey(s.url) === key)) {
                persistFrequent([
                  ...frequent,
                  { url: payload.site.url, title: payload.site.title },
                ]);
              }
            } else if (payload?.kind === 'frequent') {
              // 常用区内拖到末尾（重排）
              const next = [...frequent];
              const [moved] = next.splice(payload.index, 1);
              if (moved) {
                next.push(moved);
                persistFrequent(next);
              }
            }
          }}
        >
          {frequent.length === 0 && (
            <div className="col-span-full py-6 text-center text-sm text-text-secondary">
              从下方「最近浏览」拖拽网站到这里，添加为常用
            </div>
          )}
          {frequent.map((site, idx) => (
            <button
              key={site.url}
              draggable
              onDragStart={(e) => handleDragStart(e, { kind: 'frequent', index: idx })}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                // 阻止冒泡到容器 onDrop（否则事件被重复处理，导致重复 persist）
                e.stopPropagation();
                handleFrequentDrop(e, idx);
              }}
              onDragEnd={() => handleFrequentDragEnd(site.url)}
              onClick={() => openSite(site.url)}
              className="group flex select-none flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
              title={site.title}
            >
              <SiteFavicon url={site.url} className="h-10 w-10 rounded-lg bg-white shadow-sm" />
              <span className="w-full truncate text-center text-xs text-text-secondary group-hover:text-text">
                {site.title}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 蓝绿渐变分割线（宽度不到边、留空，高 2px；shrink-0 防止被外层 flex 压缩——
       *  根因：40 书签超高时蓝绿线 height 被压成 0 消失；随常用区自动下移） */}
      <div className="mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-blue-500 via-teal-400 to-green-500" />

      {/* 最近浏览书签区（自动派生，仅根网址，最新在前，可拖入常用区） */}
      <div className="mt-8 w-4/5">
        <h2 className="text-xs font-medium text-text-secondary">最近浏览</h2>
        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6">
          {loading ? (
            <div className="col-span-full flex items-center justify-center gap-2 py-6 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中…
            </div>
          ) : recent.length === 0 ? (
            <div className="col-span-full py-6 text-center text-sm text-text-secondary">
              暂无浏览记录
            </div>
          ) : (
            recent.map((site) => (
              <button
                key={site.url}
                draggable
                onDragStart={(e) => handleDragStart(e, { kind: 'recent', site })}
                onClick={() => openSite(site.url)}
                className="group flex select-none flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
                title={site.title}
              >
                <SiteFavicon url={site.url} className="h-10 w-10 rounded-lg bg-white shadow-sm" />
                <span className="w-full truncate text-center text-xs text-text-secondary group-hover:text-text">
                  {site.title}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
