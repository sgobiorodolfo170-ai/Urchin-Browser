/**
 * M25 邮件 HTML 预处理单元测试。
 *
 * 验证：
 * 1. rewriteCidImages：cid: 引用 → data: URI（含尖括号 contentId、未引用附件不处理）
 * 2. sanitizeMailHtml：script/form/meta/base/iframe/object/embed/on* 属性/javascript: 剥离
 * 3. prepareMailHtml：组合行为
 */
import { describe, it, expect } from 'vitest';
import { rewriteCidImages, sanitizeMailHtml, prepareMailHtml } from '../../src/main/mail/mail-html';
import type { MailAttachmentContent } from '../../src/main/mail/types';

describe('rewriteCidImages', () => {
  const img = (contentId: string): MailAttachmentContent => ({
    filename: 'logo.png',
    contentType: 'image/png',
    size: 100,
    contentId,
    contentBase64: 'aGVsbG8=',
  });

  it('should rewrite cid: src to data: URI', () => {
    const html = '<p>hi</p><img src="cid:logo@x">';
    const out = rewriteCidImages(html, [img('logo@x')]);
    expect(out).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(out).not.toContain('cid:');
  });

  it('should strip angle brackets from contentId', () => {
    const html = '<img src="cid:logo@x">';
    const out = rewriteCidImages(html, [img('<logo@x>')]);
    expect(out).toContain('data:image/png;base64,aGVsbG8=');
  });

  it('should skip attachments without contentId', () => {
    const html = '<img src="cid:logo@x">';
    const att: MailAttachmentContent = {
      filename: 'a.png',
      contentType: 'image/png',
      size: 1,
      contentBase64: 'aGVsbG8=',
    };
    expect(rewriteCidImages(html, [att])).toBe(html);
  });

  it('should skip attachments without contentBase64', () => {
    const html = '<img src="cid:logo@x">';
    const att: MailAttachmentContent = {
      filename: 'a.png',
      contentType: 'image/png',
      size: 1,
      contentId: 'logo@x',
    };
    expect(rewriteCidImages(html, [att])).toBe(html);
  });

  it('should leave non-cid html untouched', () => {
    const html = '<p>hello</p>';
    expect(rewriteCidImages(html, [img('logo@x')])).toBe(html);
  });
});

describe('sanitizeMailHtml', () => {
  it('should strip script tags with content', () => {
    const html = '<p>a</p><script>alert(1)</script><p>b</p>';
    const out = sanitizeMailHtml(html);
    expect(out).not.toContain('script');
    expect(out).toContain('<p>a</p>');
    expect(out).toContain('<p>b</p>');
  });

  it('should strip self-closing script tags', () => {
    const html = '<script src="https://evil.example/x.js"/>';
    expect(sanitizeMailHtml(html)).not.toContain('<script');
  });

  it('should strip form tags', () => {
    const html = '<form action="https://evil.example"><input></form>';
    expect(sanitizeMailHtml(html)).not.toContain('<form');
  });

  it('should strip meta refresh', () => {
    const html = '<meta http-equiv="refresh" content="0;url=https://evil.example">';
    expect(sanitizeMailHtml(html)).not.toContain('<meta');
  });

  it('should strip base tag', () => {
    const html = '<base href="https://evil.example/">';
    expect(sanitizeMailHtml(html)).not.toContain('<base');
  });

  it('should strip inline event handlers (double/single/unquoted)', () => {
    expect(sanitizeMailHtml('<div onclick="x()">a</div>')).toBe('<div>a</div>');
    expect(sanitizeMailHtml("<div onmouseover='x()'>a</div>")).toBe('<div>a</div>');
    expect(sanitizeMailHtml('<div onload=x()>a</div>')).toBe('<div>a</div>');
  });

  it('should neutralize javascript: href/src', () => {
    expect(sanitizeMailHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a href="#">x</a>');
    expect(sanitizeMailHtml("<img src='javascript:alert(1)'>")).toBe("<img src='#'>");
  });

  it('should strip iframe/object/embed', () => {
    expect(sanitizeMailHtml('<iframe src="https://evil.example"></iframe>')).toBe('');
    expect(sanitizeMailHtml('<object data="x"></object>')).toBe('');
    expect(sanitizeMailHtml('<embed src="x">')).toBe('');
  });

  it('should keep normal content and styles', () => {
    const html = '<style>.a{color:red}</style><div class="a" style="font-size:14px">正文</div>';
    const out = sanitizeMailHtml(html);
    expect(out).toContain('<style>');
    expect(out).toContain('style="font-size:14px"');
  });
});

describe('prepareMailHtml', () => {
  it('should rewrite cid and sanitize in one pass', () => {
    const html = '<img src="cid:logo@x" onclick="alert(1)"><script>alert(2)</script>';
    const att: MailAttachmentContent = {
      filename: 'logo.png',
      contentType: 'image/png',
      size: 100,
      contentId: 'logo@x',
      contentBase64: 'aGVsbG8=',
    };
    const out = prepareMailHtml(html, [att]);
    expect(out).toContain('data:image/png;base64,aGVsbG8=');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<script');
  });
});
