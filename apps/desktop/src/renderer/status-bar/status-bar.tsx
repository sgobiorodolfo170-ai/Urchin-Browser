/**
 * 底部悬浮状态栏卡片（悬浮层渲染进程内使用）。
 *
 * 2026-10-23：状态栏改为独立透明子窗口悬浮于网页之上，本组件由 StatusBarApp
 * 挂载，接收主渲染进程经主进程转发的状态快照，并将用户动作回传主渲染进程。
 * 复用 Omnibox 以保持地址输入/建议/功能按钮行为一致。
 *
 * 2026-10-24：翻译按钮移至刷新后；折叠/展开由独立悬浮球点击控制（卡片不再有折叠按钮）。
 */
import { ArrowLeft, ArrowRight, RotateCw, Languages } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { Omnibox } from '../omnibox/omnibox';
import type { StatusBarState, StatusBarAction } from '@urchin/ipc-contract';

export interface StatusBarProps {
  readonly state: StatusBarState;
  readonly focused: boolean;
  readonly onAction: (action: StatusBarAction) => void;
  readonly onFocusChange: (focused: boolean) => void;
}

export function StatusBar({ state, focused, onAction, onFocusChange }: StatusBarProps) {
  const suggestionsOpen = focused && state.suggestions.length > 0;
  // 建议面板展开时抑制 toast，避免两者在同一向上展开区重叠
  const toast = suggestionsOpen ? null : state.toast;

  return (
    <div className="flex h-full flex-col justify-end p-2">
      {!state.collapsed && toast && (
        <div className="mb-1 flex items-center justify-center gap-1.5">
          <div className="flex max-w-full items-center gap-1.5 truncate rounded-md border border-border bg-surface-secondary px-3 py-1.5 text-xs text-text shadow-md">
            {toast.spinning && <RotateCw className="h-3 w-3 shrink-0 animate-spin" />}
            <span className="truncate">{toast.text}</span>
          </div>
        </div>
      )}

      {/* 浮动地址栏本体：3/5 宽由主进程窗口几何控制，此处满宽；3D 底色见 .status-bar-card */}
      <div className="status-bar-card flex h-10 w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/60 px-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          onClick={() => onAction({ type: 'back' })}
          disabled={!state.canGoBack}
          aria-label="后退"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          onClick={() => onAction({ type: 'forward' })}
          disabled={!state.canGoForward}
          aria-label="前进"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          onClick={() => onAction({ type: 'reload' })}
          disabled={state.reloadDisabled}
          aria-label="刷新"
        >
          <RotateCw className={cn('h-4 w-4', state.loading && 'animate-spin')} />
        </Button>

        {/* 翻译按钮移至刷新后（从 Omnibox 内移出） */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 w-8 shrink-0 p-0',
            state.translateActive ? 'text-primary' : 'text-text-secondary hover:text-text',
          )}
          onClick={() => onAction({ type: 'translate' })}
          disabled={state.translateDisabled}
          aria-label={state.translateActive ? '恢复原文' : '翻译网页'}
          title={state.translateActive ? '恢复原文' : '翻译网页'}
        >
          <Languages className="h-4 w-4" />
        </Button>

        <Omnibox
          currentUrl={state.url}
          loading={state.loading}
          securityState={state.securityState}
          suggestions={state.suggestions}
          onNavigate={(url) => onAction({ type: 'navigate', url })}
          onSuggestionQuery={(query) => onAction({ type: 'suggestion-query', query })}
          bookmarkSaved={state.bookmarkSaved}
          bookmarkable={state.bookmarkable}
          onBookmarkToggle={() => onAction({ type: 'bookmark-toggle' })}
          onScreenshot={() => onAction({ type: 'screenshot' })}
          screenshotDisabled={state.screenshotDisabled}
          onTranslate={() => onAction({ type: 'translate' })}
          translateActive={state.translateActive}
          translateDisabled={state.translateDisabled}
          searchEngine={state.searchEngine}
          onFocusChange={onFocusChange}
          translateExternal
        />
      </div>
    </div>
  );
}
