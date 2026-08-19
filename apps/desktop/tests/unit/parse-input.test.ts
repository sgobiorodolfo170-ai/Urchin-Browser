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

  it('should build search URL with specified engine (baidu)', () => {
    const result = parseInput('天气', 'baidu');
    expect(result.type).toBe('search');
    expect(result.url).toBe(`https://www.baidu.com/s?wd=${encodeURIComponent('天气')}`);
  });

  it('should build search URL with specified engine (bing)', () => {
    const result = parseInput('hello world', 'bing');
    expect(result.url).toBe(`https://www.bing.com/search?q=${encodeURIComponent('hello world')}`);
  });

  it('should build search URL with duckduckgo', () => {
    const result = parseInput('privacy', 'duckduckgo');
    expect(result.url).toBe(`https://duckduckgo.com/?q=${encodeURIComponent('privacy')}`);
  });

  it('should build search URL with sogou and so360', () => {
    expect(parseInput('a', 'sogou').url).toBe(
      `https://www.sogou.com/web?query=${encodeURIComponent('a')}`,
    );
    expect(parseInput('a', 'so360').url).toBe(`https://www.so.com/s?q=${encodeURIComponent('a')}`);
  });

  it('should fall back to google for unknown engine id', () => {
    const result = parseInput('term', 'unknown-engine');
    expect(result.url).toBe(`https://www.google.com/search?q=${encodeURIComponent('term')}`);
  });

  it('should keep google default when engine omitted', () => {
    const result = parseInput('term');
    expect(result.url).toBe(`https://www.google.com/search?q=${encodeURIComponent('term')}`);
  });

  // ===== Windows 本地路径识别（本地文件网页化打开）=====

  it('should convert Windows drive path (backslash) to file:// URL', () => {
    const result = parseInput('C:\\music\\song.mp3');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('file:///C:/music/song.mp3');
  });

  it('should convert Windows drive path (forward slash) to file:// URL', () => {
    const result = parseInput('C:/docs/report.pdf');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('file:///C:/docs/report.pdf');
  });

  it('should convert UNC path to file:// URL (host form)', () => {
    const result = parseInput('\\\\server\\share\\file.txt');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('file://server/share/file.txt');
  });

  it('should convert lowercase drive path to file:// URL', () => {
    const result = parseInput('d:\\data\\readme.md');
    expect(result.url).toBe('file:///d:/data/readme.md');
  });

  it('should treat paths with spaces as local files (not search), encoded', () => {
    const result = parseInput('C:\\my docs\\notes.txt');
    expect(result.type).toBe('internal');
    expect(result.url).toBe('file:///C:/my%20docs/notes.txt');
  });

  it('should percent-encode non-ASCII characters in local path', () => {
    const result = parseInput('C:\\新建文件夹\\视频.mp4');
    expect(result.type).toBe('internal');
    expect(result.url).toBe(
      'file:///C:/%E6%96%B0%E5%BB%BA%E6%96%87%E4%BB%B6%E5%A4%B9/%E8%A7%86%E9%A2%91.mp4',
    );
  });

  it('should NOT convert relative dot-paths or domain-like inputs', () => {
    // 含点但非盘符路径 → 仍按 URL 补 https 前缀（既有行为不变）
    expect(parseInput('./docs/readme.md').type).toBe('url');
    expect(parseInput('example.com').type).toBe('url');
  });
});
