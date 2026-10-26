/**
 * chromium-profiles · Bookmarks JSON 解析器单测（纯函数部分）
 */
import { describe, it, expect } from 'vitest';
import { parseChromiumBookmarksJson } from '../../src/main/import/chromium-profiles';

describe('parseChromiumBookmarksJson', () => {
  it('should merge bookmark_bar / other / synced roots', () => {
    const tree = parseChromiumBookmarksJson({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: '书签栏',
          children: [
            { type: 'url', name: 'A', url: 'https://a.example.com/' },
            {
              type: 'folder',
              name: '子',
              children: [{ type: 'url', name: 'B', url: 'https://b.example.com/' }],
            },
          ],
        },
        other: {
          type: 'folder',
          name: '其他',
          children: [{ type: 'url', name: 'C', url: 'https://c.example.com/' }],
        },
        synced: { type: 'folder', name: '同步', children: [] },
      },
    });

    expect(tree.children).toHaveLength(3);
    expect(tree.children![0]!.title).toBe('书签栏');
    expect(tree.children![0]!.children).toHaveLength(2);
    expect(tree.children![0]!.children![0]).toMatchObject({
      title: 'A',
      url: 'https://a.example.com/',
    });
    expect(tree.children![0]!.children![1]!.children).toHaveLength(1);
    expect(tree.children![1]!.title).toBe('其他');
    expect(tree.children![2]!.title).toBe('同步');
    expect(tree.children![2]!.children).toHaveLength(0);
  });

  it('should tolerate missing roots', () => {
    const tree = parseChromiumBookmarksJson({ roots: { bookmark_bar: { children: [] } } });
    expect(tree.children).toHaveLength(1);
  });

  it('should use url as title when name empty', () => {
    const tree = parseChromiumBookmarksJson({
      roots: { other: { children: [{ type: 'url', url: 'https://x.example.com/' }] } },
    });
    expect(tree.children![0]!.children![0]).toMatchObject({
      title: 'https://x.example.com/',
      url: 'https://x.example.com/',
    });
  });
});
