/**
 * M15 DevTools · 网络视图
 *
 * 列表展示 NetworkEntry；点击展开详情。content-visibility: auto 降低屏外渲染。
 */
import { useState } from 'react';
import type { NetworkEntry } from '@urchin/ipc-contract';

export interface NetworkViewProps {
  entries: NetworkEntry[];
  dropped: number;
  attached: boolean;
}

function statusColor(status?: number): string {
  if (status === undefined) return 'text-text-secondary';
  if (status >= 500) return 'text-error';
  if (status >= 400) return 'text-amber-500';
  if (status >= 200 && status < 400) return 'text-emerald-500';
  return 'text-text-secondary';
}

export function NetworkView(props: NetworkViewProps): React.ReactElement {
  const { entries, dropped, attached } = props;
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!attached && entries.length === 0) {
    return <div className="p-3 text-xs text-text-secondary">开始检视后显示网络请求</div>;
  }
  if (entries.length === 0) {
    return <div className="p-3 text-xs text-text-secondary">暂无请求</div>;
  }

  return (
    <div className="h-full overflow-y-auto text-xs">
      {dropped > 0 && (
        <div className="sticky top-0 bg-amber-500/10 px-2 py-1 text-amber-600">
          已丢弃 {dropped} 条最旧请求
        </div>
      )}
      {entries.map((e) => (
        <div key={e.requestId} className="border-b border-border/50">
          <button
            className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-surface-secondary"
            onClick={() => setExpanded(expanded === e.requestId ? null : e.requestId)}
          >
            <span className={`w-10 shrink-0 ${statusColor(e.status)}`}>{e.status ?? '...'}</span>
            <span className="w-10 shrink-0 text-text-secondary">{e.method}</span>
            <span className="flex-1 truncate text-text" title={e.url}>
              {e.url}
            </span>
            {e.size !== undefined && (
              <span className="shrink-0 text-text-secondary">{formatBytes(e.size)}</span>
            )}
            {e.durationMs !== undefined && (
              <span className="shrink-0 text-text-secondary">{e.durationMs}ms</span>
            )}
            {e.errorText && <span className="shrink-0 text-error">!</span>}
          </button>
          {expanded === e.requestId && (
            <div className="bg-surface-secondary/50 px-3 py-1.5 text-[11px] text-text-secondary">
              <div>类型：{e.resourceType ?? '-'}</div>
              <div>MIME：{e.mimeType ?? '-'}</div>
              <div>开始：{e.startedAt}</div>
              {e.errorText && <div className="text-error">错误：{e.errorText}</div>}
              {e.responseHeaders && (
                <details className="mt-1">
                  <summary className="cursor-pointer">
                    响应头{e.headersTruncated ? '（已截断）' : ''}
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">
                    {Object.entries(e.responseHeaders)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
