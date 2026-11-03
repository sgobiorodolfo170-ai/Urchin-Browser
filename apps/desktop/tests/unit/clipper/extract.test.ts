/**
 * 正文抽取：Defuddle 元数据映射、选中优先、失败回退。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('defuddle/full', () => ({
  default: class MockDefuddle {
    parse() {
      return {
        title: 'Defuddle Title',
        author: 'Author',
        content: '<p>page content</p>',
        wordCount: 3,
        language: 'zh',
      };
    }
  },
  createMarkdownContent: (html: string) => `MD(${html})`,
}));

import { extractClipperContent } from '../../../src/renderer/clipper/extract';

const snapshot = {
  html: '<html><head><title>T</title></head><body><article><p>page</p></article></body></html>',
  url: 'https://example.com/a',
  title: 'Page Title',
  selectionHtml: '<p>selected</p>',
  selectionText: 'selected',
  favicon: 'https://example.com/favicon.ico',
};

describe('clipper extract', () => {
  it('should extract page markdown and use selection when priority enabled', () => {
    const result = extractClipperContent(snapshot, true);
    expect(result.title).toBe('Defuddle Title');
    expect(result.pageMarkdown).toBe('MD(<p>page content</p>)');
    expect(result.selectionMarkdown).toBe('MD(<p>selected</p>)');
    expect(result.contentMarkdown).toBe('MD(<p>selected</p>)');
    expect(result.usedSelection).toBe(true);
  });

  it('should use page content when selection priority disabled', () => {
    const result = extractClipperContent(snapshot, false);
    expect(result.contentMarkdown).toBe('MD(<p>page content</p>)');
    expect(result.usedSelection).toBe(false);
  });

  it('should sanitize selection html before converting to markdown', () => {
    const dirty = {
      ...snapshot,
      selectionHtml: '<p>sel</p><script>alert(1)</script><style>.x{}</style>',
      selectionText: 'sel',
    };
    const result = extractClipperContent(dirty, true);
    expect(result.selectionMarkdown).toBe('MD(<p>sel</p>)');
    expect(result.selectionMarkdown).not.toContain('script');
    expect(result.selectionMarkdown).not.toContain('style');
  });
});
