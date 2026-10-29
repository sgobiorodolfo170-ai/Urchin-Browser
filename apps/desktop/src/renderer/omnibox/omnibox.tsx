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
  Scissors,
  Languages,
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
  /** 截图当前页面回调（截图保存到 <数据目录>/screenshots/） */
  readonly onScreenshot?: () => void;
  /** 截图按钮是否禁用（如无活跃网页可截） */
  readonly screenshotDisabled?: boolean;
  /** 翻译当前页面回调（M24 dev.81：未激活→整页翻译；激活→恢复原文） */
  readonly onTranslate?: () => void;
  /** 当前页面是否处于翻译激活态（按钮高亮 + title 切换） */
  readonly translateActive?: boolean;
  /** 翻译按钮是否禁用（非 http(s) 页面） */
  readonly translateDisabled?: boolean;
  /** 当前搜索引擎标识（searchEngine 设置；供搜索词生成搜索 URL） */
  readonly searchEngine?: string;
  /** 焦点变化透传（悬浮层据此展开/收起建议面板高度） */
  readonly onFocusChange?: (focused: boolean) => void;
  /**
   * 翻译按钮外部渲染：为 true 时 Omnibox 不渲染翻译按钮，
   * 由调用方在导航按钮区（刷新后）自行渲染，以便按需排版。
   */
  readonly translateExternal?: boolean;
}

/** 安全状态图标。 */
function SecurityIcon({ state }: { readonly state: OmniboxProps['securityState'] }) {
  if (state === 'secure') {
    return <Lock className="h-4 w-4 text-success" />;
  }
  if (state === 'mixed') {
    return <AlertTriangle className="h-4 w-4 text-warning" />;
  }
  return <Globe className="h-4 w-4 text-text-secondary" />;
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
  onScreenshot,
  screenshotDisabled = false,
  onTranslate,
  translateActive = false,
  translateDisabled = false,
  searchEngine,
  onFocusChange,
  translateExternal = false,
}: OmniboxProps) {
  const [input, setInput] = useState(currentUrl);
  const [isFocused, setIsFocused] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
        const parsed = parseInput(input, searchEngine);
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
    [input, currentUrl, onNavigate, searchEngine],
  );

  // 获得焦点全选（OM7 决策）
  const handleFocus = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocusChange?.(true);
      e.target.select();
    },
    [onFocusChange],
  );

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onFocusChange?.(false);
    setInput(currentUrl);
  }, [currentUrl, onFocusChange]);

  // 清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  // 收藏夹按钮点击：切换悬浮面板（独立子窗口，由主进程 BookmarkPanel 管理）。
  //
  // 2026-08-14 设计（用户原始意图）：面板是"由下往上弹出、悬浮置顶在网页之上"的
  // 小窗口，只覆盖网页右下角弹窗面积。Electron BrowserView（网页）永远渲染在主窗口
  // webContents（React）之上，React 浮层无法盖住网页，因此面板由主进程以独立
  // frameless 子窗口实现（天然悬浮于网页之上），渲染层仅发 ui.panel.toggle 通知。
  // 面板数据（书签/历史/下载）由面板窗口内联 JS 经 preload 的 window.urchin 拉取，
  // 无需渲染层中转。
  const handlePanelToggle = useCallback(() => {
    void window.urchin.invoke('ui.panel.toggle', {}).catch((e) => {
      console.error('Failed to toggle bookmark panel:', e);
    });
  }, []);

  return (
    <div className="relative flex flex-1 items-center gap-1.5">
      <div
        className={cn(
          'inline-flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-lg px-3 text-sm',
          'transition-colors duration-fast',
          'focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-1 dark:focus-within:ring-offset-0',
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
          className="h-full w-full rounded-md bg-transparent text-[16px] text-text outline-none placeholder:text-text-secondary"
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

      {/* 收藏夹按钮：点击切换悬浮面板（独立子窗口，由主进程 BookmarkPanel 管理，
       *  自下而上弹出、悬浮置顶于网页之上，只覆盖右下角弹窗面积） */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text"
        onClick={handlePanelToggle}
        aria-label="收藏夹"
        title="收藏夹"
      >
        <BookmarkIcon className="h-4 w-4" />
      </button>

      {/* 截图按钮：截取当前网页保存到 <数据目录>/screenshots/（地址栏收藏夹按钮之后） */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => onScreenshot?.()}
        disabled={screenshotDisabled || !onScreenshot}
        aria-label="截图当前网页"
        title="截图当前网页"
      >
        {/* -scale-x-100：剪刀图标左右翻转，让剪刀口朝左 */}
        <Scissors className="h-4 w-4 -scale-x-100" />
      </button>

      {/* AI 助手按钮（占位 · 待开发） */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-secondary hover:text-text"
        onClick={() => {
          /* AI 助手功能开发中 */
        }}
        aria-label="AI 助手（开发中）"
        title="AI 助手（开发中）"
      >
        <Sparkles className="h-4 w-4" />
      </button>

      {/* 翻译按钮（M24 dev.81）：未激活→整页翻译，激活→恢复原文；激活态高亮。
       * translateExternal=true 时由调用方在导航区渲染，此处跳过。 */}
      {!translateExternal && (
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center justify-center rounded-md p-1.5 hover:bg-surface-secondary disabled:opacity-40 disabled:hover:bg-transparent',
            translateActive ? 'text-primary' : 'text-text-secondary hover:text-text',
          )}
          onClick={() => onTranslate?.()}
          disabled={translateDisabled || !onTranslate}
          aria-label={translateActive ? '恢复原文' : '翻译网页'}
          title={translateActive ? '恢复原文' : '翻译网页'}
        >
          <Languages className="h-4 w-4" />
        </button>
      )}

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
    </div>
  );
}
