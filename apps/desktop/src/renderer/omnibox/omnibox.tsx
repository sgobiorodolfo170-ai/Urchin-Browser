/**
 * M4 Omnibox · 地址栏组件（纯 URL 输入）
 *
 * 依据：契约 J §5 OM6-OM9 决策
 * 职责：
 * 1. URL 输入解析 → 导航
 * 2. 150ms debounce 补全建议
 * 3. 安全状态指示（锁/Globe 图标）
 * 4. 获得焦点全选（OM7 决策）
 * 5. Escape 恢复原始 URL
 * 6. 加载进度条（OM8 决策）
 * 7. 收藏按钮 + 收藏夹面板（三选项卡：收藏夹 / 历史记录 / 下载列表）
 *
 * 阶段2 解耦决策：
 * 移除 AI 模式（mode 切换 / onAiSend / aiStreaming / submitAi）。
 * AI 模块改为独立标签页（urchin://ai），不再融合到地址栏。
 * 地址栏回归纯 URL 输入职责，简化逻辑、避免与 AI 模块耦合。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Lock,
  Globe,
  AlertTriangle,
  Star,
  Bookmark as BookmarkIcon,
  Sparkles,
  History,
  Clock,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  Pause,
  Play,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { parseInput } from './parse-input';
import { validateUrlBeforeNavigation } from './validate-url';
import type { Suggestion } from './types';

export interface OmniboxProps {
  /** 当前 URL */
  readonly currentUrl: string;
  /** 是否正在加载 */
  readonly loading: boolean;
  /** 页面安全状态 */
  readonly securityState: 'secure' | 'insecure' | 'mixed';
  /** 补全建议列表 */
  readonly suggestions: readonly Suggestion[];
  /** 导航回调 */
  readonly onNavigate: (url: string) => void;
  /** 补全查询回调 */
  readonly onSuggestionQuery: (query: string) => void;
  /** 当前 URL 是否已收藏（用于星标填充状态） */
  readonly bookmarkSaved?: boolean;
  /** 当前 URL 是否可收藏（http/https） */
  readonly bookmarkable?: boolean;
  /** 收藏按钮点击回调 */
  readonly onBookmarkToggle?: () => void;
  /** 收藏夹书签列表（用于下拉面板） */
  readonly bookmarks?: readonly BookmarkItem[];
  /** 收藏夹面板中书签点击回调 */
  readonly onBookmarkNavigate?: (url: string) => void;
  /** 摘要当前页面回调（点击摘要按钮时触发） */
  readonly onSummarize?: () => void;
  /** 摘要按钮是否禁用（如未配置 Provider 或流式生成中） */
  readonly summarizeDisabled?: boolean;
}

/** 收藏夹书签条目（与 IPC Bookmark 对齐） */
export interface BookmarkItem {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
}

/** 历史记录条目（与 IPC HistoryEntry 对齐） */
export interface HistoryItem {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly visitedAt: number;
  readonly visitCount: number;
}

/** 下载项（与 IPC DownloadItem 对齐） */
export interface DownloadItem {
  readonly id: string;
  readonly filename: string;
  readonly url: string;
  readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused';
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly savePath: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly mimeType?: string;
}

/** 面板选项卡类型 */
type PanelTab = 'bookmarks' | 'history' | 'downloads';

/** 收藏夹面板宽度（px，与面板 style width 对齐） */
const PANEL_WIDTH = 280;
/** 面板与地址栏/右侧边界的间距（px） */
const PANEL_MARGIN = 8;

/**
 * 安全状态图标。
 */
function SecurityIcon({ state }: { readonly state: OmniboxProps['securityState'] }) {
  if (state === 'secure') {
    return <Lock className="h-4 w-4 text-success" />;
  }
  if (state === 'mixed') {
    return <AlertTriangle className="h-4 w-4 text-warning" />;
  }
  return <Globe className="h-4 w-4 text-text-secondary" />;
}

