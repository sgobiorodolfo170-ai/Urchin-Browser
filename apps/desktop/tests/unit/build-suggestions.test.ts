/**
 * M4 Omnibox · buildSuggestions 纯函数测试
 *
 * 覆盖：历史 + 书签混合合并、url 去重、评分排序、matchType 判定、上限截断、空输入。
 */
import { describe, it, expect } from 'vitest';
import { buildSuggestions, scoreEntry } from '../../src/renderer/omnibox/build-suggestions';
import type { SuggestionSource } from '../../src/renderer/omnibox/build-suggestions';

describe('buildSuggestions', () => {
  it('should return empty array for empty or whitespace query', () => {
    expect(buildSuggestions('', [], [])).toEqual([]);
    expect(buildSuggestions('   ', [{ url: 'https://a.com', title: 'A' }], [])).toEqual([]);
  });

  it('should return empty array when no sources match', () => {
    expect(buildSuggestions('xyz', [], [])).toEqual([]);
  });

  it('should build history suggestion with url matchType and visitCount score', () => {
    const history: SuggestionSource[] = [
      { url: 'https://github.com', title: 'GitHub', visitCount: 3 },
    ];
    const result = buildSuggestions('github', history, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'history',
      title: 'GitHub',
      url: 'https://github.com',
      matchType: 'url',
    });
    // url 命中 60 + title 前缀 +10 + 热度 3 = 73
    expect(result[0]!.score).toBe(73);
  });

  it('should mark exact url match as exact type', () => {
    const result = buildSuggestions(
      'https://github.com',
      [{ url: 'https://github.com', title: 'GH' }],
      [],
    );
    expect(result[0]!.matchType).toBe('exact');
  });

  it('should keep the higher-score entry when the same url appears in both sources', () => {
    const history: SuggestionSource[] = [
      { url: 'https://example.com', title: 'Example', visitCount: 9 },
    ];
    const bookmarks: SuggestionSource[] = [
      { url: 'https://example.com', title: 'Example Bookmark' },
    ];
    const result = buildSuggestions('example', history, bookmarks);
    expect(result).toHaveLength(1);
    // 历史：url 命中 60 + title 前缀 10 + 热度 9 = 79；书签：60 + 10 + 5 = 75 → 保留高分（历史）
    expect(result[0]!.type).toBe('history');
  });

  it('should prefer bookmark over history when scores tie', () => {
    const history: SuggestionSource[] = [
      { url: 'https://example.com', title: 'Zzz', visitCount: 5 },
    ];
    const bookmarks: SuggestionSource[] = [{ url: 'https://example.com', title: 'Zzz' }];
    const result = buildSuggestions('example', history, bookmarks);
    expect(result).toHaveLength(1);
    // 两者同为 65 分 → 同分规则书签在前
    expect(result[0]!.type).toBe('bookmark');
  });

  it('should sort by score descending', () => {
    const result = buildSuggestions(
      'dev',
      [
        { url: 'https://developer.mozilla.org', title: 'MDN', visitCount: 1 },
        { url: 'https://dev.to', title: 'Dev Community', visitCount: 5 },
      ],
      [],
    );
    // dev.to: url 命中 60 + 前缀 10 + 热度 5 = 75
    // MDN: title 命中 40 + 前缀(title) 10 + 热度 1 = 51
    expect(result.map((s) => s.url)).toEqual(['https://dev.to', 'https://developer.mozilla.org']);
  });

  it('should cap at 8 suggestions', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      url: `https://site${i}.com`,
      title: `Site ${i}`,
    }));
    const result = buildSuggestions('site', history, []);
    expect(result).toHaveLength(8);
  });

  it('should not include empty-URL bookmarks', () => {
    const bookmarks: SuggestionSource[] = [{ url: '', title: 'Folder-ish' }];
    expect(buildSuggestions('folder', [], bookmarks)).toEqual([]);
  });

  it('should fall back to url as title when title empty', () => {
    const result = buildSuggestions('abc', [{ url: 'https://abc.com', title: '' }], []);
    expect(result[0]!.title).toBe('https://abc.com');
  });
});

describe('scoreEntry', () => {
  it('should give exact url match the highest base score', () => {
    // url 精确 100 + url 前缀 10 = 110
    expect(scoreEntry('git', { url: 'git', title: '' }, 'history')).toBe(110);
  });

  it('should give url substring match more than title-only match', () => {
    const urlHit = scoreEntry('git', { url: 'https://github.com', title: 'x' }, 'history');
    const titleHit = scoreEntry(
      'git',
      { url: 'https://other.com', title: 'GitHub stuff' },
      'history',
    );
    expect(urlHit).toBeGreaterThan(titleHit);
  });

  it('should add bookmark bonus', () => {
    const bm = scoreEntry('git', { url: 'https://github.com', title: '' }, 'bookmark');
    const hist = scoreEntry('git', { url: 'https://github.com', title: '' }, 'history');
    expect(bm).toBeGreaterThan(hist);
  });
});
