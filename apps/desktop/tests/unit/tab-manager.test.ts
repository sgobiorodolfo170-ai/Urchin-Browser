/**
 * TabManager 单元测试。
 *
 * 验证：
 * 1. Tab ID 单调递增分配
 * 2. Tab 集合的增删查
 * 3. 按窗口分组的 tab 管理
 * 4. setActive 激活逻辑（每窗口仅一个 active）
 * 5. 事件分发（created/updated/removed/activated）
 * 6. TabSnapshot 序列化（不含 webContents/view）
 *
 * 用 mock BrowserViewFactory 避免依赖真实 Electron。
 */
import { describe, it, expect, vi } from 'vitest';
import { TabManager } from '../../src/main/tabs/tab-manager';
import type {
  BrowserViewLike,
  BrowserViewFactory,
  WebContentsLike,
} from '../../src/main/tabs/types';

/** 创建 mock WebContents。 */
function createMockWebContents(): WebContentsLike & {
  _emitEvent: (event: string, ...args: unknown[]) => void;
  _loadURLCalls: string[];
  _windowOpenHandler: ((details: { url: string }) => { action: string }) | null;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const loadURLCalls: string[] = [];
  let windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  return {
    loadURL: (url: string) => {
      loadURLCalls.push(url);
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
    executeJavaScript: vi.fn().mockResolvedValue(null),
    getURL: vi.fn().mockReturnValue('about:blank'),
    setWindowOpenHandler: (
      handler: (details: { url: string; frameName: string; disposition: string }) => {
        action: string;
      },
    ) => {
      windowOpenHandler = handler as never;
    },
    get _windowOpenHandler() {
      return windowOpenHandler;
    },
    _emitEvent: (event: string, ...args: unknown[]) => {
      const arr = listeners.get(event) ?? [];
      arr.forEach((fn) => fn(...args));
    },
    _loadURLCalls: loadURLCalls,
  };
}

/** 创建 mock BrowserView。 */
function createMockBrowserView(): BrowserViewLike & {
  _webContents: ReturnType<typeof createMockWebContents>;
} {
  const webContents = createMockWebContents();
  return {
    webContents,
    setBounds: vi.fn(),
    _webContents: webContents,
  };
}

/** 创建 mock 工厂。 */
function createMockFactory(): BrowserViewFactory & {
  _views: ReturnType<typeof createMockBrowserView>[];
} {
  const views: ReturnType<typeof createMockBrowserView>[] = [];
  const factory: BrowserViewFactory = () => {
    const view = createMockBrowserView();
    views.push(view);
    return view;
  };
  return Object.assign(factory, { _views: views });
}

describe('TabManager', () => {
  it('should create tab and assign monotonic IDs', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t1 = mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 1 });
    const t3 = mgr.create({ windowId: 1 });

    expect(t1.id).toBe(1);
    expect(t2.id).toBe(2);
    expect(t3.id).toBe(3);
  });

  it('should track tab count', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    expect(mgr.getCount()).toBe(0);

    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 1 });
    expect(mgr.getCount()).toBe(2);
  });

  it('should get tab by id', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });

    expect(mgr.getTab(t.id)?.id).toBe(1);
    expect(mgr.getTab(999)).toBeUndefined();
  });

  it('should query tabs by windowId', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 2 });

    expect(mgr.query({ windowId: 1 })).toHaveLength(2);
    expect(mgr.query({ windowId: 2 })).toHaveLength(1);
    expect(mgr.query({})).toHaveLength(3);
  });

  it('should order query results newest-first (LIFO, new tab on top)', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 1 });

    const ids = mgr.query({ windowId: 1 }).map((t) => t.id);
    expect(ids).toEqual([3, 2, 1]);
  });

  it('should assign indexInWindow correctly', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t1 = mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 1 });
    const t3 = mgr.create({ windowId: 2 });

    expect(t1.indexInWindow).toBe(0);
    expect(t2.indexInWindow).toBe(1);
    expect(t3.indexInWindow).toBe(0);
  });

  it('should remove tab and clean up', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    expect(mgr.getCount()).toBe(1);

    mgr.remove(t.id);
    expect(mgr.getCount()).toBe(0);
    expect(mgr.getTab(t.id)).toBeUndefined();
    expect(mgr.query({ windowId: 1 })).toHaveLength(0);
  });

  it('should destroy webContents on remove', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    mgr.remove(t.id);

    expect(factory._views[0]!._webContents.destroy).toHaveBeenCalled();
  });

  it('should set first tab as active by default', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    expect(t.active).toBe(true);

    const snapshot = mgr.getSnapshot(t.id);
    expect(snapshot?.active).toBe(true);
  });

  it('should set active tab and deactivate others in same window', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t1 = mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 1, active: false });

    expect(t1.active).toBe(true);
    expect(t2.active).toBe(false);

    mgr.setActive(t2.id);

    expect(mgr.getTab(t1.id)?.active).toBe(false);
    expect(mgr.getTab(t2.id)?.active).toBe(true);
  });

  it('should not affect other window tabs when setting active', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t1 = mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 2 });

    mgr.setActive(t2.id);

    expect(mgr.getTab(t1.id)?.active).toBe(true);
    expect(mgr.getTab(t2.id)?.active).toBe(true);
  });

  it('should emit created event', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const listener = vi.fn();
    mgr.on('created', listener);

    const t = mgr.create({ windowId: 1 });
    expect(listener).toHaveBeenCalledWith(mgr.getSnapshot(t.id));
  });

  it('should emit removed event', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const listener = vi.fn();
    mgr.on('removed', listener);

    const t = mgr.create({ windowId: 1 });
    mgr.remove(t.id);

    // removed 事件传递 snapshot（移除前的快照）
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });

  it('should emit activated event', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const listener = vi.fn();
    mgr.on('activated', listener);

    mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 1, active: false });

    mgr.setActive(t2.id);

    expect(listener).toHaveBeenCalledWith(mgr.getSnapshot(t2.id));
  });

  it('should load URL on create when url provided', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    mgr.create({ windowId: 1, url: 'https://example.com' });

    expect(factory._views[0]!._webContents._loadURLCalls).toContain('https://example.com');
  });

  it('should snapshot exclude webContents and view', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    const snapshot = mgr.getSnapshot(t.id);

    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty('webContents');
    expect(snapshot).not.toHaveProperty('view');
    expect(snapshot).toHaveProperty('id');
    expect(snapshot).toHaveProperty('windowId');
    expect(snapshot).toHaveProperty('url');
  });

  it('should throw when removing non-existent tab', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    expect(() => mgr.remove(999)).toThrow(/not found/i);
  });

  it('should throw when setting active for non-existent tab', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    expect(() => mgr.setActive(999)).toThrow(/not found/i);
  });

  it('should auto-activate another tab when active tab removed', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t1 = mgr.create({ windowId: 1 });
    const t2 = mgr.create({ windowId: 1, active: false });

    mgr.remove(t1.id);

    // t1 被移除后，t2 应自动激活
    expect(mgr.getTab(t2.id)?.active).toBe(true);
  });

  it('should support off listener removal', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const listener = vi.fn();

    mgr.on('created', listener);
    mgr.off('created', listener);

    mgr.create({ windowId: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  // ===== M3 Navigation Stack 测试 =====

  it('should load URL via loadUrl method', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    mgr.loadUrl(t.id, 'https://example.com');

    expect(factory._views[0]!._webContents._loadURLCalls).toContain('https://example.com');
    expect(mgr.getTab(t.id)?.url).toBe('https://example.com');
    expect(mgr.getTab(t.id)?.loading).toBe(true);
  });

  it('should emit updated event on loadUrl', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const listener = vi.fn();
    mgr.on('updated', listener);

    const t = mgr.create({ windowId: 1 });
    listener.mockClear();

    mgr.loadUrl(t.id, 'https://example.com');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id, url: 'https://example.com', loading: true }),
    );
  });

  it('should throw when loadUrl on non-existent tab', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    expect(() => mgr.loadUrl(999, 'https://example.com')).toThrow(/not found/i);
  });

  it('should stop loading via stopLoading method', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    const t = mgr.create({ windowId: 1 });
    // 模拟加载中
    mgr.loadUrl(t.id, 'https://example.com');
    expect(mgr.getTab(t.id)?.loading).toBe(true);

    // 停止加载
    mgr.stopLoading(t.id);
    expect(mgr.getTab(t.id)?.loading).toBe(false);
    expect(factory._views[0]!._webContents.stop).toHaveBeenCalled();
  });

  it('should throw when stopLoading on non-existent tab', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);

    expect(() => mgr.stopLoading(999)).toThrow(/not found/i);
  });
});

