/**
 * BrowserView ���ڼ��ɣ�installTabViewIntegration����Ԫ����
 *
 * ��֤��
 * 1. ��װ���� created/updated/activated/removed/crashed �¼����ŽӴ��ڲ���
 * 2. created ��Ծ tab��setBrowserView + ǿ�� setBounds + pushEvent
 * 3. updated��URL �仯ʱ���� bounds��16ms �����ϲ�����
 * 4. activated���л� setBrowserView + ǿ�� setBounds + pushEvent
 * 5. removed��ж�ػ�Ծ tab �� view + ���� URL ����
 * 6. crashed��pushEvent
 * 7. �ڲ� URL��urchin://settings / urchin://ai���� ZERO_BOUNDS
 * 8. browserViewHidden �� ZERO_BOUNDS
 * 9. computeViewBounds��������/�Ҳ����������²����߶�
 * 10. getLayoutState / setLayoutState������״̬��д + contentHidden ����
 * 11. dispose ж�����м���
 * 12. ���� resize / ready-to-show �¼���
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
  contentView: {
    addChildView: ReturnType<typeof vi.fn>;
    removeChildView: ReturnType<typeof vi.fn>;
  };
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
  htmlFullscreen?: boolean;
  viewKind?: string;
  view: FakeView;
}

/** ���¼�������������ģ�� TabManager / WindowManager */
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
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
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
    htmlFullscreen: false,
    view: { setBounds: vi.fn() },
    ...overrides,
  };
}

/** ���� tab ������ mock���ڲ����¼��������� */
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

/** �������ڹ����� mock */
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

