/**
 * M4 Omnibox · parse-input 单元测试
 *
 * 验证 OM1 决策的输入识别规则。
 */
import { describe, it, expect } from 'vitest';
import { parseInput } from '../../src/renderer/omnibox/parse-input';

describe('parseInput', () => {
  it('should parse http:// URL as url type', () => {
    const result = parseInput('http://example.com');
    expect(result.type).toBe('url');
    expect(result.url).toBe('http://example.com');
  });

  it('should parse https:// URL as url type', () => {
    const result = parseInput('https://example.com/path');
    expect(result.type).toBe('url');
    expect(result.url).toBe('https://example.com/path');
  });

  it('should parse ftp:// URL as url type', () => {
    const result = parseInput('ftp://files.example.com');
    expect(result.type).toBe('url');
    expect(result.url).toBe('ftp://files.example.com');
  });

  it('should parse about: as internal type', () => {
    const result = parseInput('about:blank');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('about:blank');
  });

  it('should parse urchin: as internal type', () => {
    const result = parseInput('urchin://newtab');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('urchin://newtab');
  });

  it('should parse file: as internal type', () => {
    const result = parseInput('file:///C:/Users/test');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('file:///C:/Users/test');
  });

  it('should parse text with spaces as search', () => {
    const result = parseInput('hello world');
    expect(result.type).toBe('search');
    expect(result.url).toContain('google.com/search');
    expect(result.url).toContain('hello%20world');
  });

  it('should parse text with dot and no spaces as URL', () => {
    const result = parseInput('example.com');
    expect(result.type).toBe('url');
    expect(result.url).toBe('https://example.com');
  });

  it('should parse text without dot as search', () => {
    const result = parseInput('searchterm');
    expect(result.type).toBe('search');
    expect(result.url).toContain('google.com/search');
  });

  it('should parse empty string as empty type', () => {
    const result = parseInput('');
    expect(result.type).toBe('empty');
    expect(result.url).toBe('urchin://newtab');
  });

  it('should parse whitespace-only string as empty type', () => {
    const result = parseInput('   ');
    expect(result.type).toBe('empty');
  });

  it('should be case-insensitive for protocol detection', () => {
    const result = parseInput('HTTPS://EXAMPLE.COM');
    expect(result.type).toBe('url');
  });

  it('should encode search query in URL', () => {
    const result = parseInput('test & special chars');
    expect(result.type).toBe('search');
    expect(result.url).toContain(encodeURIComponent('test & special chars'));
  });
});
