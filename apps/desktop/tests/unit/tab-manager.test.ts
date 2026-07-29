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
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const loadURLCalls: string[] = [];
  return {
    loadURL: (url: string) => loadURLCalls.push(url),
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

    // eslint-disable-next-line @typescript-eslint/unbound-method
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
});
