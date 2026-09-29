/**
 * M24 网页翻译 · TranslateManager 单元测试
 *
 * 全部依赖注入 mock（tabManager/settings/resolveProxy/engines/webContents），
 * 覆盖规划 §7.5/§8.1：auto 引擎选择（resolveProxy）、双引擎 failover、
 * 语言一致跳过、自动翻译触发保守规则、导航重译、缓存命中、停止恢复。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TranslateManager,
  type TranslateProgressPayload,
} from '../../../src/main/translate/translate-manager';
import { EngineError } from '../../../src/main/translate/engines/types';
import type { WebContentsLike } from '../../../src/main/tabs/types';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

interface SentEvent {
  channel: string;
  data: TranslateProgressPayload;
}

interface FakePage {
  collectResult: () =>
    { lang: string; segments: { id: number; text: string }[] } | Promise<unknown>;
  pending: { id: number; text: string }[];
}

function createFakeWebContents(
  url: string,
  page: FakePage,
): WebContentsLike & {
  _sent: SentEvent[];
  _applied: { id: number; text: string }[][];
  _tornDown: { value: boolean };
  fire(event: string): void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const sent: SentEvent[] = [];
  const applied: { id: number; text: string }[][] = [];
  const tornDown = { value: false };

  const wc = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    destroy: vi.fn(),
    on(event: string, handler: (...args: unknown[]) => void): void {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    once: vi.fn(),
    removeListener(event: string, handler: (...args: unknown[]) => void): void {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    },
    send(channel: string, data: unknown): void {
      sent.push({ channel, data: data as TranslateProgressPayload });
    },
    executeJavaScript: (async (code: string) => {
      if (code.includes('.collect(')) return page.collectResult();
      if (code.includes('.apply(')) {
        const json = code.slice(code.indexOf('.apply(') + 7, code.lastIndexOf(')'));
        const items = JSON.parse(json) as { id: number; text: string }[];
        applied.push(items);
        return items.length;
      }
      if (code.includes('takePending')) return page.pending;
      if (code.includes('.teardown()')) {
        tornDown.value = true;
        return undefined;
      }
      return undefined;
    }) as WebContentsLike['executeJavaScript'],
    getURL: () => url,
    fire(event: string): void {
      for (const handler of listeners.get(event) ?? []) handler();
    },
    _sent: sent,
    _applied: applied,
    _tornDown: tornDown,
  };
  return wc;
}

function createEnv(options?: {
  url?: string;
  settings?: Record<string, unknown>;
  proxyInfo?: string;
  collectResult?: () => { lang: string; segments: { id: number; text: string }[] };
}) {
  const url = options?.url ?? 'https://example.com/article';
  const settings = new Map<string, unknown>([
    ['translate.targetLang', 'zh-CN'],
    ['translate.engine', 'auto'],
    ['translate.autoTranslate', false],
    ...Object.entries(options?.settings ?? {}),
  ]);
  const page: FakePage = {
    collectResult:
      options?.collectResult ??
      (() => ({
        lang: 'en',
        segments: [
          { id: 1, text: 'Hello' },
          { id: 2, text: 'World' },
        ],
      })),
    pending: [],
  };
  const wc = createFakeWebContents(url, page);
  const tabs = new Map([[1, { id: 1, webContents: wc }]]);
  const tabListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const tabManager = {
    tabs,
    getTab: (id: number) => tabs.get(id),
    query: () => [...tabs.values()],
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const arr = tabListeners.get(event) ?? [];
      arr.push(listener);
      tabListeners.set(event, arr);
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      const arr = tabListeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    },
  };

  const microsoft = {
    id: 'microsoft' as const,
    translateBatch: vi.fn((texts: readonly string[]) =>
      Promise.resolve({ texts: texts.map((t) => `【译】${t}`), detectedLang: 'en' }),
    ),
  };
  const google = {
    id: 'google' as const,
    translateBatch: vi.fn((texts: readonly string[]) =>
      Promise.resolve({ texts: texts.map((t) => `【谷歌】${t}`), detectedLang: 'en' }),
    ),
  };
  const mymemory = {
    id: 'mymemory' as const,
    translateBatch: vi.fn((texts: readonly string[]) =>
      Promise.resolve({ texts: texts.map((t) => `【MyMemory】${t}`), detectedLang: 'en' }),
    ),
  };
  const resolveProxy = vi.fn().mockResolvedValue(options?.proxyInfo ?? 'DIRECT');
  const progressEvents: TranslateProgressPayload[] = [];

  const manager = new TranslateManager({
    tabManager,
    settings: { get: (key: string) => settings.get(key) },
    resolveProxy,
    engines: { microsoft, google, mymemory },
    notifyProgress: (tabId, payload) => progressEvents.push(payload),
  });

  return { manager, wc, tabs, settings, microsoft, google, mymemory, resolveProxy, progressEvents };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('TranslateManager.start（整页翻译主干）', () => {
  it('should collect, translate via mymemory (DIRECT) and apply to page', async () => {
    const env = createEnv();

    const res = await env.manager.start(1);
    expect(res.status).toBe('started');
    expect(res.segmentCount).toBe(2);
    expect(res.detectedLang).toBe('en');

    await env.manager.whenSettled(1);

    expect(env.mymemory.translateBatch).toHaveBeenCalled();
    expect(env.google.translateBatch).not.toHaveBeenCalled();
    expect(env.wc._applied[0]).toEqual([
      { id: 1, text: '【MyMemory】Hello' },
      { id: 2, text: '【MyMemory】World' },
    ]);
    const phases = env.progressEvents.map((e) => e.phase);
    expect(phases).toContain('collecting');
    expect(phases).toContain('translating');
    expect(phases).toContain('done');
  });

  it('should prefer google when resolveProxy reports a proxy (翻墙环境)', async () => {
    const env = createEnv({ proxyInfo: 'PROXY 127.0.0.1:7890' });

    await env.manager.start(1);
    await env.manager.whenSettled(1);

    expect(env.google.translateBatch).toHaveBeenCalled();
    expect(env.mymemory.translateBatch).not.toHaveBeenCalled();
  });

  it('should cache the auto engine resolution across starts', async () => {
    const env = createEnv({ proxyInfo: 'PROXY 127.0.0.1:7890' });

    await env.manager.start(1);
    await env.manager.whenSettled(1);
    await env.manager.start(1);
    await env.manager.whenSettled(1);

    expect(env.resolveProxy).toHaveBeenCalledTimes(1);
  });

  it('should failover to google when mymemory keeps failing and notify once', async () => {
    const env = createEnv();
    env.mymemory.translateBatch.mockRejectedValue(
      new EngineError('mymemory', 'rate_limited', '429'),
    );

    await env.manager.start(1);
    await env.manager.whenSettled(1);

    expect(env.google.translateBatch).toHaveBeenCalled();
    const messages = env.progressEvents.map((e) => e.message ?? '');
    expect(messages.some((m) => m.includes('谷歌'))).toBe(true);
    expect(env.manager.getStatus(1)).toMatchObject({ active: true, resolvedEngine: 'google' });
  });

  it('should finish with failed-count message when all engines fail', async () => {
    const env = createEnv();
    env.mymemory.translateBatch.mockRejectedValue(new EngineError('mymemory', 'network', 'down'));
    env.google.translateBatch.mockRejectedValue(new EngineError('google', 'network', 'down'));
    env.microsoft.translateBatch.mockRejectedValue(new EngineError('microsoft', 'network', 'down'));

    await env.manager.start(1);
    await env.manager.whenSettled(1);

    expect(env.wc._applied).toHaveLength(0);
    const done = env.progressEvents.find((e) => e.phase === 'done');
    expect(done?.message).toContain('2 段翻译失败');
  });

  it('should skip when page language matches target language', async () => {
    const env = createEnv();

    const res = await env.manager.start(1, { targetLang: 'en' });

    expect(res.status).toBe('skipped');
    expect(res.detectedLang).toBe('en');
    expect(env.mymemory.translateBatch).not.toHaveBeenCalled();
    expect(env.wc._tornDown.value).toBe(true); // 页面运行时已拆除
    expect(env.manager.getStatus(1).active).toBe(false);
  });

  it('should throw for unknown tab', async () => {
    const env = createEnv();
    await expect(env.manager.start(999)).rejects.toThrow('tab not found');
  });
});

describe('TranslateManager 自动翻译（TD4 开关制）', () => {
  it('should auto-translate on navigation when autoTranslate is on and lang is known', async () => {
    const env = createEnv({ settings: { 'translate.autoTranslate': true } });

    env.wc.fire('did-finish-load');
    await vi.waitFor(() => {
      expect(env.mymemory.translateBatch).toHaveBeenCalled();
    });
    await env.manager.whenSettled(1);
    expect(env.manager.getStatus(1).active).toBe(true);
  });

  it('should not auto-translate when the switch is off (default)', async () => {
    const env = createEnv();

    env.wc.fire('did-finish-load');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(env.mymemory.translateBatch).not.toHaveBeenCalled();
    expect(env.manager.getStatus(1).active).toBe(false);
  });

  it('should not auto-translate when page language is unknown (conservative rule)', async () => {
    const env = createEnv({
      settings: { 'translate.autoTranslate': true },
      collectResult: () => ({ lang: '', segments: [{ id: 1, text: 'Mystery' }] }),
    });

    env.wc.fire('did-finish-load');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(env.mymemory.translateBatch).not.toHaveBeenCalled();
  });

  it('should not auto-translate on non-http(s) pages', async () => {
    const env = createEnv({
      url: 'file:///C:/local/page.html',
      settings: { 'translate.autoTranslate': true },
    });

    env.wc.fire('did-finish-load');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(env.mymemory.translateBatch).not.toHaveBeenCalled();
  });
});

describe('TranslateManager 导航重译与停止', () => {
  it('should re-translate after navigation while active, hitting cache instead of engine', async () => {
    const env = createEnv();

    await env.manager.start(1);
    await env.manager.whenSettled(1);
    expect(env.mymemory.translateBatch).toHaveBeenCalledTimes(1);

    // 导航：页面世界重建，激活态自动重译；同文本命中缓存 → 引擎不再被调用
    env.wc.fire('did-finish-load');
    await vi.waitFor(() => {
      expect(env.wc._applied).toHaveLength(2); // 首轮 + 重译轮各一次 apply
    });
    expect(env.mymemory.translateBatch).toHaveBeenCalledTimes(1);
  });

  it('should restore original text and go idle on stop', async () => {
    const env = createEnv();

    await env.manager.start(1);
    await env.manager.whenSettled(1);

    const res = await env.manager.stop(1);
    expect(res).toEqual({ status: 'restored' });
    expect(env.wc._tornDown.value).toBe(true);
    expect(env.manager.getStatus(1)).toEqual({ active: false });

    const again = await env.manager.stop(1);
    expect(again).toEqual({ status: 'idle' });
  });
});

describe('TranslateManager.translateSelection（划词翻译）', () => {
  it('should use auto-resolved engine (mymemory on DIRECT) and return single result', async () => {
    const env = createEnv();

    const res = await env.manager.translateSelection(1, 'Hello world');

    expect(res.result).toBe('【MyMemory】Hello world');
    expect(env.mymemory.translateBatch).toHaveBeenCalledWith(['Hello world'], {
      to: 'zh-CN',
      signal: undefined,
    });
  });

  it('should fall back to google when the primary (mymemory) fails', async () => {
    const env = createEnv();
    env.mymemory.translateBatch.mockRejectedValue(new EngineError('mymemory', 'network', 'down'));

    const res = await env.manager.translateSelection(1, 'Hello');

    expect(res.result).toBe('【谷歌】Hello');
  });

  it('should respect manually locked engine without proxy resolution', async () => {
    const env = createEnv({ settings: { 'translate.engine': 'google' } });

    await env.manager.translateSelection(1, 'Hello');

    expect(env.resolveProxy).not.toHaveBeenCalled();
    expect(env.google.translateBatch).toHaveBeenCalled();
  });
});

describe('TranslateManager.translateTexts（M25 邮件翻译复用入口）', () => {
  it('should translate text array via auto-resolved engine (mymemory on DIRECT) and return engine id', async () => {
    const env = createEnv();

    const res = await env.manager.translateTexts(['Hello', 'World'], 'zh-CN');

    expect(res.texts).toEqual(['【MyMemory】Hello', '【MyMemory】World']);
    expect(res.engine).toBe('mymemory');
    expect(res.detectedLang).toBe('en');
    expect(env.mymemory.translateBatch).toHaveBeenCalledWith(['Hello', 'World'], {
      to: 'zh-CN',
      signal: undefined,
    });
  });

  it('should fall back to secondary engine and report actual engine used', async () => {
    const env = createEnv();
    env.mymemory.translateBatch.mockRejectedValue(new EngineError('mymemory', 'network', 'down'));

    const res = await env.manager.translateTexts(['Hello'], 'zh-CN');

    expect(res.texts).toEqual(['【谷歌】Hello']);
    expect(res.engine).toBe('google');
  });

  it('should throw when all engines fail', async () => {
    const env = createEnv();
    env.mymemory.translateBatch.mockRejectedValue(new EngineError('mymemory', 'network', 'down'));
    env.google.translateBatch.mockRejectedValue(new EngineError('google', 'network', 'down'));
    env.microsoft.translateBatch.mockRejectedValue(new EngineError('microsoft', 'network', 'down'));

    await expect(env.manager.translateTexts(['Hello'], 'zh-CN')).rejects.toThrow();
  });

  it('should respect manually locked engine', async () => {
    const env = createEnv({ settings: { 'translate.engine': 'google' } });

    const res = await env.manager.translateTexts(['Hello'], 'zh-CN');

    expect(env.resolveProxy).not.toHaveBeenCalled();
    expect(res.engine).toBe('google');
  });
});