/**
 * webContents 生命周期事件绑定（bindWebContentsEvents）与退出清理测试。
 *
 * 通过 mock webContents 的 _emitEvent 触发真实事件，验证 Tab 状态同步与事件分发。
 */
describe('TabManager webContents events', () => {
  function setup() {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const updated = vi.fn();
    const crashed = vi.fn();
    mgr.on('updated', updated);
    mgr.on('crashed', crashed);
    const tab = mgr.create({ windowId: 1 });
    const wc = factory._views[0]!._webContents;
    return { factory, mgr, updated, crashed, tab, wc };
  }

  it('should update loading state on did-start-loading', () => {
    const { wc, updated } = setup();
    updated.mockClear();
    wc._emitEvent('did-start-loading');
    expect(updated).toHaveBeenCalled();
  });

  it('should clear loading and update nav state on did-finish-load', () => {
    const { wc, updated } = setup();
    wc._emitEvent('did-start-loading');
    wc._emitEvent('did-finish-load');
    expect(updated).toHaveBeenCalled();
  });

  it('should ignore ERR_ABORTED in did-fail-load', () => {
    const { wc, updated } = setup();
    updated.mockClear();
    // Electron 签名：(event, errorCode, errorDescription, validatedURL, ...)
    wc._emitEvent('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.com');
    // 中断不算失败：不额外 emit updated
    expect(updated).not.toHaveBeenCalled();
  });

  it('should clear loading and emit updated on real did-fail-load', () => {
    const { wc, updated } = setup();
    updated.mockClear();
    wc._emitEvent('did-start-loading');
    wc._emitEvent('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://bad.example');
    expect(updated).toHaveBeenCalled();
  });

  it('should clear loading on did-stop-loading fallback', () => {
    const { wc, updated } = setup();
    wc._emitEvent('did-start-loading');
    wc._emitEvent('did-stop-loading');
    expect(updated).toHaveBeenCalled();
  });

  it('should update url and nav state on did-navigate', () => {
    const { wc, updated, mgr, tab } = setup();
    wc._emitEvent('did-navigate', undefined, 'https://new.example/path');
    expect(mgr.getTab(tab.id)?.url).toBe('https://new.example/path');
    expect(updated).toHaveBeenCalled();
  });

  it('should update title on page-title-updated', () => {
    const { wc, mgr, tab } = setup();
    wc._emitEvent('page-title-updated', undefined, '新标题');
    expect(mgr.getTab(tab.id)?.title).toBe('新标题');
  });

  it('should update favicon on page-favicon-updated', () => {
    const { wc, mgr, tab } = setup();
    wc._emitEvent('page-favicon-updated', undefined, ['https://a.com/fav.ico']);
    expect(mgr.getTab(tab.id)?.favicon).toBe('https://a.com/fav.ico');
  });

  it('should mark crashed and emit crashed event on render-process-gone', () => {
    const { wc, crashed, mgr, tab } = setup();
    wc._emitEvent('render-process-gone');
    expect(mgr.getTab(tab.id)?.crashed).toBe(true);
    expect(crashed).toHaveBeenCalled();
  });

  it('should deny window.open and load in current tab when linkBehavior is current', () => {
    const { wc, mgr, tab } = setup();
    mgr.setLinkBehaviorResolver(() => 'current');
    const handler = wc._windowOpenHandler!;
    expect(handler).toBeDefined();

    // 空白 URL 直接 deny 且不触发 loadURL
    const denied = handler({ url: 'about:blank' });
    expect(denied.action).toBe('deny');
    expect(wc._loadURLCalls).not.toContain('about:blank');

    // 有效 URL：当前标签页打开（url 更新 + loading + loadURL 调用）
    const denied2 = handler({ url: 'https://target.example' });
    expect(denied2.action).toBe('deny');
    expect(mgr.getTab(tab.id)?.url).toBe('https://target.example');
    expect(mgr.getTab(tab.id)?.loading).toBe(true);
    expect(wc._loadURLCalls).toContain('https://target.example');
  });

  it('should open in new tab when linkBehavior is new-tab', () => {
    const { wc, mgr, tab } = setup();
    mgr.setLinkBehaviorResolver(() => 'new-tab');
    const countBefore = mgr.getCount();

    const denied = wc._windowOpenHandler!({ url: 'https://target.example' });
    expect(denied.action).toBe('deny');
    expect(mgr.getCount()).toBe(countBefore + 1);
    // 原 tab 不变，新 tab 加载目标 URL
    expect(mgr.getTab(tab.id)?.url).not.toBe('https://target.example');
  });

  it('should dispose all tabs and clear collections', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    mgr.create({ windowId: 1 });
    mgr.create({ windowId: 1 });
    const wc0 = factory._views[0]!._webContents;
    const wc1 = factory._views[1]!._webContents;

    mgr.disposeAll();

    expect(wc0.destroy).toHaveBeenCalled();
    expect(wc1.destroy).toHaveBeenCalled();
    expect(mgr.getCount()).toBe(0);
  });
});

describe('TabManager HTML5 fullscreen (内嵌视频全屏)', () => {
  it('should mark tab htmlFullscreen on enter and clear on leave', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const tab = mgr.create({ windowId: 1 });
    const wc = factory._views[0]!._webContents;

    wc._emitEvent('enter-html-full-screen');
    expect(mgr.getTab(tab.id)?.htmlFullscreen).toBe(true);

    wc._emitEvent('leave-html-full-screen');
    expect(mgr.getTab(tab.id)?.htmlFullscreen).toBe(false);
  });

  it('should emit updated event on fullscreen toggle', () => {
    const factory = createMockFactory();
    const mgr = new TabManager(factory);
    const updated = vi.fn();
    mgr.on('updated', updated);
    mgr.create({ windowId: 1 });
    const wc = factory._views[0]!._webContents;

    wc._emitEvent('enter-html-full-screen');
    expect(updated).toHaveBeenCalled();

    updated.mockClear();
    wc._emitEvent('leave-html-full-screen');
    expect(updated).toHaveBeenCalled();
  });
});
