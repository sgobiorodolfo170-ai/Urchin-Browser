/**
 * 清洗快照 HTML：移除脚本/iframe/事件属性、保留正文与 base。
 */
import { describe, it, expect } from 'vitest';
import { assessQuality, buildCleanedHtml } from '../../../src/renderer/clipper/clean-html';

describe('clipper clean html', () => {
  it('should keep article content and remove unsafe nodes/attributes', () => {
    const html = buildCleanedHtml(
      '<h1 onclick="x()">标题</h1><script>alert(1)</script><iframe src="x"></iframe><p><a href="javascript:1">link</a><img src="a.png"></p>',
      'https://example.com/post',
      '标题',
    );
    expect(html).toContain('<base href="https://example.com/post">');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<img src="a.png">');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
  });

  it('should assess quality by markdown length and image/canvas fallback', () => {
    expect(
      assessQuality({ textLength: 0, markdownLength: 500, imageCount: 0, hasCanvas: false }),
    ).toBe('good');
    expect(
      assessQuality({ textLength: 0, markdownLength: 120, imageCount: 0, hasCanvas: false }),
    ).toBe('low');
    expect(
      assessQuality({ textLength: 0, markdownLength: 0, imageCount: 5, hasCanvas: false }),
    ).toBe('low');
    expect(
      assessQuality({ textLength: 0, markdownLength: 0, imageCount: 0, hasCanvas: true }),
    ).toBe('low');
    expect(
      assessQuality({ textLength: 0, markdownLength: 0, imageCount: 0, hasCanvas: false }),
    ).toBe('unavailable');
    expect(
      assessQuality({ textLength: 300, markdownLength: 0, imageCount: 0, hasCanvas: false }),
    ).toBe('low');
  });
});
