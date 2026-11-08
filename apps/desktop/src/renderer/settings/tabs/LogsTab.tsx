/**
 * 「运行日志」选项卡（2026-11-07 用户指令）
 *
 * 位置：设置 → 运行日志（关于分类下新增的独立选项卡）。
 * 数据来源：主进程 `logs.read` / `logs.info`（契约见 ipc-contract logs.*），
 * 日志文件位于 `<数据目录>/logs/app-YYYY-MM-DD.log`（JSONL），位置跟随数据目录，
 * 不提供单独设置项。
 *
 * 交互：
 * - 级别筛选（全部 / 错误 / 警告 / 信息 / 调试）+ 关键词搜索（module/message/meta）；
 * - 默认每 3 秒自动刷新（可关闭），也可手动刷新；
 * - 只读展示最近 500 条（新 → 旧），meta 折叠在 details 中避免刷屏。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LogEntryDto, LogLevelName, LogsInfoRes, LogsReadRes } from '@urchin/ipc-contract';

/** 级别筛选项（ALL = 不筛选） */
type LevelFilter = 'ALL' | LogLevelName;

const LEVEL_FILTERS: readonly { key: LevelFilter; label: string }[] = [
  { key: 'ALL', label: '全部' },
  { key: 'ERROR', label: '错误' },
  { key: 'WARN', label: '警告' },
  { key: 'INFO', label: '信息' },
  { key: 'DEBUG', label: '调试' },
];

/** 级别配色（仅前景色，避免依赖 CSS 变量的透明度修饰符） */
const LEVEL_TEXT: Record<LogLevelName, string> = {
  ERROR: 'text-error',
  WARN: 'text-warning',
  INFO: 'text-primary',
  DEBUG: 'text-text-secondary',
};

/** 读取条数上限（与主进程 MAX 对齐，取常用值） */
const READ_LIMIT = 500;
/** 自动刷新间隔 */
const AUTO_REFRESH_MS = 3_000;
/** 搜索防抖 */
const QUERY_DEBOUNCE_MS = 300;

/** 时间戳 → 本地可读时间（毫秒精度，便于对照事件顺序） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function LogsTab() {
  const [entries, setEntries] = useState<LogEntryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [info, setInfo] = useState<LogsInfoRes | null>(null);
  const [level, setLevel] = useState<LevelFilter>('ALL');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 搜索防抖：输入频繁时不反复触发 IPC（500 条日志的解析在主进程也很轻，但没必要）
  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await window.urchin.invoke('logs.read', {
        limit: READ_LIMIT,
        ...(level === 'ALL' ? {} : { level }),
        ...(query.trim() ? { query: query.trim() } : {}),
      })) as LogsReadRes;
      setEntries(res.entries);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [level, query]);

  // 首次进入 + 筛选条件变化时立即拉取
  useEffect(() => {
    void load();
  }, [load]);

  // 自动刷新（标签页卸载/关闭开关时清理定时器）
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [auto, load]);

  // 日志保存位置（目录 + 当前文件 + 历史文件数）
  useEffect(() => {
    let alive = true;
    void window.urchin
      .invoke('logs.info', {})
      .then((res) => {
        if (alive) setInfo(res as LogsInfoRes);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const summary = useMemo(() => {
    if (error) return '读取失败';
    if (loading && entries.length === 0) return '读取中…';
    return `共 ${total} 条命中，显示 ${entries.length} 条`;
  }, [error, loading, entries.length, total]);

  return (
    <section>
      <h1 className="mb-1 text-2xl font-semibold">运行日志</h1>
      <p className="mb-6 text-xs text-text-secondary">
        汇总应用运行期全部结构化日志与报错记录；保存位置跟随数据目录，无需单独设置。
      </p>

      {/* 保存位置 */}
      <div className="mb-4 rounded-md border border-border px-4 py-3">
        <div className="mb-1 text-sm font-medium">日志保存位置</div>
        <div className="select-all break-all font-mono text-xs text-text-secondary">
          {info?.dir ?? '（尚未初始化）'}
        </div>
        <div className="mt-1 text-xs text-text-secondary">
          当前文件：{info?.currentFile ?? '—'}
          {info && info.files.length > 0
            ? `（历史文件 ${info.files.length} 个，保留最近 7 天）`
            : ''}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border">
          {LEVEL_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setLevel(item.key)}
              className={
                level === item.key
                  ? 'bg-primary px-3 py-1.5 text-xs text-white'
                  : 'px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-secondary'
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder="搜索模块 / 内容 / 字段"
          className="w-56 rounded-md border border-border bg-surface px-3 py-1.5 text-xs outline-none focus:border-primary"
        />
        <label className="flex items-center gap-1.5 text-xs text-text-secondary">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          自动刷新（3 秒）
        </label>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-secondary"
        >
          刷新
        </button>
        <span className="text-xs text-text-secondary">{summary}</span>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-error px-3 py-2 text-xs text-error">
          读取日志失败：{error}
        </div>
      )}

      {/* 日志列表 */}
      {entries.length === 0 ? (
        <div className="rounded-md border border-border px-4 py-10 text-center text-sm text-text-secondary">
          {loading ? '读取中…' : '暂无匹配日志'}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {entries.map((entry, index) => (
            <li
              key={`${entry.timestamp}-${entry.module}-${index}`}
              className="px-3 py-2 font-mono text-xs"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="shrink-0 text-text-secondary">{formatTime(entry.timestamp)}</span>
                <span className={`shrink-0 font-semibold ${LEVEL_TEXT[entry.level]}`}>
                  {entry.level}
                </span>
                <span className="shrink-0 text-text-secondary">[{entry.module}]</span>
                <span className="break-all text-text">{entry.message}</span>
              </div>
              {entry.meta && Object.keys(entry.meta).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-text-secondary">
                    详情（pid {entry.processId} / {entry.sessionId}）
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-secondary p-2 text-[11px] text-text-secondary">
                    {JSON.stringify(entry.meta, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
