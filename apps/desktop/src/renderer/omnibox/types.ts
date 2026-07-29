/**
 * M4 Omnibox · 补全建议类型（OM2-OM4 决策）
 *
 * 依据：契约 J §3
 * 补全建议条目结构，用于历史 + 书签混合补全。
 */

/** 建议条目类型。 */
export type SuggestionType = 'history' | 'bookmark' | 'search-engine';

/** 匹配启发类型。 */
export type MatchType = 'url' | 'title' | 'exact';

/** 补全建议条目。 */
export interface Suggestion {
  readonly type: SuggestionType;
  readonly title: string;
  readonly url: string;
  readonly favicon?: string;
  readonly matchType: MatchType;
  readonly score: number;
}
