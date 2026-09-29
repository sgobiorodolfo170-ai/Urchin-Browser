/**
 * M25 邮件翻译编排 · 单元测试
 *
 * 验证：
 * 1. containsCjk / resolveMailTargetLang：中英启发式判定
 * 2. splitHtmlSegments：文本段提取（style 跳过、空段过滤）、rebuild 保真
 * 3. batchSegments：≤4000 字符拼批、单段超限截断
 * 4. translateMailBody：HTML 路径（分段翻译回填）、纯文本路径、空内容边界
 */
import { describe, it, expect, vi } from 'vitest';
import {
  containsCjk,
  resolveMailTargetLang,
  splitHtmlSegments,
  batchSegments,
  translateMailBody,
  type TranslateTextsFn,
} from '../../src/main/mail/mail-translate';

function mockTranslateTexts(mapFn: (text: string) => string): TranslateTextsFn {
  // eslint-disable-next-line @typescript-eslint/require-await -- async signature required by TranslateTextsFn, mock resolves synchronously
  return vi.fn(async (texts: readonly string[]) => ({
    texts: texts.map(mapFn),
    detectedLang: 'en',
    engine: 'microsoft' as const,
  }));
}

describe('containsCjk / resolveMailTargetLang', () => {
  it('should detect CJK characters', () => {
    expect(containsCjk('你好世界')).toBe(true);
    expect(containsCjk('hello 你好')).toBe(true);
    expect(containsCjk('繁體中文')).toBe(true);
    expect(containsCjk('hello world')).toBe(false);
    expect(containsCjk('')).toBe(false);
    expect(containsCjk('12345 !@#')).toBe(false);
  });

  it('should resolve target lang: CJK → en, else zh-CN', () => {
    expect(resolveMailTargetLang('这是一封中文邮件')).toBe('en');
    expect(resolveMailTargetLang('This is an English email')).toBe('zh-CN');
  });
});

describe('splitHtmlSegments', () => {
  it('should extract text nodes and keep tags', () => {
    const { segments, rebuild } = splitHtmlSegments('<p>Hello</p><p>World</p>');
    expect(segments).toEqual(['Hello', 'World']);
    expect(rebuild(['你好', '世界'])).toBe('<p>你好</p><p>世界</p>');
  });

  it('should skip style blocks', () => {
    const { segments } = splitHtmlSegments('<style>.a{color:red}</style><p>Hello</p>');
    expect(segments).toEqual(['Hello']);
  });

  it('should skip empty and entity-only segments', () => {
    const { segments } = splitHtmlSegments(
      '<p>Hello</p><div>&nbsp;</div><span>  </span><b>World</b>',
    );
    expect(segments).toEqual(['Hello', 'World']);
  });

  it('should handle nested tables', () => {
    const html =
      '<table><tr><td>Cell1</td><td><table><tr><td>Cell2</td></tr></table></td></tr></table>';
    const { segments, rebuild } = splitHtmlSegments(html);
    expect(segments).toEqual(['Cell1', 'Cell2']);
    const out = rebuild(['单元1', '单元2']);
    expect(out).toContain('单元1');
    expect(out).toContain('单元2');
    expect(out).toContain('<table>');
  });

  it('should preserve attributes in tags', () => {
    const html = '<a href="https://example.com" title="Link">Click here</a>';
    const { segments, rebuild } = splitHtmlSegments(html);
    expect(segments).toEqual(['Click here']);
    expect(rebuild(['点击这里'])).toBe('<a href="https://example.com" title="Link">点击这里</a>');
  });

  it('rebuild with fewer translations should keep remaining originals', () => {
    const { rebuild } = splitHtmlSegments('<p>A</p><p>B</p>');
    expect(rebuild(['甲'])).toBe('<p>甲</p><p>B</p>');
  });
});

describe('batchSegments', () => {
  it('should pack segments within char limit', () => {
    const segs = ['a'.repeat(2000), 'b'.repeat(2000), 'c'.repeat(2000)];
    const batches = batchSegments(segs);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
  });

  it('should truncate single oversized segment', () => {
    const segs = ['x'.repeat(5000)];
    const batches = batchSegments(segs);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]).toHaveLength(4000);
  });

  it('should handle empty input', () => {
    expect(batchSegments([])).toEqual([]);
  });
});

describe('translateMailBody', () => {
  it('should translate HTML segments and rebuild', async () => {
    const result = await translateMailBody(
      { html: '<p>Hello</p><p>World</p>' },
      mockTranslateTexts((t) => `[${t}]`),
    );
    expect(result.html).toBe('<p>[Hello]</p><p>[World]</p>');
    expect(result.targetLang).toBe('zh-CN');
    expect(result.engine).toBe('microsoft');
    expect(result.detectedLang).toBe('en');
  });

  it('should translate plain text body', async () => {
    const result = await translateMailBody(
      { text: 'Hello world' },
      mockTranslateTexts((t) => `译文:${t}`),
    );
    expect(result.text).toBe('译文:Hello world');
    expect(result.targetLang).toBe('zh-CN');
  });

  it('should target en for Chinese content', async () => {
    const fn = mockTranslateTexts((t) => `EN:${t}`);
    const result = await translateMailBody({ text: '你好' }, fn);
    expect(result.targetLang).toBe('en');
    expect(fn).toHaveBeenCalledWith(['你好'], 'en');
  });

  it('should respect targetLang override', async () => {
    const fn = mockTranslateTexts((t) => t);
    await translateMailBody({ text: '你好' }, fn, 'zh-CN');
    expect(fn).toHaveBeenCalledWith(['你好'], 'zh-CN');
  });

  it('should return original HTML when no translatable segments', async () => {
    const html = '<img src="x.png">';
    const result = await translateMailBody(
      { html },
      mockTranslateTexts((t) => t),
    );
    expect(result.html).toBe(html);
  });

  it('should split large bodies into multiple batches', async () => {
    const fn = mockTranslateTexts((t) => t);
    const bigSeg = 'a'.repeat(3000);
    const html = `<p>${bigSeg}</p><p>${bigSeg}</p><p>${bigSeg}</p>`;
    await translateMailBody({ html }, fn);
    // 3 × 3000 字符段 → 4000 上限 → 3 批
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
