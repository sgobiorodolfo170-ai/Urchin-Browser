/**
 * 历史 tab（P2 Session 4：自 bookmark-panel.ts 内联脚本迁移）
 *
 * 按访问日期分组「今天 / 昨天 / M月d日」（本地时区），组头可折叠；
 * 首次渲染默认最近一组展开、其余折叠（原 historyGroupsSeen 语义）；
 * 展开状态为面板级 ref：跨 tab 切换保留用户选择（原 historyExpanded 模块变量）。
 * 每次切入本 tab 重新拉取 history.list（limit 100，原 renderHistory 语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, HistoryListRes } from '@urchin/ipc-contract';
import { invoke, openUrlInActiveTab } from './panel-ipc';
import { FaviconSlot } from './common';

const ICON_HISTORY = '🕐';

interface HistoryGroup {
  /** 分组键：本地日期 y-M-d（与标签解耦，跨月/跨年不冲突） */
  key: string;
  label: string;
  items: HistoryEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 历史日期标签：今天 / 昨天 / 其余「M月d日」（原 historyDateLabel） */
function historyDateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) return '今天';
  if (ts >= todayStart - DAY_MS) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 分组键：本地日期 y-M-d（原 historyDateKey） */
function historyDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function HistoryTab({ active }: { active: boolean }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 分组展开状态：dateKey → bool（面板生命周期内记忆用户选择） */
  const expandedRef = useRef<Record<string, boolean>>({});
  /** 首次渲染标记：默认最近一组展开、其余折叠；之后沿用用户展开选择 */
  const groupsSeenRef = useRef(false);
  /** 折叠切换的重渲染触发器（展开状态在 ref 中，不进 state 以免跨 tab 丢失语义） */
  const [, bumpVersion] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await invoke<HistoryListRes>('history.list', { limit: 100, offset: 0 });
      setError(null);
      setEntries(res.entries ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  // 按日期分桶（history.list 已按 visitedAt 降序，首个键即最近一组）。
  // 首次分桶时写入默认展开选择（原 renderHistory 的 historyGroupsSeen 分支）。
  const groups = useMemo<HistoryGroup[]>(() => {
    const items = entries ?? [];
    const result: HistoryGroup[] = [];
    const index: Record<string, HistoryGroup> = {};
    for (const h of items) {
      const key = historyDateKey(h.visitedAt);
      let g = index[key];
      if (!g) {
        g = { key, label: historyDateLabel(h.visitedAt), items: [] };
        index[key] = g;
        result.push(g);
      }
      g.items.push(h);
    }
    if (!groupsSeenRef.current && items.length > 0) {
      result.forEach((g, i) => {
        expandedRef.current[g.key] = i === 0;
      });
      groupsSeenRef.current = true;
    }
    return result;
  }, [entries]);

  if (error) {
    return <div className="empty">加载失败：{error}</div>;
  }
  if (!entries) {
    return <div className="empty">加载中…</div>;
  }
  if (entries.length === 0) {
    return <div className="empty">暂无历史记录</div>;
  }

  return (
    <>
      {groups.map((g) => {
        const expanded = !!expandedRef.current[g.key];
        return (
          <div className="date-group" data-key={g.key} key={g.key}>
            <div
              className="group-header"
              onClick={() => {
                // 组头点击：折叠/展开（React 重渲染整列表，无 IPC；原实现局部重绘）
                expandedRef.current[g.key] = !expandedRef.current[g.key];
                bumpVersion((v) => v + 1);
              }}
            >
              <span className="chevron">{expanded ? '▾' : '▸'}</span>
              {ICON_HISTORY} <span className="group-label">{g.label}</span>
              <span className="group-count">{g.items.length}</span>
            </div>
            {expanded && (
              <div className="group-body">
                {g.items.map((h) => (
                  <div
                    className="item hist-item"
                    data-url={h.url}
                    key={h.id}
                    onClick={() => {
                      void openUrlInActiveTab(h.url);
                    }}
                  >
                    <FaviconSlot src={h.favicon} fallback={ICON_HISTORY} />
                    <div className="main">
                      <div className="title">{h.title || h.url}</div>
                      <div className="url">{h.url}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
