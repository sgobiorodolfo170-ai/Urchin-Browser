/**
 * M14 Page Context Extractor · prompt-builder 单元测试
 *
 * 验证：
 * 1. buildContextXml 拼装 XML 包裹格式（PC5）
 * 2. escapeXml 正确转义 < > & ' "
 * 3. buildContextPrompt 构造 system + user 消息
 * 4. 长内容超过 50_000 字符时被截断（PC3）
 * 5. warnings 非空时输出 <warnings> 节点
 */
import { describe, it, expect } from 'vitest';
import { buildContextXml, buildContextPrompt } from '../../src/main/page-context/prompt-builder';
import type { ExtractedPageContext } from '@urchin/ipc-contract';

/** 构造测试用 ExtractedPageContext */
function makeContext(overrides: Partial<ExtractedPageContext> = {}): ExtractedPageContext {
  return {
    url: 'https://example.com/article',
    title: 'Test Article',
    extractedAt: '2026-07-29T10:00:00.000Z',
    textContent: 'Hello world.',
    markdown: 'Hello world.',
    length: 12,
    extraction_method: 'dom-simplified',
    warnings: [],
    ...overrides,
  };
}

describe('buildContextXml', () => {
  it('should produce XML with required fields', () => {
    const ctx = makeContext();
    const xml = buildContextXml(ctx);

    expect(xml).toContain('<page_context>');
    expect(xml).toContain('</page_context>');
    expect(xml).toContain('<url>https://example.com/article</url>');
    expect(xml).toContain('<title>Test Article</title>');
    expect(xml).toContain('<extracted_at>2026-07-29T10:00:00.000Z</extracted_at>');
    expect(xml).toContain('<content>');
    expect(xml).toContain('Hello world.');
  });

  it('should include optional fields when present', () => {
    const ctx = makeContext({
      siteName: 'Example Site',
      byline: 'Author Name',
      excerpt: 'An excerpt.',
      language: 'en',
    });
    const xml = buildContextXml(ctx);

    expect(xml).toContain('<site_name>Example Site</site_name>');
    expect(xml).toContain('<byline>Author Name</byline>');
    expect(xml).toContain('<excerpt>An excerpt.</excerpt>');
    expect(xml).toContain('<language>en</language>');
  });

  it('should omit optional fields when absent', () => {
    const ctx = makeContext();
    const xml = buildContextXml(ctx);

    expect(xml).not.toContain('<site_name>');
    expect(xml).not.toContain('<byline>');
    expect(xml).not.toContain('<excerpt>');
    expect(xml).not.toContain('<language>');
  });

  it('should XML-escape special characters in fields (PC5)', () => {
    const ctx = makeContext({
      title: 'A < B & C > D "E" \'F\'',
      url: 'https://example.com/?a=1&b=2',
      textContent: 'content with <tag> & "quotes"',
      markdown: 'content with <tag> & "quotes"',
    });
    const xml = buildContextXml(ctx);

    expect(xml).toContain('<title>A &lt; B &amp; C &gt; D &quot;E&quot; &apos;F&apos;</title>');
    expect(xml).toContain('<url>https://example.com/?a=1&amp;b=2</url>');
    expect(xml).toContain('content with &lt;tag&gt; &amp; &quot;quotes&quot;');
    // 确保原始未转义的特殊字符不再出现于内容区
    expect(xml).not.toContain('<tag>');
  });

  it('should include <warnings> when warnings non-empty', () => {
    const ctx = makeContext({
      warnings: ['Content too long', 'Paywall detected'],
    });
    const xml = buildContextXml(ctx);

    expect(xml).toContain('<warnings>');
    expect(xml).toContain('<warning>Content too long</warning>');
    expect(xml).toContain('<warning>Paywall detected</warning>');
  });

  it('should escape special characters in warnings', () => {
    const ctx = makeContext({
      warnings: ['<script>alert(1)</script>'],
    });
    const xml = buildContextXml(ctx);

    expect(xml).toContain('<warning>&lt;script&gt;alert(1)&lt;/script&gt;</warning>');
    expect(xml).not.toContain('<script>alert');
  });

  it('should truncate content longer than 50_000 chars (PC3)', () => {
    const longContent = 'a'.repeat(60_000);
    const ctx = makeContext({
      markdown: longContent,
      textContent: longContent,
      length: longContent.length,
    });
    const xml = buildContextXml(ctx);

    // XML 中 content 节点内的字符数不应超过 50_000
    const contentRe = /<content>\n([\s\S]*?)\n {2}<\/content>/;
    const contentMatch = contentRe.exec(xml);
    expect(contentMatch).not.toBeNull();
    const contentText = contentMatch![1]!;
    expect(contentText.length).toBe(50_000);
  });
});

describe('buildContextPrompt', () => {
  it('should return CompletionRequest with system + user messages', () => {
    const ctx = makeContext();
    const result = buildContextPrompt(ctx, 'Summarize this page', 'gpt-4o-mini');

    expect(result.model).toBe('gpt-4o-mini');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.role).toBe('user');
  });

  it('should embed page XML and user question in user message', () => {
    const ctx = makeContext({ title: 'My Page' });
    const result = buildContextPrompt(ctx, 'What is this about?', 'claude-3');

    const userContent = result.messages[1]!.content;
    expect(userContent).toContain('<page_context>');
    expect(userContent).toContain('<title>My Page</title>');
    expect(userContent).toContain('User question: What is this about?');
  });

  it('should declare assistant role in system message', () => {
    const ctx = makeContext();
    const result = buildContextPrompt(ctx, 'q', 'm');

    const systemContent = result.messages[0]!.content;
    expect(systemContent).toContain('helpful assistant');
    expect(systemContent).toContain('page context');
  });
});
