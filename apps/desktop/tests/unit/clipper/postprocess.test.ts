/**
 * 正文后处理：选区 HTML 净化 + 尾部信息栏剪除。
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeFragmentHtml,
  trimTrailingBoilerplate,
} from '../../../src/renderer/clipper/postprocess';

describe('clipper postprocess', () => {
  describe('sanitizeFragmentHtml', () => {
    it('should remove scripts/styles/forms and event attributes', () => {
      const html =
        '<p onclick="x()">正文</p><script>alert(1)</script><style>.x{}</style>' +
        '<iframe src="x"></iframe><form><input></form>';
      const out = sanitizeFragmentHtml(html);
      expect(out).toContain('<p>正文</p>');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('<style');
      expect(out).not.toContain('<iframe');
      expect(out).not.toContain('<form');
      expect(out).not.toContain('onclick');
    });

    it('should strip javascript: urls but keep normal links', () => {
      const out = sanitizeFragmentHtml(
        '<a href="javascript:alert(1)">bad</a><a href="https://ok.test/x">ok</a>',
      );
      expect(out).toContain('href="https://ok.test/x"');
      expect(out).not.toContain('javascript:');
    });

    it('should return empty string for empty input', () => {
      expect(sanitizeFragmentHtml('')).toBe('');
    });
  });

  describe('trimTrailingBoilerplate', () => {
    it('should trim trailing 来源/作者/评论 short lines', () => {
      const md = '正文段落一。\n\n来源：新华网\n作者：张三\n评论：0';
      expect(trimTrailingBoilerplate(md)).toBe('正文段落一。');
    });

    it('should keep boilerplate that appears in the middle of body', () => {
      const md = '来源：新华网\n\n正文段落一。\n\n作者：张三';
      // 末尾的「作者：张三」应被剪除，中间的「来源：新华网」保留
      expect(trimTrailingBoilerplate(md)).toBe('来源：新华网\n\n正文段落一。');
    });

    it('should not trim long paragraph even if it starts with keyword', () => {
      const longLine = '来源：'.padEnd(120, 'x');
      const md = `正文。\n\n${longLine}`;
      expect(trimTrailingBoilerplate(md)).toBe(md);
    });

    it('should collapse trailing blank lines after trim', () => {
      const md = '正文。\n\n来源：新华网\n\n\n';
      expect(trimTrailingBoilerplate(md)).toBe('正文。');
    });

    it('should return input when no boilerplate at end', () => {
      const md = '正文一。\n\n正文二。';
      expect(trimTrailingBoilerplate(md)).toBe(md);
    });

    it('should accept full-width and half-width colons', () => {
      expect(trimTrailingBoilerplate('正文。\n来源:新华网')).toBe('正文。');
      expect(trimTrailingBoilerplate('正文。\n来源：新华网')).toBe('正文。');
    });

    it('should return empty string for empty input', () => {
      expect(trimTrailingBoilerplate('')).toBe('');
    });
  });
});
