/**
 * IPC schema 单元测试。
 * 验证 zod schema 对正常输入/边界输入/非法输入的判定。
 */
import { describe, it, expect } from 'vitest';
import {
  ipcSchema,
  tabIdSchema,
  urlSchema,
  tabCreateReqSchema,
  tabSnapshotSchema,
} from '../src/index';

describe('tabIdSchema', () => {
  it('should accept positive integer', () => {
    expect(tabIdSchema.parse(1)).toBe(1);
    expect(tabIdSchema.parse(42)).toBe(42);
  });

  it('should reject zero or negative', () => {
    expect(() => tabIdSchema.parse(0)).toThrow();
    expect(() => tabIdSchema.parse(-1)).toThrow();
  });

  it('should reject non-integer', () => {
    expect(() => tabIdSchema.parse(1.5)).toThrow();
  });

  it('should reject non-number', () => {
    expect(() => tabIdSchema.parse('1')).toThrow();
    expect(() => tabIdSchema.parse(null)).toThrow();
    expect(() => tabIdSchema.parse(undefined)).toThrow();
  });
});

describe('urlSchema', () => {
  it('should accept non-empty string within length limit', () => {
    expect(urlSchema.parse('https://example.com')).toBe('https://example.com');
    expect(urlSchema.parse('about:blank')).toBe('about:blank');
  });

  it('should reject empty string', () => {
    expect(() => urlSchema.parse('')).toThrow();
  });

  it('should reject string exceeding 8192 chars', () => {
    const long = 'a'.repeat(8193);
    expect(() => urlSchema.parse(long)).toThrow();
  });
});

describe('tabCreateReqSchema', () => {
  it('should apply defaults for optional fields', () => {
    const result = tabCreateReqSchema.parse({ windowId: 1 });
    expect(result.url).toBe('about:blank');
    expect(result.active).toBe(true);
  });

  it('should accept full input', () => {
    const result = tabCreateReqSchema.parse({
      windowId: 1,
      url: 'https://example.com',
      active: false,
      index: 2,
    });
    expect(result.url).toBe('https://example.com');
    expect(result.active).toBe(false);
    expect(result.index).toBe(2);
  });

  it('should reject missing windowId', () => {
    expect(() => tabCreateReqSchema.parse({})).toThrow();
  });
});

describe('tabSnapshotSchema', () => {
  it('should apply defaults for optional fields', () => {
    const result = tabSnapshotSchema.parse({
      id: 1,
      windowId: 1,
      url: 'https://example.com',
    });
    expect(result.title).toBe('');
    expect(result.active).toBe(false);
    expect(result.loading).toBe(false);
    expect(result.canGoBack).toBe(false);
    expect(result.canGoForward).toBe(false);
    expect(result.crashed).toBe(false);
    expect(result.indexInWindow).toBe(0);
  });

  it('should accept full snapshot', () => {
    const result = tabSnapshotSchema.parse({
      id: 1,
      windowId: 1,
      url: 'https://example.com',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
      active: true,
      loading: false,
      canGoBack: true,
      canGoForward: false,
      crashed: false,
      indexInWindow: 3,
    });
    expect(result.title).toBe('Example');
    expect(result.favicon).toBe('https://example.com/favicon.ico');
  });
});

describe('ipcSchema', () => {
  it('should contain all expected channels', () => {
    const channels = Object.keys(ipcSchema);
    expect(channels).toContain('tab.create');
    expect(channels).toContain('tab.close');
    expect(channels).toContain('tab.list');
    expect(channels).toContain('tab.setActive');
    expect(channels).toContain('tab.reload');
    expect(channels).toContain('tab.goBack');
    expect(channels).toContain('tab.goForward');
    expect(channels).toContain('tab.loadUrl');
    expect(channels).toContain('tab.stop');
    expect(channels).toContain('window.create');
    expect(channels).toContain('window.close');
    // AI 域（W4）
    expect(channels).toContain('ai.chat.start');
    expect(channels).toContain('ai.chat.abort');
    expect(channels).toContain('provider.list');
    expect(channels).toContain('provider.rescan');
  });

  it('should have req and res schema for each channel', () => {
    for (const [, schema] of Object.entries(ipcSchema)) {
      expect(schema.req).toBeDefined();
      expect(schema.res).toBeDefined();
      expect(typeof schema.req.parse).toBe('function');
      expect(typeof schema.res.parse).toBe('function');
    }
  });
});