/** ���� TabManager �¼� */
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
        devtoolsWidth: 0,
      });
    });

    it('should update only provided fields and include contentHidden', () => {
      const next = setLayoutState({ leftWidth: 200, rightWidth: 300, bottomHeight: 100 });

      expect(next).toEqual({
        leftWidth: 200,
        rightWidth: 300,
        bottomHeight: 100,
        browserViewHidden: false,
        contentHidden: false,
        devtoolsWidth: 0,
      });
      expect(getLayoutState().leftWidth).toBe(200);
    });

    it('should accept devtoolsWidth (M15 一期新增)', () => {
      const next = setLayoutState({ devtoolsWidth: 360 });
      expect(next.devtoolsWidth).toBe(360);
      expect(getLayoutState().devtoolsWidth).toBe(360);
      // computeViewBounds 据此扣减（在几何测试中验证）
      setLayoutState({ devtoolsWidth: 0 });
    });

    it('should ignore contentHidden and accept browserViewHidden', () => {
      const next = setLayoutState({ contentHidden: true, browserViewHidden: true });
      expect(next.contentHidden).toBe(false);
      expect(next.browserViewHidden).toBe(true);

      const state = getLayoutState();
      expect(state.browserViewHidden).toBe(true);
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
        expect.objectContaining({ x: 52, y: 40, width: 800 - 104, height: 600 - 48 - 6 }),
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
        expect.objectContaining({ y: 40, width: 800 - 104, height: 600 - 48 - 6 }),
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

  describe('tab removed while another active (�ر�����/AI ��ǩ�ع�)', () => {
    it('should keep next tab BrowserView attached after removing active tab', () => {
      // 2026-08-14 �޸���remove() �ȷ� removed �� activated������ onRemoved ��
      // setBrowserView(null) �Ѹռ������һ����ҳ view ж�أ���ҳ����ʾ����
      const tab1 = makeTab({ id: 21, windowId: 1, active: true });
      const tab2 = makeTab({ id: 22, windowId: 1, active: false });
      tabManager.register(tab1);
      tabManager.register(tab2);
      install();

      fireTab('created', tab1);
      fireTab('created', tab2);
      window.browserWindow.setBrowserView.mockClear();

      // �Ƴ���Ծ tab1��ģ��ر�����/AI ��ǩ���� TabManager �Զ����� tab2
      tabManager.emit('removed', tab1 as never);
      tabManager.emit('activated', tab2 as never);

      // �ؼ���removed��ж�ؾ� view����ǰ��activated������ tab2���ں�
      // ����״̬�� tab2 �� view ���أ�δ������ null ж�ظ��ǣ���
      const calls = window.browserWindow.setBrowserView.mock.calls;
      // ���һ�ε��ñ����ǹ��� tab2������ null ж�أ�
      expect(calls[calls.length - 1]?.[0]).toBe(tab2.view);
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

describe('HTML5 fullscreen (��Ƕ��Ƶȫ������ UI ��)', () => {
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
    });
    handle = undefined as never;
  });

  it('should fill entire window when tab is htmlFullscreen', () => {
    const tab = makeTab({ id: 31, windowId: 1, htmlFullscreen: true });
    tabManager.register(tab);
    install();

    fireTab('created', tab);
    fireTab('updated', tab);

    // ���� 800x600 �� BrowserView ����������������x:0, y:0, ȫ��ȫ�ߣ������� UI ��
    expect(tab.view.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('should restore normal bounds after leaving fullscreen', () => {
    const tab = makeTab({ id: 32, windowId: 1 });
    tabManager.register(tab);
    install();

    fireTab('created', tab);
    tab.view.setBounds.mockClear();

    tab.htmlFullscreen = true;
    fireTab('updated', tab);
    expect(tab.view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 });

    tab.view.setBounds.mockClear();
    tab.htmlFullscreen = false;
    fireTab('updated', tab);
    // �ָ����沼�֣��� 8px ���32px �����������Ҳ�����ײ���ַ��������
    expect(tab.view.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: 52, y: 40, width: 800 - 104, height: 600 - 48 - 6 }),
    );
  });

  describe('GenOffice �༭����ͼ���أ��׶� 2��', () => {
    it('should mount editor view via contentView and release the browser view', () => {
      const tab = makeTab({ id: 41, windowId: 1, viewKind: 'genoffice' });
      tabManager.register(tab);
      install();

      fireTab('created', tab);

      expect(window.browserWindow.setBrowserView).toHaveBeenCalledWith(null);
      expect(window.browserWindow.contentView.addChildView).toHaveBeenCalledWith(tab.view);
      expect(tab.view.setBounds).toHaveBeenCalledWith(
        // GenOffice ��ǩ��ַ�����أ���ͼ����������ȫ���߶ȣ��Կ�������������
        expect.objectContaining({ x: 52, y: 40, width: 800 - 104, height: 600 - 48 - 6 }),
      );
    });

    it('should unmount editor view and restore browser view on activation switch', () => {
      const editorTab = makeTab({
        id: 42,
        windowId: 1,
        url: 'urchin://genoffice/?kind=markdown&path=x',
        viewKind: 'genoffice',
      });
      const webTab = makeTab({ id: 43, windowId: 1, active: false });
      tabManager.register(editorTab);
      tabManager.register(webTab);
      install();

      fireTab('created', editorTab);
      expect(window.browserWindow.contentView.addChildView).toHaveBeenCalledWith(editorTab.view);

      webTab.active = true;
      editorTab.active = false;
      fireTab('activated', webTab);

      expect(window.browserWindow.contentView.removeChildView).toHaveBeenCalledWith(editorTab.view);
      expect(window.browserWindow.setBrowserView).toHaveBeenCalledWith(webTab.view);
    });

    it('should give genoffice views real bounds even for renderer-managed urls (shell Home)', () => {
      // �ع飨2026-09-21 �û�ʵ���������urchin://genoffice-home ͬʱ�� React ����
      // ҳ��ַ����ǰ�� isRendererManagedUrl ���� �� shell Home ��ͼ���ص����ɼ���
      const tab = makeTab({
        id: 45,
        windowId: 1,
        url: 'urchin://genoffice-home',
        viewKind: 'genoffice',
      });
      tabManager.register(tab);
      install();

      fireTab('created', tab);

      expect(tab.view.setBounds).toHaveBeenCalledWith(
        // GenOffice ��ǩ��ַ�����أ���ͼ����������ȫ���߶ȣ��Կ�������������
        expect.objectContaining({ x: 52, y: 40, width: 800 - 104, height: 600 - 48 - 6 }),
      );
      expect(tab.view.setBounds).not.toHaveBeenCalledWith({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    });

    it('should remove mounted editor view when the active editor tab closes', () => {
      const editorTab = makeTab({ id: 44, windowId: 1, viewKind: 'genoffice' });
      tabManager.register(editorTab);
      install();

      fireTab('created', editorTab);
      fireTab('removed', editorTab);

      expect(window.browserWindow.contentView.removeChildView).toHaveBeenCalledWith(editorTab.view);
    });
  });
});
