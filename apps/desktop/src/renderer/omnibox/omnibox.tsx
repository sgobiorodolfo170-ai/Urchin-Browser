/**
 * M4 Omnibox · 地址栏组件
 *
 * 依据：契约 J §5 OM6-OM9 决策
 * 职责：
 * 1. 输入解析（URL / 搜索词 / 内部资源）→ 导航
 * 2. 150ms debounce 查询补全建议（OM2 决策）
 * 3. URL 安全校验（OM5 决策）
 * 4. 获得焦点全选（OM7 决策）
 * 5. Escape 恢复原始 URL
 * 6. 加载进度条（OM8 决策）
 * 7. 安全状态指示（OM9 决策）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Globe, AlertTriangle } from 'lucide-react';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import { parseInput } from './parse-input';
import { validateUrlBeforeNavigation } from './validate-url';
import type { Suggestion } from './types';

export interface OmniboxProps {
  /** 当前 URL。 */
  readonly currentUrl: string;
  /** 是否正在加载。 */
  readonly loading: boolean;
  /** 页面安全状态。 */
  readonly securityState: 'secure' | 'insecure' | 'mixed';
  /** 补全建议列表。 */
  readonly suggestions: readonly Suggestion[];
  /** 导航回调。 */
  readonly onNavigate: (url: string) => void;
  /** 补全查询回调（150ms debounce 后触发）。 */
  readonly onSuggestionQuery: (query: string) => void;
}

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

export function Omnibox({
  currentUrl,
  loading,
  securityState,
  suggestions,
  onNavigate,
  onSuggestionQuery,
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

  // 回车导航（OM6 决策）
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

  return (
    <div className="relative flex-1">
      <Input
        ref={inputRef}
        value={input}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        prefix={<SecurityIcon state={securityState} />}
        suffix={
          loading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : null
        }
        className="h-9"
        aria-label="地址栏"
      />

      {/* 加载进度条（OM8 决策） */}
      {loading && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-md">
          <div className="h-full w-1/3 animate-pulse bg-primary" />
        </div>
      )}

      {/* 补全建议面板 */}
      {isFocused && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-surface shadow-dropdown">
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