/** 格式化字节数为人类可读字符串（如 1.5 MB） */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function Omnibox({
  currentUrl,
  loading,
  securityState,
  suggestions,
  onNavigate,
  onSuggestionQuery,
  bookmarkSaved = false,
  bookmarkable = false,
  onBookmarkToggle,
  bookmarks = [],
  onBookmarkNavigate,
  onSummarize,
  summarizeDisabled = false,
}: OmniboxProps) {
  const [input, setInput] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTab>('bookmarks');
  const [historyList, setHistoryList] = useState<readonly HistoryItem[]>([]);
  const [downloadList, setDownloadList] = useState<readonly DownloadItem[]>([]);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /** 懒加载历史记录：切换到历史记录选项卡时调用 */
  const loadHistory = useCallback(async () => {
    try {
      const result = (await window.urchin.invoke('history.list', {
        limit: 100,
        offset: 0,
      })) as { entries: readonly HistoryItem[]; total: number };
      setHistoryList(result.entries);
    } catch (e) {
      console.error('Failed to load history:', e);
      setHistoryList([]);
    }
  }, []);

  /** 懒加载下载列表：切换到下载列表选项卡时调用 */
  const loadDownloads = useCallback(async () => {
    try {
      const result = (await window.urchin.invoke('download.list', {})) as {
        downloads: readonly DownloadItem[];
      };
      setDownloadList(result.downloads ?? []);
    } catch (e) {
      console.error('Failed to load downloads:', e);
      setDownloadList([]);
    }
  }, []);

  // 外部 URL 变化时同步输入（非焦点状态）
  useEffect(() => {
    if (!isFocused) {
      setInput(currentUrl);
    }
  }, [currentUrl, isFocused]);

  // debounce 查询补全建议（OM2 决策：150ms）
  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        if (value.trim().length > 0) {
          onSuggestionQuery(value.trim());
        }
      }, 150);
    },
    [onSuggestionQuery],
  );

  // 回车处理：导航
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        const parsed = parseInput(input);
        const validation = validateUrlBeforeNavigation(parsed.url);
        if (validation.valid) {
          onNavigate(parsed.url);
          inputRef.current?.blur();
        }
      } else if (e.key === 'Escape') {
        setInput(currentUrl);
        inputRef.current?.blur();
      }
    },
    [input, currentUrl, onNavigate],
  );

  // 获得焦点全选（OM7 决策）
  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    e.target.select();
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    setInput(currentUrl);
  }, [currentUrl]);

  // 清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  // 点击外部关闭面板
  useEffect(() => {
    if (!showPanel) return;
    const handler = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowPanel(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPanel]);

  // 面板打开/关闭时，让出 BrowserView 右侧区域（面板所在位置）。
  //
  // 根因：Electron BrowserView 始终渲染在主窗口 webContents 之上。
  // 面板由 React 渲染并向上弹出（bottom-full），进入 BrowserView 区域时会被遮挡，
  // 导致面板不可见、内容不可点击、点击网页时面板也不关闭（事件进入 BrowserView 而非 document）。
  //
  // 2026-08-14 修复：不再整体隐藏 BrowserView（网页整个消失，用户感知为"被覆盖"），
  // 而是让出面板占用的右侧宽度（PANEL_WIDTH + 边距）——网页主体保持可见，
  // 面板显示在让出的矩形区域中。面板关闭时让出宽度归零，网页恢复全宽。
  useEffect(() => {
    const overlayRightWidth = showPanel ? PANEL_WIDTH + PANEL_MARGIN : 0;
    void window.urchin.invoke('ui.layout.setState', { overlayRightWidth }).catch((e) => {
      console.error('Failed to toggle overlay right width:', e);
    });
  }, [showPanel]);

  return (
    <div className="relative flex flex-1 items-center gap-1.5">
      <div
        className={cn(
          'inline-flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-surface px-2 text-sm',
          'transition-colors duration-fast',
          'focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-1',
          'border-border',
        )}
      >
        {/* 安全状态图标 */}
        <div className="flex shrink-0 items-center p-0.5">
          <SecurityIcon state={securityState} />
        </div>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="h-full w-full bg-transparent text-text outline-none placeholder:text-text-secondary"
          aria-label="地址栏"
        />
        {/* 加载指示器 */}
        {loading && (
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        )}
        {/* 收藏按钮：嵌入地址输入框最右边 */}
        <button
          type="button"
          className="flex shrink-0 items-center rounded p-0.5 hover:bg-surface-secondary disabled:opacity-40"
          onClick={() => onBookmarkToggle?.()}
          disabled={!bookmarkable}
          aria-label={bookmarkSaved ? '已收藏' : '收藏到书签'}
          title={bookmarkSaved ? '已收藏' : '收藏到书签'}
        >
          <Star className={cn('h-4 w-4', bookmarkSaved && 'fill-current text-warning')} />
        </button>
      </div>

      {/* 收藏夹按钮：紧邻收藏按钮（输入框外右侧），点击展开三选项卡面板 */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text"
        onClick={() => setShowPanel((v) => !v)}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="收藏夹"
        title="收藏夹"
        aria-expanded={showPanel}
      >
        <BookmarkIcon className="h-4 w-4" />
      </button>

      {/* AI 助手按钮：一键提取当前网页内容并保存到本地 */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => onSummarize?.()}
        disabled={summarizeDisabled || !onSummarize}
        aria-label="提取网页内容并保存"
        title="提取网页内容并保存"
      >
        <Sparkles className="h-4 w-4" />
      </button>

      {/* 加载进度条（OM8 决策） */}
      {loading && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-md">
          <div className="h-full w-1/3 animate-pulse bg-primary" />
        </div>
      )}

      {/* 补全建议面板（向上弹出：地址栏位于窗口底部，向下会被 overflow-hidden 裁剪） */}
      {isFocused && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-80 overflow-y-auto rounded-md border border-border bg-surface shadow-dropdown">
          {suggestions.map((sug, idx) => (
            <button
              key={`${sug.type}-${idx}`}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                'hover:bg-surface-secondary',
                'focus:bg-surface-secondary focus:outline-none',
              )}
              onClick={() => {
                onNavigate(sug.url);
                inputRef.current?.blur();
              }}
            >
              <span className="text-text-secondary">
                {sug.type === 'history' ? '🕐' : sug.type === 'bookmark' ? '⭐' : '🔍'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-text">{sug.title}</div>
                <div className="truncate text-xs text-text-secondary">{sug.url}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 收藏夹 / 历史记录 / 下载列表 面板（三选项卡，向上弹出，右下角定位）
       *  固定尺寸 280×430，紧贴地址栏上沿与右侧边栏左边界 */}
      {showPanel && (
        <div
          ref={panelRef}
          className="absolute bottom-full right-0 z-50 mb-1 flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-dropdown"
          style={{ width: 280, height: 430 }}
        >
          {/* 选项卡头部：收藏夹 / 历史记录 / 下载列表 */}
          <div className="flex shrink-0 border-b border-border">
            <button
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors',
                activeTab === 'bookmarks'
                  ? 'border-b-2 border-primary text-text'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => setActiveTab('bookmarks')}
            >
              <BookmarkIcon className="h-3 w-3" />
              收藏夹
            </button>
            <button
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors',
                activeTab === 'history'
                  ? 'border-b-2 border-primary text-text'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => {
                setActiveTab('history');
                void loadHistory();
              }}
            >
              <History className="h-3 w-3" />
              历史记录
            </button>
            <button
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors',
                activeTab === 'downloads'
                  ? 'border-b-2 border-primary text-text'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => {
                setActiveTab('downloads');
                void loadDownloads();
              }}
            >
              <Download className="h-3 w-3" />
              下载列表
            </button>
          </div>
          {/* 内容区：可滚动 */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'bookmarks' ? (
              bookmarks.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-text-secondary">暂无书签</div>
              ) : (
                bookmarks.map((bm) => (
                  <button
                    key={bm.id}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                      'hover:bg-surface-secondary',
                      'focus:bg-surface-secondary focus:outline-none',
                    )}
                    onClick={() => {
                      if (bm.url) {
                        onBookmarkNavigate?.(bm.url);
                        setShowPanel(false);
                      }
                    }}
                  >
                    <Star className="h-3 w-3 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-text">{bm.title}</div>
                      {bm.url && (
                        <div className="truncate text-xs text-text-secondary">{bm.url}</div>
                      )}
                    </div>
                  </button>
                ))
              )
            ) : activeTab === 'history' ? (
              historyList.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-text-secondary">
                  暂无历史记录
                </div>
              ) : (
                historyList.map((h) => (
                  <button
                    key={h.id}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                      'hover:bg-surface-secondary',
                      'focus:bg-surface-secondary focus:outline-none',
                    )}
                    onClick={() => {
                      onBookmarkNavigate?.(h.url);
                      setShowPanel(false);
                    }}
                  >
                    <Clock className="h-3 w-3 shrink-0 text-text-secondary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-text">{h.title || h.url}</div>
                      <div className="truncate text-xs text-text-secondary">{h.url}</div>
                    </div>
                  </button>
                ))
              )
            ) : downloadList.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-secondary">暂无下载记录</div>
            ) : (
              downloadList.map((dl) => (
                <div
                  key={dl.id}
                  className="flex items-start gap-3 px-3 py-2 text-sm hover:bg-surface-secondary"
                >
                  {/* 状态图标 */}
                  <div className="mt-0.5 shrink-0">
                    {dl.state === 'completed' && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    )}
                    {dl.state === 'progressing' && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    )}
                    {dl.state === 'paused' && <Pause className="h-3.5 w-3.5 text-warning" />}
                    {dl.state === 'cancelled' && <XCircle className="h-3.5 w-3.5 text-error" />}
                    {dl.state === 'interrupted' && (
                      <AlertTriangle className="h-3.5 w-3.5 text-error" />
                    )}
                  </div>
                  {/* 文件信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-text" title={dl.filename}>
                      {dl.filename}
                    </div>
                    <div className="truncate text-xs text-text-secondary" title={dl.url}>
                      {dl.url}
                    </div>
                    {/* 进度条 */}
                    {dl.state === 'progressing' && dl.totalBytes > 0 && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{
                            width: `${Math.round((dl.receivedBytes / dl.totalBytes) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                    <div className="mt-0.5 text-xs text-text-secondary">
                      {formatBytes(dl.receivedBytes)}
                      {dl.totalBytes > 0 && ` / ${formatBytes(dl.totalBytes)}`}
                      {dl.state === 'completed' && ' · 已完成'}
                      {dl.state === 'paused' && ' · 已暂停'}
                      {dl.state === 'cancelled' && ' · 已取消'}
                      {dl.state === 'interrupted' && ' · 已中断'}
                    </div>
                  </div>
                  {/* 操作按钮：暂停/恢复/取消（仅 progressing/paused 显示） */}
                  <div className="flex shrink-0 gap-1">
                    {dl.state === 'progressing' && (
                      <button
                        className="rounded p-1 text-text-secondary hover:bg-surface hover:text-text"
                        title="暂停"
                        onClick={() => {
                          void window.urchin
                            .invoke('download.pause', { id: dl.id })
                            .then(() => loadDownloads());
                        }}
                      >
                        <Pause className="h-3 w-3" />
                      </button>
                    )}
                    {dl.state === 'paused' && (
                      <button
                        className="rounded p-1 text-text-secondary hover:bg-surface hover:text-text"
                        title="恢复"
                        onClick={() => {
                          void window.urchin
                            .invoke('download.resume', { id: dl.id })
                            .then(() => loadDownloads());
                        }}
                      >
                        <Play className="h-3 w-3" />
                      </button>
                    )}
                    {(dl.state === 'progressing' || dl.state === 'paused') && (
                      <button
                        className="rounded p-1 text-text-secondary hover:bg-surface hover:text-text"
                        title="取消"
                        onClick={() => {
                          void window.urchin
                            .invoke('download.cancel', { id: dl.id })
                            .then(() => loadDownloads());
                        }}
                      >
                        <XCircle className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          {/* 下载列表选项卡的底部清空按钮 */}
          {activeTab === 'downloads' && downloadList.length > 0 && (
            <div className="shrink-0 border-t border-border px-3 py-1.5">
              <button
                className="text-xs text-text-secondary hover:text-text"
                onClick={() => {
                  void (async () => {
                    try {
                      await window.urchin.invoke('download.clear', {});
                      void loadDownloads();
                    } catch (e) {
                      console.error('Failed to clear downloads:', e);
                    }
                  })();
                }}
                title="清空已结束的下载"
              >
                清空已结束的下载
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
