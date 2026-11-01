/**
 * 剪藏模板/属性/文件名纯函数测试。
 */
import { describe, it, expect } from 'vitest';
import {
  buildFrontmatter,
  buildVariables,
  composeMarkdown,
  parsePropertyTemplate,
  renderNoteName,
  renderTemplate,
} from '../../../src/renderer/clipper/draft';

describe('clipper draft', () => {
  it('should replace known variables and keep unknown placeholders', () => {
    expect(renderTemplate('{{title}} / {{missing}}', { title: '标题' })).toBe('标题 / {{missing}}');
  });

  it('should collapse whitespace in note name', () => {
    expect(renderNoteName('  {{title}}\n{{site}} ', { title: 'A', site: 'B' })).toBe('A B');
  });

  it('should parse property template lines with colon in values', () => {
    const rows = parsePropertyTemplate('# comment\n\nsource: {{url}}\ntags: clippings', {
      url: 'https://example.com/a:b',
    });
    expect(rows).toEqual([
      { key: 'source', value: 'https://example.com/a:b' },
      { key: 'tags', value: 'clippings' },
    ]);
  });

  it('should build YAML frontmatter and escape quotes', () => {
    const yaml = buildFrontmatter([
      { key: 'title', value: 'A "quoted" title' },
      { key: 'weird key', value: 'x' },
    ]);
    expect(yaml).toContain('---');
    expect(yaml).toContain('title: "A \\"quoted\\" title"');
    expect(yaml).toContain('"weird key": "x"');
  });

  it('should compose markdown with and without frontmatter', () => {
    expect(composeMarkdown([], 'body\n\n')).toBe('body\n');
    expect(composeMarkdown([{ key: 'a', value: 'b' }], 'body')).toBe('---\na: "b"\n---\nbody\n');
  });

  it('should build standard variables with date and content', () => {
    const vars = buildVariables({
      title: 'T',
      url: 'https://x.test',
      content: 'C',
      selection: 'S',
      now: new Date(2026, 10, 1, 9, 8, 7),
      words: 12,
    });
    expect(vars.title).toBe('T');
    expect(vars.url).toBe('https://x.test');
    expect(vars.content).toBe('C');
    expect(vars.selection).toBe('S');
    expect(vars.date).toBe('2026-11-01');
    expect(vars.datetime).toBe('2026-11-01T09:08:07');
    expect(vars.words).toBe('12');
  });
});
