/**
 * M15 DevTools · 求值视图
 *
 * 表达式输入 + Runtime.evaluate 结果/异常展示。
 */
import { useState } from 'react';
import type { EvaluateResult } from './use-devtools';

export interface EvaluateBoxProps {
  evaluate: (expression: string, awaitPromise?: boolean) => Promise<EvaluateResult>;
  attached: boolean;
}

export function EvaluateBox(props: EvaluateBoxProps): React.ReactElement {
  const { evaluate, attached } = props;
  const [expression, setExpression] = useState('');
  const [awaitPromise, setAwaitPromise] = useState(false);
  const [result, setResult] = useState<EvaluateResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (): Promise<void> => {
    if (!expression.trim()) return;
    setLoading(true);
    try {
      const r = await evaluate(expression, awaitPromise);
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-text"
          placeholder="表达式（如 1+1, document.title）"
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void run();
            }
          }}
          disabled={!attached}
        />
        <label className="flex items-center gap-1 text-text-secondary">
          <input
            type="checkbox"
            checked={awaitPromise}
            onChange={(e) => setAwaitPromise(e.target.checked)}
          />
          await
        </label>
        <button
          className="rounded bg-primary px-2 py-1 text-white disabled:opacity-40"
          onClick={() => void run()}
          disabled={!attached || loading}
        >
          {loading ? '...' : '执行'}
        </button>
      </div>
      {result && (
        <div className="flex-1 overflow-auto rounded border border-border bg-surface-secondary/50 p-2 font-mono">
          {result.ok ? (
            <div>
              <span className="text-emerald-500">→ </span>
              <span className="text-text">
                {typeof result.result === 'string'
                  ? result.result
                  : JSON.stringify(result.result, null, 2)}
              </span>
              {result.truncated && <span className="text-amber-500">（已截断）</span>}
            </div>
          ) : (
            <div className="text-error">
              <span>✗ </span>
              {result.exception ?? result.error ?? '未知错误'}
            </div>
          )}
        </div>
      )}
      {!attached && <div className="text-text-secondary">需先「开始检视」方可执行表达式</div>}
    </div>
  );
}
