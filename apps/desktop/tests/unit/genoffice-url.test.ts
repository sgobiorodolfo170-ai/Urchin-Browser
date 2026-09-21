/**
 * GenOffice 编辑器标签伪地址工具单元测试（阶段 2）
 *
 * 验证：构造/解析往返（含中文与空格路径）、非法地址返回 null、
 * 保底 file-viewer 地址构造。
 */
import { describe, it, expect } from 'vitest';
import {
  buildFileUrl,
  buildFileViewerUrl,
  buildGenOfficeUrl,
  fallbackGenOfficeUrl,
  parseGenOfficeUrl,
  GENOFFICE_URL_PREFIX,
} from '../../src/main/genoffice/url';

describe('genoffice url helpers', () => {
  it('should round-trip kind and path (中文/空格/反斜杠)', () => {
    const filePath = 'C:\\Users\\a b\\文档\\notes.md';
    const url = buildGenOfficeUrl('markdown', filePath);

    expect(url.startsWith(`${GENOFFICE_URL_PREFIX}/?`)).toBe(true);
    expect(parseGenOfficeUrl(url)).toEqual({ kind: 'markdown', path: filePath });
  });

  it('should return null for non-genoffice urls', () => {
    expect(parseGenOfficeUrl('urchin://file-viewer/?path=x')).toBeNull();
    expect(parseGenOfficeUrl('https://example.com/?kind=markdown&path=x')).toBeNull();
    expect(parseGenOfficeUrl('not a url')).toBeNull();
  });

  it('should return null when required params are missing', () => {
    expect(parseGenOfficeUrl('urchin://genoffice/?kind=markdown')).toBeNull();
    expect(parseGenOfficeUrl('urchin://genoffice/?path=C%3A%5Ca.md')).toBeNull();
    expect(parseGenOfficeUrl('urchin://genoffice/')).toBeNull();
  });

  it('should build the built-in viewer fallback url', () => {
    expect(buildFileViewerUrl('C:\\a b\\c.md')).toBe(
      'urchin://file-viewer/?path=C%3A%5Ca%20b%5Cc.md',
    );
  });

  it('should rewrite genoffice urls to built-in fallbacks (集成停用降级)', () => {
    const md = buildGenOfficeUrl('markdown', 'C:\\docs\\a.md');
    expect(fallbackGenOfficeUrl(md)).toBe('urchin://file-viewer/?path=C%3A%5Cdocs%5Ca.md');

    const html = buildGenOfficeUrl('html', 'C:\\docs\\b.html');
    expect(fallbackGenOfficeUrl(html)).toBe(buildFileUrl('C:\\docs\\b.html'));

    // 非 GenOffice 地址（含 Home 入口/普通网页）原样返回
    expect(fallbackGenOfficeUrl('urchin://genoffice-home')).toBe('urchin://genoffice-home');
    expect(fallbackGenOfficeUrl('https://example.com')).toBe('https://example.com');
    expect(fallbackGenOfficeUrl('urchin://genoffice/?kind=docs')).toBe(
      'urchin://genoffice/?kind=docs',
    );
  });
});
