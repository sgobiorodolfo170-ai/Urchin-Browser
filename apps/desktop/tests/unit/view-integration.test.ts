/**
 * BrowserView 窗口集成（installTabViewIntegration）单元测试
 *
 * 验证：
 * 1. 安装后订阅 created/updated/activated/removed/crashed 事件并桥接窗口操作
 * 2. created 活跃 tab：setBrowserView + 强制 setBounds + pushEvent
 * 3. updated：URL 变化时重算 bounds；16ms 节流合并推送
 * 4. activated：切换 setBrowserView + 强制 setBounds + pushEvent
 * 5. removed：卸载活跃 tab 的 view + 清理 URL 跟踪
 * 6. crashed：pushEvent
 * 7. 内部 URL（urchin://settings / urchin://ai）→ ZERO_BOUNDS
 * 8. browserViewHidden → ZERO_BOUNDS
 * 9. computeViewBounds：考虑左/右侧栏宽度与下侧栏高度
 * 10. getLayoutState / setLayoutState：布局状态读写 + contentHidden 兼容
 * 11. dispose 卸载所有监听
 * 12. 窗口 resize / ready-to-show 事件绑定
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installTabViewIntegration,
  getLayoutState,
  setLayoutState,
} from '../../src/main/tabs/view-integration';

interface FakeBrowserWindow {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  setBrowserView: ReturnType<typeof vi.fn>;
  getContentBounds: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
}

interface FakeManagedWindow {
  id: number;
  browserWindow: FakeBrowserWindow;
  isIncognito: boolean;
}

interface FakeView {
  setBounds: ReturnType<typeof vi.fn>;
}

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  title?: string;
  loading?: boolean;
  active: boolean;
  view: FakeView;
}

/** 简单事件发射器，用于模拟 TabManager / WindowManager */
function makeEmitter() {
  const listeners = new Map<string, ((payload: never) => void)[]>();
  return {
    listeners,
    on(event: string, listener: (payload: never) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    off(event: string, listener: (payload: never) => void) {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    },
    emit(event: string, payload: never) {
      const arr = listeners.get(event) ?? [];
      for (const l of [...arr]) l(payload);
    },
  };
}

function makeBrowserWindow(): FakeBrowserWindow {
  return {
    on: vi.fn(),
    once: vi.fn(),
    setBrowserView: vi.fn(),
    getContentBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
    webContents: { send: vi.fn() },
  };
}

function makeManagedWindow(id = 1): FakeManagedWindow {
  return { id, browserWindow: makeBrowserWindow(), isIncognito: false };
}

function makeTab(overrides: Partial<FakeTab> = {}): FakeTab {
  return {
    id: 1,
    windowId: 1,
    url: 'https://example.com',
    active: true,
    view: { setBounds: vi.fn() },
    ...overrides,
  };
}

/** 构建 tab 管理器 mock（内部是事件发射器） */
function makeTabManager() {
  const emitter = makeEmitter();
  const tabs = new Map<number, FakeTab>();
  return {
    ...emitter,
    tabs,
    query: vi.fn((info: { windowId?: number }) =>
      Array.from(tabs.values()).filter((t) => t.windowId === (info.windowId ?? t.windowId)),
    ),
    getTab: vi.fn((id: number) => tabs.get(id)),
    register(tab: FakeTab) {
      tabs.set(tab.id, tab);
    },
  };
}

/** 构建窗口管理器 mock */
function makeWindowManager() {
  const emitter = makeEmitter();
  const windows = new Map<number, FakeManagedWindow>();
  return {
    ...emitter,
    windows,
    getWindow: vi.fn((id: number) => windows.get(id)),
    getAllWindows: vi.fn(() => Array.from(windows.values())),
    register(win: FakeManagedWindow) {
      windows.set(win.id, win);
    },
  };
}

type TabManagerMock = ReturnType<typeof makeTabManager>;
type WindowManagerMock = ReturnType<typeof makeWindowManager>;

let tabManager: TabManagerMock;
let windowManager: WindowManagerMock;
let window: FakeManagedWindow;
let handle: { dispose: () => void; refreshAllViewBounds: () => void };

function install(): void {
  handle = installTabViewIntegration(tabManager as never, windowManager as never);
}

/** 触发 TabManager 事件 */
function fireTab(event: string, tab: FakeTab): void {
  tabManager.emit(event, tab as never);
}

describe('view-integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabManager = makeTabManager();
    windowManager = makeWindowManager();
    window = makeManagedWindow(1);
    windowManager.register(window);
    setLayoutState({
      leftWidth: 44,
      rightWidth: 44,
      bottomHeight: 48,
      browserViewHidden: false,
      overlayRightWidth: 0,
    });
  });

  afterEach(() => {
    handle?.dispose();
  });

  describe('getLayoutState / setLayoutState', () => {
    it('should return default layout state', () => {
      expect(getLayoutState()).toEqual({
        leftWidth: 44,
        rightWidth: 44,
        bottomHeight: 48,
        browserViewHidden: false,
        overlayRightWidth: 0,
      });
    });

    it('should update only provided fields and include contentHidden', () => {
      const next = setLayoutState({ leftWidth: 200, rightWidth: 300, bottomHeight: 100 });

      expect(next).toEqual({
        leftWidth: 200,
        rightWidth: 300,
        bottomHeight: 100,
        browserViewHidden: false,
        overlayRightWidth: 0,
        contentHidden: false,
      });
      expect(getLayoutState().leftWidth).toBe(200);
    });

    it('should ignore contentHidden and accept browserViewHidden', () => {
      const next = setLayoutState({ contentHidden: true, browserViewHidden: true });
      expect(next.contentHidden).toBe(false);
      expect(next.browserViewHidden).toBe(true);

      const state = getLayoutState();
      expect(state.browserViewHidden).toBe(true);
    });

    it('should accept overlayRightWidth for popup panel', () => {
      const next = setLayoutState({ overlayRightWidth: 288 });
      expect(next.overlayRightWidth).toBe(288);
      expect(getLayoutState().overlayRightWidth).toBe(288);
    });
  });

  describe('tab created', () => {
    it('should attach BrowserView for active tab and push created event', () => {
      const tab = makeTab({ id: 1, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);

      expect(window.browserWindow.setBrowserView).toHaveBeenCalledWith(tab.view);
      expect(tab.view.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ x: 44, width: 800 - 88, height: 600 - 48 }),
      );
      expect(window.browserWindow.webContents.send).toHaveBeenCalledWith(
        'tab:event',
        expect.objectContaining({
          type: 'created',
          snapshot: expect.any(Object) as Record<string, unknown>,
        }),
      );
    });

    it('should warn when window missing but still push event', () => {
      const tab = makeTab({ id: 9, windowId: 99 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);

      expect(windowManager.getWindow).toHaveBeenCalledWith(99);
      expect(tab.view.setBounds).not.toHaveBeenCalled();
      expect(window.browserWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should not set bounds for inactive created tab', () => {
      const tab = makeTab({ id: 2, windowId: 1, active: false });
      tabManager.register(tab);
      install();

      fireTab('created', tab);

      expect(window.browserWindow.setBrowserView).not.toHaveBeenCalled();
    });
  });

  describe('tab activated', () => {
    it('should re-attach view, force bounds and push activated event', () => {
      const tab = makeTab({ id: 3, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);
      tab.view.setBounds.mockClear();

      fireTab('activated', tab);

      expect(window.browserWindow.setBrowserView).toHaveBeenCalledWith(tab.view);
      expect(tab.view.setBounds).toHaveBeenCalled();
      expect(window.browserWindow.webContents.send).toHaveBeenCalledWith(
        'tab:event',
        expect.objectContaining({ type: 'activated' }),
      );
    });
  });

  describe('tab updated', () => {
    it('should recompute bounds when url changed', () => {
      const tab = makeTab({ id: 4, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);
      tab.view.setBounds.mockClear();

      tab.url = 'https://new.example.com';
      fireTab('updated', { ...tab });

      expect(tab.view.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ width: 800 - 88, height: 600 - 48 }),
      );
    });

    it('should skip setBounds when url unchanged', () => {
      const tab = makeTab({ id: 5, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);
      tab.view.setBounds.mockClear();

      fireTab('updated', { ...tab });

      expect(tab.view.setBounds).not.toHaveBeenCalled();
    });

    it('should throttle updated push events', async () => {
      const tab = makeTab({ id: 6, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);
      window.browserWindow.webContents.send.mockClear();

      fireTab('updated', { ...tab, loading: true });
      fireTab('updated', { ...tab, title: 't1' });
      fireTab('updated', { ...tab, title: 't2' });

      expect(window.browserWindow.webContents.send).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 40));
      expect(window.browserWindow.webContents.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('internal urls', () => {
    it.each(['urchin://settings', 'urchin://settings/', 'urchin://ai', 'urchin://ai/'])(
      'should zero bounds for %s',
      (url) => {
        const tab = makeTab({ id: 10, windowId: 1, url });
        tabManager.register(tab);
        install();

        fireTab('created', tab);

        expect(tab.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
      },
    );
  });

  describe('browserViewHidden', () => {
    it('should zero bounds while hidden', () => {
      const tab = makeTab({ id: 11, windowId: 1 });
      tabManager.register(tab);
      setLayoutState({ browserViewHidden: true });
      install();

      fireTab('created', tab);

      expect(tab.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('should keep page visible with narrowed bounds when overlay panel open', () => {
      // 2026-08-14 修复：收藏夹面板弹出用 overlayRightWidth 让出右侧，
      // 不再整体隐藏 BrowserView（网页保持可见）。
      const tab = makeTab({ id: 12, windowId: 1 });
      tabManager.register(tab);
      setLayoutState({ overlayRightWidth: 288 });
      install();

      fireTab('created', tab);

      // 窗口 800x600，左侧栏 44 + 右侧栏 44 + 让出 288 → 网页宽 424（非零，可见）
      expect(tab.view.setBounds).toHaveBeenCalledWith(
        expect.objectContaining({ x: 44, width: 800 - 44 - 44 - 288, height: 600 - 48 }),
      );
    });
  });

  describe('tab removed', () => {
    it('should detach view for active tab and push removed event', () => {
      const tab = makeTab({ id: 12, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('created', tab);
      fireTab('removed', tab);

      expect(window.browserWindow.setBrowserView).toHaveBeenCalledWith(null);
      expect(window.browserWindow.webContents.send).toHaveBeenCalledWith(
        'tab:event',
        expect.objectContaining({ type: 'removed' }),
      );
    });
  });

  describe('tab crashed', () => {
    it('should push crashed event', () => {
      const tab = makeTab({ id: 13, windowId: 1 });
      tabManager.register(tab);
      install();

      fireTab('crashed', tab);

      expect(window.browserWindow.webContents.send).toHaveBeenCalledWith(
        'tab:event',
        expect.objectContaining({ type: 'crashed' }),
      );
    });
  });

  describe('window events', () => {
    it('should bind resize on existing windows', () => {
      const tab = makeTab({ id: 14, windowId: 1 });
      tabManager.register(tab);
      install();

      expect(window.browserWindow.on).toHaveBeenCalledWith('resize', expect.any(Function));
    });

    it('should re-attach active view on ready-to-show for new windows', () => {
      const tab = makeTab({ id: 14, windowId: 1 });
      tabManager.register(tab);
      install();

      const win2 = makeManagedWindow(2);
      const newWindow = makeBrowserWindow();
      win2.browserWindow = newWindow;
      windowManager.register(win2);

      const wcHandler = windowManager.listeners.get('window-created')!.find(() => true) as (
        id: number,
      ) => void;
      wcHandler(2);

      expect(newWindow.on).toHaveBeenCalledWith('resize', expect.any(Function));
      const readyHandler = newWindow.once.mock.calls.find((c) => c[0] === 'ready-to-show')?.[1] as
        (() => void) | undefined;
      expect(readyHandler).toBeDefined();

      readyHandler?.();
      expect(newWindow.setBrowserView).not.toHaveBeenCalled();
    });

    it('should listen for new window creation', () => {
      const tab = makeTab({ id: 15, windowId: 1 });
      tabManager.register(tab);
      install();

      const win2 = makeManagedWindow(2);
      const newWindow = makeBrowserWindow();
      win2.browserWindow = newWindow;
      windowManager.register(win2);

      const wcHandler = windowManager.listeners.get('window-created')!.find(() => true) as (
        id: number,
      ) => void;
      wcHandler(2);

      expect(newWindow.on).toHaveBeenCalledWith('resize', expect.any(Function));
      expect(newWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    });
  });

  describe('dispose', () => {
    it('should remove all listeners', () => {
      const tab = makeTab({ id: 16, windowId: 1 });
      tabManager.register(tab);
      install();

      handle.dispose();

      fireTab('created', tab);
      expect(window.browserWindow.webContents.send).not.toHaveBeenCalled();
      expect(tabManager.listeners.get('created')).toHaveLength(0);
      expect(tabManager.listeners.get('updated')).toHaveLength(0);
      expect(tabManager.listeners.get('activated')).toHaveLength(0);
      expect(tabManager.listeners.get('removed')).toHaveLength(0);
      expect(tabManager.listeners.get('crashed')).toHaveLength(0);
      expect(windowManager.listeners.get('window-created')).toHaveLength(0);
    });
  });
});
