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
import { Compass, Loader2 } from 'lucide-react';
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

/** favicon URL（Google favicon 服务，真实网站图标） */
function faviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return '';
  }
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
        setFrequent(frequentSites);
        // 最近浏览：history 按 visitedAt 降序 → 取根域去重（保序=最新在前）
        const entries = (historyRes as { entries: { url: string; title: string }[] }).entries ?? [];
        const seen = new Set<string>();
        const recentSites: FrequentSite[] = [];
        for (const e of entries) {
          const root = toRootUrl(e.url);
          if (!root || seen.has(root)) continue;
          seen.add(root);
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
        // 最近区拖入常用区：去重（相同根网址不重复添加）
        const url = payload.site.url;
        if (frequent.some((s) => s.url === url)) return;
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
    // 拖拽开始：重置"已落在常用区"标记
    droppedInFrequentRef.current = false;
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
      {/* 顶部：浏览器图标 + 浏览器名（居中） */}
      <div className="flex flex-col items-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent text-white shadow-lg">
          <Compass className="h-8 w-8" />
        </div>
        <h1 className="mt-3 text-2xl font-semibold">Urchin Browser</h1>
      </div>

      {/* 红橙渐变分割线（宽度不到边、留空，高 2px；sticky 吸顶，常用区新增行/页面
       *  滚动后仍保持可见，不随内容滚出顶部） */}
      <div className="sticky top-0 z-10 mt-6 h-0.5 w-4/5 shrink-0 rounded-full bg-gradient-to-r from-red-500 via-orange-400 to-red-500" />

      {/* 常用网站书签区 */}
      <div className="mt-8 w-4/5">
        <div
          className={cn(
            'grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-x-4 gap-y-6 rounded-xl p-4 transition-colors',
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
              if (!frequent.some((s) => s.url === payload.site.url)) {
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
              className="group flex flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
              title={site.title}
            >
              <img
                src={faviconUrl(site.url)}
                alt=""
                className="h-10 w-10 rounded-lg bg-white shadow-sm"
                draggable={false}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
              <span className="w-full truncate text-center text-xs text-text-secondary group-hover:text-text">
                {site.title}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 蓝绿渐变分割线 */}
      <div className="mt-6 h-0.5 w-4/5 rounded-full bg-gradient-to-r from-blue-500 via-teal-400 to-green-500" />

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
                className="group flex flex-col items-center gap-1.5 rounded-lg p-2 hover:bg-surface-secondary"
                title={site.title}
              >
                <img
                  src={faviconUrl(site.url)}
                  alt=""
                  className="h-10 w-10 rounded-lg bg-white shadow-sm"
                  draggable={false}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = 'hidden';
                  }}
                />
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
