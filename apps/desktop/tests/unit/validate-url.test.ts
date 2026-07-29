/**
 * M4 Omnibox · validate-url 单元测试
 *
 * 验证 OM5 决策的 URL 安全校验规则。
 */
import { describe, it, expect } from 'vitest';
import { validateUrlBeforeNavigation } from '../../src/renderer/omnibox/validate-url';

describe('validateUrlBeforeNavigation', () => {
  it('should reject javascript: protocol', () => {
    const result = validateUrlBeforeNavigation('javascript:alert(1)');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('javascript:');
  });

  it('should reject data: protocol', () => {
    const result = validateUrlBeforeNavigation('data:text/html,<script>alert(1)</script>');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('data:');
  });

  it('should reject vbscript: protocol', () => {
    const result = validateUrlBeforeNavigation('vbscript:msgbox(1)');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('vbscript:');
  });

  it('should reject URL containing javascript: in middle', () => {
    const result = validateUrlBeforeNavigation('https://example.com/javascript:alert(1)');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('非法协议');
  });

  it('should reject URL containing data: in middle', () => {
    const result = validateUrlBeforeNavigation('https://example.com/?x=data:text/html,test');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('非法协议');
  });

  it('should accept normal https URL', () => {
    const result = validateUrlBeforeNavigation('https://example.com');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept normal http URL', () => {
    const result = validateUrlBeforeNavigation('http://example.com/path?q=1');
    expect(result.valid).toBe(true);
  });

  it('should accept search engine URL', () => {
    const result = validateUrlBeforeNavigation('https://www.google.com/search?q=test');
    expect(result.valid).toBe(true);
  });

  it('should accept about: URL', () => {
    const result = validateUrlBeforeNavigation('about:blank');
    expect(result.valid).toBe(true);
  });

  it('should be case-insensitive for dangerous protocol detection', () => {
    const result = validateUrlBeforeNavigation('JAVASCRIPT:alert(1)');
    expect(result.valid).toBe(false);
  });
});
