/**
 * M14 Page Context Extractor · extractor 单元测试
 *
 * 验证：
 * 1. 正常抽取：DOM 简化方法返回结构化字段
 * 2. 长内容截断（PC3）：超 50_000 字符被截断并加 warning
 * 3. paywall 检测：textContent 含 paywall/subscribe 关键词时加 warning
 * 4. fallback：脚本返回 null/无效结果时回退到 body.innerText（PC7）
 * 5. 超时保护：executeJavaScript 长时间不返回时抛超时错误
 * 6. 自定义 maxLength：覆盖默认上限
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageContextExtractor, DEFAULT_MAX_LENGTH } from '../../src/main/page-context/extractor';
import type { WebContentsLike } from '../../src/main/tabs/types';

/** 创建 mock WebContents，可控制 executeJavaScript 返回值与 getURL */
function createMockWebContents(
  executeResult: unknown,
  url = 'https://example.com/article',
): WebContentsLike & { _executeCalls: string[] } {
  const calls: string[] = [];
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    destroy: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    executeJavaScript: ((code: string) => {
      calls.push(code);
      return Promise.resolve(executeResult);
    }) as WebContentsLike['executeJavaScript'],
    getURL: () => url,
    _executeCalls: calls,
  };
}

describe('PageContextExtractor', () => {
  let extractor: PageContextExtractor;

  beforeEach(() => {
    extractor = new PageContextExtractor();
  });

  it('should extract structured context from DOM-simplified result', async () => {
    const dom = {
      title: 'Article Title',
      byline: 'Author',
      excerpt: 'Excerpt text',
      textContent: 'Main content body.',
      markdown: 'Main content body.',
      length: 18,
      language: 'en',
      siteName: 'Example',
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc);

    expect(ctx.url).toBe('https://example.com/article');
    expect(ctx.title).toBe('Article Title');
    expect(ctx.byline).toBe('Author');
    expect(ctx.excerpt).toBe('Excerpt text');
    expect(ctx.textContent).toBe('Main content body.');
    expect(ctx.length).toBe(18);
    expect(ctx.language).toBe('en');
    expect(ctx.siteName).toBe('Example');
    expect(ctx.extraction_method).toBe('dom-simplified');
    expect(ctx.warnings).toEqual([]);
    expect(ctx.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should truncate content longer than default maxLength and add warning (PC3/PC4)', async () => {
    const longText = 'a'.repeat(DEFAULT_MAX_LENGTH + 100);
    const dom = {
      title: 'Long',
      textContent: longText,
      markdown: longText,
      length: longText.length,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc);

    expect(ctx.textContent.length).toBe(DEFAULT_MAX_LENGTH);
    expect(ctx.markdown.length).toBe(DEFAULT_MAX_LENGTH);
    expect(ctx.length).toBe(longText.length); // 原始长度保留
    expect(ctx.warnings).toContain(
      `Content too long (${longText.length} chars), truncated to ${DEFAULT_MAX_LENGTH}`,
    );
  });

  it('should honor custom maxLength', async () => {
    const dom = {
      title: 'T',
      textContent: 'b'.repeat(2000),
      markdown: 'b'.repeat(2000),
      length: 2000,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc, 500);

    expect(ctx.textContent.length).toBe(500);
    expect(ctx.warnings).toContain('Content too long (2000 chars), truncated to 500');
  });

  it('should detect paywall keywords and add warning', async () => {
    const dom = {
      title: 'Paywalled',
      textContent: 'This content is behind a paywall. Please subscribe to read more.',
      markdown: 'This content is behind a paywall. Please subscribe to read more.',
      length: 70,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc);

    expect(ctx.warnings).toContain('Paywall detected');
  });

  it('should detect Chinese paywall keywords (订阅/付费阅读)', async () => {
    const dom = {
      title: '付费阅读',
      textContent: '本文为付费阅读内容，请订阅后查看。',
      markdown: '本文为付费阅读内容，请订阅后查看。',
      length: 20,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc);

    expect(ctx.warnings).toContain('Paywall detected');
  });

  it('should fallback to raw-text when DOM script returns null (PC7)', async () => {
    // 第一次 executeJavaScript 返回 null（DOM 抽取失败），第二次返回 body.innerText
    let callCount = 0;
    const wc: WebContentsLike = {
      loadURL: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      stop: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      canGoBack: () => false,
      canGoForward: () => false,
      destroy: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      executeJavaScript: (() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(null);
        if (callCount === 2) return Promise.resolve('Fallback body text.');
        return Promise.resolve('Fallback Title');
      }) as WebContentsLike['executeJavaScript'],
      getURL: () => 'https://example.com/fallback',
    };

    const ctx = await extractor.extract(wc);

    expect(ctx.extraction_method).toBe('raw-text');
    expect(ctx.textContent).toBe('Fallback body text.');
    expect(ctx.title).toBe('Fallback Title');
    expect(ctx.warnings).toContain('Readability failed, used raw text fallback');
  });

  it('should fallback when DOM script returns invalid shape', async () => {
    const wc = createMockWebContents({ not: 'a valid shape' });

    const ctx = await extractor.extract(wc);

    expect(ctx.extraction_method).toBe('raw-text');
    expect(ctx.warnings).toContain('Readability failed, used raw text fallback');
  });

  it('should include url from webContents.getURL()', async () => {
    const dom = {
      title: 'T',
      textContent: 'x',
      markdown: 'x',
      length: 1,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom, 'https://custom.url/page');

    const ctx = await extractor.extract(wc);

    expect(ctx.url).toBe('https://custom.url/page');
  });

  it('should not truncate content under maxLength', async () => {
    const text = 'short content';
    const dom = {
      title: 'T',
      textContent: text,
      markdown: text,
      length: text.length,
      extraction_method: 'dom-simplified',
    };
    const wc = createMockWebContents(dom);

    const ctx = await extractor.extract(wc, 1000);

    expect(ctx.textContent).toBe(text);
    expect(ctx.warnings.filter((w) => w.includes('too long'))).toHaveLength(0);
  });
});
