/**
 * M15 DevTools · 控制台视图
 *
 * 分级着色展示 ConsoleEntry；来源标记；堆栈可展开。
 */
import { useState } from 'react';
import type { ConsoleEntry } from '@urchin/ipc-contract';

export interface ConsoleViewProps {
  entries: ConsoleEntry[];
  dropped: number;
  attached: boolean;
}

function levelColor(level: string): string {
  switch (level) {
    case 'error':
      return 'text-error';
    case 'warning':
      return 'text-amber-500';
    case 'info':
      return 'text-blue-500';
    case 'debug':
      return 'text-text-secondary';
    default:
      return 'text-text';
  }
}

export function ConsoleView(props: ConsoleViewProps): React.ReactElement {
  const { entries, dropped, attached } = props;
  const [expanded, setExpanded] = useState<number | null>(null);

  if (!attached && entries.length === 0) {
    return <div className="p-3 text-xs text-text-secondary">开始检视后显示控制台输出</div>;
  }
  if (entries.length === 0) {
    return <div className="p-3 text-xs text-text-secondary">暂无输出</div>;
  }

  return (
    <div className="h-full overflow-y-auto text-xs">
      {dropped > 0 && (
        <div className="sticky top-0 bg-amber-500/10 px-2 py-1 text-amber-600">
          已丢弃 {dropped} 条最旧输出
        </div>
      )}
      {entries.map((e) => (
        <div key={e.seq} className="border-b border-border/50 px-2 py-1">
          <button
            className="flex w-full items-start gap-2 text-left"
            onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}
          >
            <span className={`shrink-0 font-mono ${levelColor(e.level)}`}>
              {e.level[0]!.toUpperCase()}
            </span>
            <span className="flex-1 break-words text-text">{e.text}</span>
            <span className="shrink-0 text-text-secondary">{e.source}</span>
          </button>
          {expanded === e.seq && e.stackTrace && e.stackTrace.length > 0 && (
            <div className="ml-6 mt-1 text-[11px] text-text-secondary">
              {e.stackTrace.map((f, i) => (
                <div key={i} className="truncate">
                  {f.functionName ?? '<anon>'} {f.url}:{f.lineNumber ?? '?'}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
