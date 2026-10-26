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
  devtoolsAttachReqSchema,
  devtoolsEvaluateReqSchema,
  devtoolsNetworkListResSchema,
  devtoolsConsoleListResSchema,
  uiLayoutSetStateReqSchema,
  DEVTOOLS_EVENT_CHANNEL,
  DEVTOOLS_TOGGLE_CHANNEL,
  DEVTOOLS_EVALUATE_MAX_BYTES,
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
    expect(channels).toContain('tab.captureThumbnail');
    expect(channels).toContain('window.create');
    expect(channels).toContain('window.close');
    expect(channels).toContain('window.minimize');
    expect(channels).toContain('window.toggleMaximize');
    expect(channels).toContain('window.getState');
    expect(channels).toContain('window.createWithUrl');
    expect(channels).toContain('window.getCurrent');
    expect(channels).toContain('window.captureUi');
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

  it('should contain M15 devtools channels', () => {
    const channels = Object.keys(ipcSchema);
    expect(channels).toContain('devtools.attach');
    expect(channels).toContain('devtools.detach');
    expect(channels).toContain('devtools.status');
    expect(channels).toContain('devtools.network.list');
    expect(channels).toContain('devtools.network.clear');
    expect(channels).toContain('devtools.console.list');
    expect(channels).toContain('devtools.console.clear');
    expect(channels).toContain('devtools.evaluate');
  });
});

describe('devtoolsAttachReqSchema', () => {
  it('should accept positive tabId', () => {
    expect(devtoolsAttachReqSchema.parse({ tabId: 1 })).toEqual({ tabId: 1 });
  });

  it('should reject missing tabId', () => {
    expect(() => devtoolsAttachReqSchema.parse({})).toThrow();
  });

  it('should reject non-positive tabId', () => {
    expect(() => devtoolsAttachReqSchema.parse({ tabId: 0 })).toThrow();
    expect(() => devtoolsAttachReqSchema.parse({ tabId: -1 })).toThrow();
  });
});

describe('devtoolsEvaluateReqSchema', () => {
  it('should accept expression within byte limit', () => {
    const result = devtoolsEvaluateReqSchema.parse({ tabId: 1, expression: '1 + 1' });
    expect(result.expression).toBe('1 + 1');
    expect(result.awaitPromise).toBeUndefined();
  });

  it('should accept awaitPromise flag', () => {
    const result = devtoolsEvaluateReqSchema.parse({
      tabId: 1,
      expression: 'fetch("/x")',
      awaitPromise: true,
    });
    expect(result.awaitPromise).toBe(true);
  });

  it('should reject empty expression', () => {
    expect(() => devtoolsEvaluateReqSchema.parse({ tabId: 1, expression: '' })).toThrow();
  });

  it('should reject expression exceeding byte limit', () => {
    const tooLong = 'a'.repeat(DEVTOOLS_EVALUATE_MAX_BYTES + 1);
    expect(() => devtoolsEvaluateReqSchema.parse({ tabId: 1, expression: tooLong })).toThrow();
  });
});

describe('devtools list response schemas', () => {
  it('devtoolsNetworkListResSchema should accept empty entries (no-session case)', () => {
    const result = devtoolsNetworkListResSchema.parse({ entries: [], dropped: 0 });
    expect(result.entries).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it('devtoolsConsoleListResSchema should accept empty entries', () => {
    const result = devtoolsConsoleListResSchema.parse({ entries: [], dropped: 0 });
    expect(result.entries).toEqual([]);
  });

  it('devtoolsNetworkListResSchema should accept a full entry', () => {
    const result = devtoolsNetworkListResSchema.parse({
      entries: [
        {
          seq: 0,
          requestId: '1',
          url: 'https://example.com',
          method: 'GET',
          status: 200,
          size: 1024,
          startedAt: 1000,
          finishedAt: 1500,
          durationMs: 500,
          responseHeaders: { 'content-type': 'text/html' },
        },
      ],
      dropped: 0,
    });
    expect(result.entries[0]?.status).toBe(200);
  });

  it('devtoolsConsoleListResSchema should reject stackTrace over 10 frames', () => {
    // schema 校验层拒绝超限；主进程 manager 在采集时已截断到 ≤10 帧（见实施规划 §6.2）
    const frames = Array.from({ length: 12 }, (_, i) => ({ functionName: `f${i}` }));
    expect(() =>
      devtoolsConsoleListResSchema.parse({
        entries: [
          {
            seq: 0,
            level: 'error',
            text: 'boom',
            source: 'exception',
            timestamp: 1,
            stackTrace: frames,
          },
        ],
        dropped: 0,
      }),
    ).toThrow();
  });

  it('devtoolsConsoleListResSchema should accept 10 frames', () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ functionName: `f${i}` }));
    const result = devtoolsConsoleListResSchema.parse({
      entries: [
        {
          seq: 0,
          level: 'error',
          text: 'boom',
          source: 'exception',
          timestamp: 1,
          stackTrace: frames,
        },
      ],
      dropped: 0,
    });
    expect(result.entries[0]?.stackTrace?.length).toBe(10);
  });
});

describe('uiLayoutSetStateReqSchema (devtoolsWidth 增补)', () => {
  it('should accept devtoolsWidth within range', () => {
    const result = uiLayoutSetStateReqSchema.parse({ devtoolsWidth: 360 });
    expect(result.devtoolsWidth).toBe(360);
  });

  it('should treat devtoolsWidth as optional (backward compat)', () => {
    const result = uiLayoutSetStateReqSchema.parse({ leftWidth: 48 });
    expect(result.devtoolsWidth).toBeUndefined();
  });

  it('should reject devtoolsWidth over 900', () => {
    expect(() => uiLayoutSetStateReqSchema.parse({ devtoolsWidth: 901 })).toThrow();
  });

  it('should reject negative devtoolsWidth', () => {
    expect(() => uiLayoutSetStateReqSchema.parse({ devtoolsWidth: -1 })).toThrow();
  });
});

describe('devtools event channel constants', () => {
  it('should export stable channel names', () => {
    expect(DEVTOOLS_EVENT_CHANNEL).toBe('devtools:event');
    expect(DEVTOOLS_TOGGLE_CHANNEL).toBe('devtools:toggle');
  });
});
