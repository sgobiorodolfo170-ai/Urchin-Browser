/**
 * 页面缩放模块单元测试（v2：页面 wheel 注入 + urchin://zoom 协议通道）
 *
 * 验证：
 * 1. computeZoomFactor——滚轮方向（放大/缩小）、deltaY=0 不变、边界 clamp（25% ~ 500%）
 * 2. buildZoomInjectionScript——识别 Ctrl+滚轮、preventDefault、fetch 通知、幂等标志
 * 3. applyZoomByDelta——方向换算与 setZoomFactor 调用、越界不重复设置、缺失 API 跳过
 * 4. installZoomControl——存量 tab、新建 tab、主窗口 webContents 均注入；dispose 移除
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeZoomFactor,
  buildZoomInjectionScript,
  applyZoomByDelta,
  installZoomControl,
} from '../../src/main/zoom';
import { TabManager } from '../../src/main/tabs/tab-manager';
import type { BrowserViewLike, WebContentsLike } from '../../src/main/tabs/types';

/** 创建 mock webContents：记录 did-finish-load 监听与 executeJavaScript 注入。 */
function createMockWebContents(): WebContentsLike & {
  _executeJavaScriptCalls: string[];
  _didFinishLoadListeners: ((...args: unknown[]) => void)[];
  _zoom: number;
  setZoomFactor: ReturnType<typeof vi.fn>;
  _emitDidFinishLoad: () => void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const wc = {
    _zoom: 1,
    _executeJavaScriptCalls: [] as string[],
    loadURL: (url: string) => {
      void url;
      return Promise.resolve();
    },
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    destroy: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    },
    executeJavaScript: ((code: string) => {
      wc._executeJavaScriptCalls.push(code);
      return Promise.resolve(undefined);
    }) as unknown as WebContentsLike['executeJavaScript'],
    getURL: vi.fn().mockReturnValue('about:blank'),
    getZoomFactor: () => wc._zoom,
    setZoomFactor: vi.fn((factor: number) => {
      wc._zoom = factor;
    }),
    get _didFinishLoadListeners() {
      return listeners.get('did-finish-load') ?? [];
    },
    _emitDidFinishLoad: () => {
      (listeners.get('did-finish-load') ?? []).forEach((fn) => fn());
    },
  };
  return wc;
}

function createMockBrowserView(): BrowserViewLike {
  const webContents = createMockWebContents();
  return { webContents, setBounds: vi.fn() };
}

describe('computeZoomFactor', () => {
  it('should zoom in when scrolling up (negative deltaY)', () => {
    expect(computeZoomFactor(1, -100)).toBeCloseTo(1.1);
  });

  it('should zoom out when scrolling down (positive deltaY)', () => {
    expect(computeZoomFactor(1, 100)).toBeCloseTo(1 / 1.1);
  });

  it('should not change when deltaY is zero', () => {
    expect(computeZoomFactor(1.5, 0)).toBe(1.5);
  });

  it('should clamp to minimum 0.25 (25%)', () => {
    expect(computeZoomFactor(0.26, 100)).toBe(0.25); // 0.26/1.1 ≈ 0.236 < 0.25
    expect(computeZoomFactor(0.25, 100)).toBe(0.25);
  });

  it('should clamp to maximum 5 (500%)', () => {
    expect(computeZoomFactor(4.9, -100)).toBe(5); // 4.9*1.1 = 5.39 > 5
    expect(computeZoomFactor(5, -100)).toBe(5);
  });
});

describe('buildZoomInjectionScript', () => {
  it('should build script that fetches zoom url with direction', () => {
    const script = buildZoomInjectionScript('urchin://zoom');
    expect(script).toContain("fetch('urchin://zoom?d=' + d");
    expect(script).toContain("{ mode: 'no-cors' }");
  });

  it('should include ctrlKey check and preventDefault', () => {
    const script = buildZoomInjectionScript('urchin://zoom');
    expect(script).toContain('if (!e.ctrlKey) return;');
    expect(script).toContain('e.preventDefault();');
  });

  it('should map deltaY direction to in/out', () => {
    const script = buildZoomInjectionScript('urchin://zoom');
    expect(script).toContain("var d = e.deltaY < 0 ? 'in' : 'out';");
  });

  it('should include idempotent install flag', () => {
    const script = buildZoomInjectionScript('urchin://zoom');
    expect(script).toContain('window.__ubZoomInstalled');
    expect(script).toContain('if (window.__ubZoomInstalled) return;');
  });
});

describe('applyZoomByDelta', () => {
  let wc: ReturnType<typeof createMockWebContents>;

  beforeEach(() => {
    vi.clearAllMocks();
    wc = createMockWebContents();
  });

  it('should zoom in on negative delta (scroll up)', () => {
    applyZoomByDelta(wc, -1);
    expect(wc.setZoomFactor).toHaveBeenCalledTimes(1);
    expect(wc._zoom).toBeCloseTo(1.1);
  });

  it('should zoom out on positive delta (scroll down)', () => {
    applyZoomByDelta(wc, 1);
    expect(wc._zoom).toBeCloseTo(1 / 1.1);
  });

  it('should not call setZoomFactor when clamped at boundary', () => {
    wc._zoom = 0.25;
    applyZoomByDelta(wc, 1);
    expect(wc.setZoomFactor).not.toHaveBeenCalled();
  });

  it('should skip webContents without zoom APIs (mock / destroyed)', () => {
    expect(() => applyZoomByDelta({}, -1)).not.toThrow();
  });
});

describe('installZoomControl', () => {
  function createTabManager(): TabManager {
    return new TabManager(() => createMockBrowserView());
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should inject into existing tabs at install time', () => {
    const tabManager = createTabManager();
    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;

    installZoomControl(tabManager);

    expect(wc._executeJavaScriptCalls).toHaveLength(1);
    expect(wc._executeJavaScriptCalls[0]).toContain('urchin://zoom');
  });

  it('should inject into tabs created after install', () => {
    const tabManager = createTabManager();
    installZoomControl(tabManager);

    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;
    expect(wc._executeJavaScriptCalls).toHaveLength(1);
  });

  it('should re-inject on did-finish-load (整页导航后新文档)', () => {
    const tabManager = createTabManager();
    installZoomControl(tabManager);
    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;

    const before = wc._executeJavaScriptCalls.length;
    wc._emitDidFinishLoad();
    expect(wc._executeJavaScriptCalls.length).toBe(before + 1);
  });

  it('should inject into main webContents with zoom-main url', () => {
    const tabManager = createTabManager();
    const mainWc = createMockWebContents();

    installZoomControl(tabManager, mainWc);

    expect(mainWc._executeJavaScriptCalls).toHaveLength(1);
    expect(mainWc._executeJavaScriptCalls[0]).toContain('urchin://zoom-main');
  });

  it('should remove created and did-finish-load listeners on dispose', () => {
    const tabManager = createTabManager();
    const mainWc = createMockWebContents();
    const dispose = installZoomControl(tabManager, mainWc);
    dispose();

    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;
    // dispose 后新建 tab 不再注入
    expect(wc._executeJavaScriptCalls).toHaveLength(0);
    // 主窗口 did-finish-load 监听已移除：触发不再注入
    const before = mainWc._executeJavaScriptCalls.length;
    mainWc._emitDidFinishLoad();
    expect(mainWc._executeJavaScriptCalls.length).toBe(before);
  });
});
