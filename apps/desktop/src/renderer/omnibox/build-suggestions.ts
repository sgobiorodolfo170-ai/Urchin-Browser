/**
 * M4 Omnibox · 补全建议构建（纯函数）
 *
 * 依据：契约 J §3 OM2-OM4 决策
 * 职责：将历史记录 + 书签两组搜索结果合并为去重、评分、排序的补全建议。
 *
 * 设计理由（前后端配合）：
 * - 主进程 history.search / bookmark.search 已返回各自匹配结果（各自排序），
 *   本函数在渲染层做跨来源合并，避免把评分逻辑下沉到主进程（保持 handler 薄）。
 * - 纯函数便于单测（对齐 parse-input / validate-url 的测试模式），不依赖 window.urchin。
 */
import type { MatchType, Suggestion } from './types';

/** 建议来源条目（history.search / bookmark.search 返回项的公共子集） */
export interface SuggestionSource {
  readonly url: string;
  readonly title: string;
  /** 历史热度（visitCount）；书签来源无此字段 */
  readonly visitCount?: number;
}

/**
 * 计算单条目的评分。
 *
 * 评分公式（确定性、可解释）：
 * - URL 精确等于 query → +100；URL 子串命中 → +60；仅 title 命中 → +40
 * - URL / title 以 query 开头 → 各 +10（前缀命中更相关）
 * - 书签来源 → +5（用户主动收藏的条目优先于历史记录）
 * - 历史来源 → +min(visitCount, 10)（热度加成，上限 10 防高频站压倒一切）
 */
export function scoreEntry(
  query: string,
  entry: SuggestionSource,
  kind: 'history' | 'bookmark',
): number {
  const q = query.toLowerCase();
  const url = entry.url.toLowerCase();
  const title = entry.title.toLowerCase();

  let score = 0;
  if (url === q) {
    score += 100;
  } else if (url.includes(q)) {
    score += 60;
  } else if (title.includes(q)) {
    score += 40;
  }

  if (url.startsWith(q)) score += 10;
  if (title.startsWith(q)) score += 10;

  if (kind === 'bookmark') {
    score += 5;
  } else {
    score += Math.min(entry.visitCount ?? 0, 10);
  }

  return score;
}

/** 判定匹配启发类型（契约 J matchType；仅基于 url，title 命中归为 title 型） */
function matchTypeOf(query: string, url: string): MatchType {
  const q = query.toLowerCase();
  const u = url.toLowerCase();
  if (u === q) return 'exact';
  if (u.includes(q)) return 'url';
  return 'title';
}

/**
 * 将历史 + 书签搜索结果合并为补全建议列表。
 *
 * - 并行来源按 url 去重：同一 url 同时命中历史与书签时保留书签（用户主动收藏优先）
 * - 按 score 降序；同分时书签在前、再按 url 字典序（保证输出确定性）
 * - 建议上限 8 条（v0.1 紧凑面板）
 *
 * @param query 用户输入（已 trim）
 * @param history 历史搜索结果（HistoryEntry 子集）
 * @param bookmarks 书签搜索结果（Bookmark 子集）
 */
export function buildSuggestions(
  query: string,
  history: readonly SuggestionSource[],
  bookmarks: readonly SuggestionSource[],
): Suggestion[] {
  if (!query.trim()) return [];

  // 合并 + 按 url 去重（保留评分高的）
  const byUrl = new Map<string, Suggestion>();

  const add = (entry: SuggestionSource, type: 'history' | 'bookmark'): void => {
    const url = entry.url;
    if (!url) return;
    const title = entry.title || url;
    const score = scoreEntry(query, entry, type);
    const existing = byUrl.get(url);
    // 去重保留：高分优先；同分时书签优先（用户主动收藏的条目更相关）
    if (
      existing &&
      (existing.score > score || (existing.score === score && existing.type === 'bookmark'))
    ) {
      return;
    }
    byUrl.set(url, {
      type,
      title,
      url,
      matchType: matchTypeOf(query, url),
      score,
    });
  };

  for (const h of history) add(h, 'history');
  for (const b of bookmarks) add(b, 'bookmark');

  return Array.from(byUrl.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.type !== b.type) return a.type === 'bookmark' ? -1 : 1;
      return a.url.localeCompare(b.url);
    })
    .slice(0, 8);
}
