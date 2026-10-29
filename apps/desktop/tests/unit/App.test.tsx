/**
 * App 组件单元测试
 *
 * 验证：
 * 1. 初始化时通过 tab.list 加载标签列表
 * 2. 右侧栏渲染标签 + 新建按钮
 * 3. 下侧地址栏渲染后退/前进/刷新 + Omnibox
 * 4. 点击新建标签触发 tab.create
 * 5. 点击关闭标签触发 tab.close
 * 6. 点击标签触发 tab.setActive
 * 7. 主题切换按钮可用
 * 8. 订阅 tab:event 推送并更新 UI
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { ThemeProvider } from '../../src/renderer/theme/theme-provider';

interface TabSnapshot {
  readonly id: number;
  readonly windowId: number;
  readonly url: string;
  readonly title: string;
  readonly favicon?: string;
  readonly active: boolean;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly crashed: boolean;
  readonly indexInWindow: number;
}

const mockInvoke = vi.fn();
const mockOn = vi.fn().mockReturnValue(() => undefined);
const mockOnMessagePort = vi.fn().mockReturnValue(() => undefined);
beforeEach(() => {
  mockInvoke.mockReset();
  mockOn.mockReset();
  mockOn.mockReturnValue(() => undefined);
  mockOnMessagePort.mockReset();
  mockOnMessagePort.mockReturnValue(() => undefined);
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke: mockInvoke,
      on: mockOn,
      onMessagePort: mockOnMessagePort,
      platform: 'win32',
      versions: { electron: '32.0.0', chrome: '128.0.0', node: '22.0.0' },
    },
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

function makeTab(overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id: 1,
    windowId: 1,
    url: 'about:blank',
    title: '新标签页',
    active: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    indexInWindow: 0,
    ...overrides,
  };
}

function renderApp() {
  return render(
    <ThemeProvider defaultTheme="light">
      <App />
    </ThemeProvider>,
  );
}

/**
 * 展开右侧栏（默认折叠态）。
 * 2026-08-14：底部折叠/展开按钮已移除，改为双击右侧边栏空白处展开/折叠。
 * 测试通过双击右侧栏（aside aria-label="右侧边栏"）模拟展开。
 */
async function expandRightSidebar(): Promise<void> {
  const sidebar = await screen.findByLabelText('右侧边栏');
  fireEvent.doubleClick(sidebar);
}

/** 取 App 最近一次注册的 ui.statusbar.action 监听（用于模拟悬浮层转发用户动作） */
function getStatusBarActionHandler(): (payload: unknown) => void {
  const call = [...mockOn.mock.calls].reverse().find((c) => c[0] === 'ui.statusbar.action');
  const handler = call?.[1] as ((payload: unknown) => void) | undefined;
  if (!handler) throw new Error('ui.statusbar.action handler not registered');
  return handler;
}

describe('App (Browser Shell)', () => {
  it('should load tabs via tab.list on mount', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 });
    });
  });

  it('should render right sidebar with tabs and new tab button', async () => {
    const tab = makeTab({ id: 1, title: 'Urchin 首页', url: 'https://urchin.dev' });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await expandRightSidebar();

    await waitFor(() => {
      expect(screen.getByText('Urchin 首页')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('新建标签')).toBeInTheDocument();
  });

  it('should sync status bar state with navigation flags (bottom bar moved to overlay)', async () => {
    const tab = makeTab({
      id: 1,
      url: 'https://urchin.dev',
      canGoBack: true,
      canGoForward: true,
    });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    // 底部状态栏已移至独立悬浮子窗口，主窗口不再渲染后退/前进/刷新按钮；
    // App 通过 ui.statusbar.sync 将导航可用性同步给悬浮层。
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.statusbar.sync',
        expect.objectContaining({ visible: true, canGoBack: true, canGoForward: true }),
      );
    });
    expect(screen.queryByLabelText('后退')).toBeNull();
    expect(screen.queryByLabelText('前进')).toBeNull();
    expect(screen.queryByLabelText('刷新')).toBeNull();
    // 主题切换仍在主窗口标题栏
    expect(screen.getByLabelText('切换主题')).toBeInTheDocument();
  });

  it('should call tab.create when new tab button clicked', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await expandRightSidebar();

    await waitFor(() => {
      expect(screen.getByLabelText('新建标签')).toBeInTheDocument();
    });

    mockInvoke.mockClear();
    fireEvent.click(screen.getByLabelText('新建标签'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://newtab',
        active: true,
        workspaceId: 'default',
      });
    });
  });

  it('should call tab.close when close button clicked', async () => {
    const tab = makeTab({ id: 5, title: '关闭我' });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await expandRightSidebar();

    await waitFor(() => {
      expect(screen.getByText('关闭我')).toBeInTheDocument();
    });

    mockInvoke.mockClear();
    fireEvent.click(screen.getByLabelText('关闭标签'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.close', { tabId: 5 });
    });
  });

  it('should close tab on double-click of expanded tab card', async () => {
    const tab = makeTab({ id: 5, title: '双击关闭我' });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();
    await expandRightSidebar();
    await waitFor(() => expect(screen.getByText('双击关闭我')).toBeInTheDocument());

    mockInvoke.mockClear();
    fireEvent.doubleClick(screen.getByText('双击关闭我'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.close', { tabId: 5 });
    });
  });

  it('should close tab on double-click of collapsed tab icon', async () => {
    const tab = makeTab({ id: 7, title: '折叠图标', url: 'https://example.com/7' });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();
    // 默认折叠态：图标按钮 aria-label="切换到标签 折叠图标"
    await waitFor(() => expect(screen.getByLabelText('切换到标签 折叠图标')).toBeInTheDocument());

    mockInvoke.mockClear();
    fireEvent.doubleClick(screen.getByLabelText('切换到标签 折叠图标'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.close', { tabId: 7 });
    });
  });

  it('should call tab.setActive when tab clicked', async () => {
    const tab1 = makeTab({ id: 1, active: true, title: 'Tab 1' });
    const tab2 = makeTab({ id: 2, active: false, title: 'Tab 2', indexInWindow: 1 });
    mockInvoke.mockResolvedValue({ tabs: [tab1, tab2] });

    renderApp();

    await expandRightSidebar();

    await waitFor(() => {
      expect(screen.getByText('Tab 2')).toBeInTheDocument();
    });

    mockInvoke.mockClear();
    fireEvent.click(screen.getByText('Tab 2'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.setActive', { tabId: 2 });
    });
  });

  describe('标签拖出窗口（自定义拖拽 → 新窗口打开 + 移动语义）', () => {
    it('should open tab url in new window at drop position and close original tab', async () => {
      const tab = makeTab({ id: 1, url: 'https://example.com', title: '示例' });
      mockInvoke.mockResolvedValue({ tabs: [tab] });

      renderApp();
      await expandRightSidebar();
      await waitFor(() => expect(screen.getByText('示例')).toBeInTheDocument());

      const card = screen.getByText('示例').closest('[data-tab-card]');
      expect(card).not.toBeNull();
      // 内部页恒 draggable=false：拖拽走自定义指针事件，不走系统拖放
      expect(card).toHaveAttribute('draggable', 'false');

      mockInvoke.mockClear();
      fireEvent.pointerDown(card!, { pointerId: 1, clientX: 200, clientY: 300 });
      // 指针移出窗口边界（clientX<0）→ 新窗口打开（定位到出界屏幕坐标）+ 关闭原标签
      fireEvent.pointerMove(card!, {
        pointerId: 1,
        clientX: -10,
        clientY: 300,
        screenX: 500,
        screenY: 260,
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('window.createWithUrl', {
          url: 'https://example.com',
          x: 500,
          y: 260,
          workspaceId: 'default',
        });
      });
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('tab.close', { tabId: 1 });
      });
    });

    it('should not open new window when pointer stays inside window', async () => {
      const tab = makeTab({ id: 1, url: 'https://example.com', title: '示例' });
      mockInvoke.mockResolvedValue({ tabs: [tab] });

      renderApp();
      await expandRightSidebar();
      await waitFor(() => expect(screen.getByText('示例')).toBeInTheDocument());

      const card = screen.getByText('示例').closest('[data-tab-card]')!;
      mockInvoke.mockClear();
      fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 300 });
      fireEvent.pointerMove(card, { pointerId: 1, clientX: 210, clientY: 300 });
      fireEvent.pointerUp(card, { pointerId: 1, clientX: 210, clientY: 300 });

      expect(mockInvoke).not.toHaveBeenCalledWith('window.createWithUrl', expect.anything());
      expect(mockInvoke).not.toHaveBeenCalledWith('tab.close', expect.anything());
    });

    it('should not drag internal pages out of window', async () => {
      const tab = makeTab({ id: 1, url: 'urchin://newtab', title: '新标签页' });
      mockInvoke.mockResolvedValue({ tabs: [tab] });

      renderApp();
      await expandRightSidebar();
      await waitFor(() => expect(screen.getByText('新标签页')).toBeInTheDocument());

      const card = screen.getByText('新标签页').closest('[data-tab-card]')!;
      mockInvoke.mockClear();
      fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 300 });
      fireEvent.pointerMove(card, {
        pointerId: 1,
        clientX: -10,
        clientY: 300,
        screenX: 500,
        screenY: 260,
      });
      fireEvent.pointerUp(card, { pointerId: 1, clientX: -10, clientY: 300 });

      expect(mockInvoke).not.toHaveBeenCalledWith('window.createWithUrl', expect.anything());
      expect(mockInvoke).not.toHaveBeenCalledWith('tab.close', expect.anything());
    });
  });

  it('should subscribe to tab:event channel', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      // TP7：App 还订阅 workspace:changed，这里断言 tab:event 一定在订阅列表中
      expect(mockOn.mock.calls.some(([c]) => c === 'tab:event')).toBe(true);
    });
  });

  it('should subscribe to workspace:changed channel (TP7)', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      expect(mockOn.mock.calls.some(([c]) => c === 'workspace:changed')).toBe(true);
    });
  });

  it('should toggle theme when theme button clicked', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      expect(screen.getByLabelText('切换主题')).toBeInTheDocument();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(screen.getByLabelText('切换主题'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByLabelText('切换主题'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('should disable back/forward/reload when no active tab', async () => {
    mockInvoke.mockResolvedValue({ tabs: [] });

    renderApp();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 });
    });

    // 无活跃标签时，同步给悬浮层的导航可用性应为 false
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.statusbar.sync',
        expect.objectContaining({ canGoBack: false, canGoForward: false, reloadDisabled: true }),
      );
    });
  });

  it('should handle tab.list failure gracefully', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC error'));

    renderApp();

    // 即使 tab.list 失败，UI 仍应渲染（无崩溃），右侧边栏仍可交互（双击展开/折叠）
    await waitFor(() => {
      expect(screen.getByLabelText('右侧边栏')).toBeInTheDocument();
    });
  });

  // ── AI 入口：创建 urchin://ai 标签页 ──

  it('should create ai tab via left sidebar AI button', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'window.getCurrent') return Promise.resolve({ windowId: 1 });
      if (channel === 'tab.create') {
        return Promise.resolve({ tab: makeTab({ id: 2, url: 'urchin://ai', title: 'AI 助手' }) });
      }
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('AI 助手'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://ai',
        active: true,
      }),
    );
  });

  // ── 设置入口：创建 urchin://settings 标签页 ──

  it('should create settings tab when none exists', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'window.getCurrent') return Promise.resolve({ windowId: 1 });
      if (channel === 'tab.create') {
        return Promise.resolve({
          tab: makeTab({ id: 2, url: 'urchin://settings', title: '设置' }),
        });
      }
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('设置'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://settings',
        active: true,
      }),
    );
  });

  // ── GenOffice 文档入口：创建 urchin://genoffice-home 标签页（阶段 4.5） ──

  it('should create GenOffice home tab via left sidebar entry', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'window.getCurrent') return Promise.resolve({ windowId: 1 });
      if (channel === 'tab.create') {
        return Promise.resolve({
          tab: makeTab({ id: 2, url: 'urchin://genoffice-home', title: 'GenOffice 文档' }),
        });
      }
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('GenOffice 文档'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://genoffice-home',
        active: true,
      }),
    );
  });

  // ── 书签 toggle：创建 + 删除 ──

  it('should create bookmark via star toggle', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ url: 'https://example.com', title: 'Example' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'bookmark.create') return Promise.resolve({ ok: true });
      if (channel === 'ui.panel.saveBookmarkPicker') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 悬浮层点击书签按钮 → ui.statusbar.action bookmark-toggle
    // dev.120：未收藏时不再直接 bookmark.create，改为弹出收藏夹面板 picker 模式选文件夹保存
    act(() => getStatusBarActionHandler()({ type: 'bookmark-toggle' }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ui.panel.saveBookmarkPicker', {}));
    // 不应直接 create（保存由面板内完成）
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'bookmark.create',
      expect.objectContaining({ url: 'https://example.com' }),
    );
  });

  it('should delete bookmark when already saved', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ url: 'https://example.com', title: 'Example' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') {
        // 当前 URL 已收藏
        return Promise.resolve({
          bookmarks: [{ id: 'b1', title: 'Example', url: 'https://example.com' }],
        });
      }
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'bookmark.delete') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    // 等收藏状态刷新完成（bookmark.search 返回已收藏 → sync.bookmarkSaved=true）
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.statusbar.sync',
        expect.objectContaining({ bookmarkSaved: true }),
      ),
    );

    act(() => getStatusBarActionHandler()({ type: 'bookmark-toggle' }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('bookmark.delete', { id: 'b1' }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.statusbar.sync',
        expect.objectContaining({
          toast: expect.objectContaining({ text: '已从书签移除' }) as object,
        }),
      ),
    );
  });

  // ── 下一个测试 ──

  // ── tab:event 推送分支：created / updated / removed / crashed ──

  it('should add new tab on created event', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    await expandRightSidebar();

    // 触发 tab:event created
    const tabEventHandler = mockOn.mock.calls.find((c) => c[0] === 'tab:event')?.[1] as
      ((payload: unknown) => void) | undefined;
    expect(tabEventHandler).toBeDefined();
    act(() => {
      tabEventHandler!({
        type: 'created',
        snapshot: makeTab({ id: 2, url: 'https://new.example', title: 'New', active: true }),
      });
    });

    // 新标签出现在右侧栏
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
  });

  it('should prepend new tab on created event (newest on top, LIFO sidebar)', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: 'Old', active: true })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    await expandRightSidebar();

    const tabEventHandler = mockOn.mock.calls.find((c) => c[0] === 'tab:event')?.[1] as
      ((payload: unknown) => void) | undefined;
    act(() => {
      tabEventHandler!({
        type: 'created',
        snapshot: makeTab({ id: 2, url: 'https://new.example', title: 'New', active: true }),
      });
    });

    // 新建标签（id 2）应排在旧标签（id 1）上方：New 在 DOM 中先于 Old
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy());
    const newEl = screen.getByText('New');
    const oldEl = screen.getByText('Old');
    expect(newEl.compareDocumentPosition(oldEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('should update and remove tabs on updated/removed events', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({ tabs: [makeTab({ id: 1, title: 'Old' })] });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    await expandRightSidebar();

    const tabEventHandler = mockOn.mock.calls.find((c) => c[0] === 'tab:event')?.[1] as
      ((payload: unknown) => void) | undefined;

    // updated：标题变化
    act(() => {
      tabEventHandler!({
        type: 'updated',
        snapshot: makeTab({ id: 1, title: 'Renamed', loading: false }),
      });
    });
    await waitFor(() => expect(screen.getByText('Renamed')).toBeTruthy());

    // removed：标签移除
    act(() => {
      tabEventHandler!({ type: 'removed', snapshot: makeTab({ id: 1, title: 'Renamed' }) });
    });
    await waitFor(() => expect(screen.getByText('暂无标签页')).toBeTruthy());
  });

  it('should fall back to homepage and navigate by creating tab when last active tab removed', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: 'One', url: 'https://example.com' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    const tabEventHandler = mockOn.mock.calls.find((c) => c[0] === 'tab:event')?.[1] as
      ((payload: unknown) => void) | undefined;

    // 关闭最后一个激活标签 → activeTabId 清空，ContentArea 回落主页
    act(() => {
      tabEventHandler!({ type: 'removed', snapshot: makeTab({ id: 1, active: true }) });
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Urchin Browser' })).toBeInTheDocument(),
    );

    // 无激活标签时导航（主页按钮）→ 新建标签，而非对已删除 tab 调 loadUrl
    fireEvent.click(screen.getByLabelText('主页'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://newtab',
        active: true,
      }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith('tab.loadUrl', expect.anything());
  });

  // ── 跨站跳转开新标签：站内导航当前标签，跨站新建 ──

  it('should open homepage in a NEW tab via home button (never overwrite website tab)', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: 'News', url: 'https://news.baidu.com/' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 当前标签是网站（news.baidu.com）→ 点主页按钮 → 新建主页标签（不原地跳转）
    fireEvent.click(screen.getByLabelText('主页'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'urchin://newtab',
        active: true,
      }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith('tab.loadUrl', expect.anything());
  });

  it('should not create duplicate homepage when current tab is already homepage', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: '主页', url: 'urchin://newtab' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: [] });
      if (channel === 'history.list') {
        return Promise.resolve({ entries: [] });
      }
      return Promise.resolve({});
    });
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('主页'));
    // 已在主页：不重复创建主页标签
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'tab.create',
      expect.objectContaining({ url: 'urchin://newtab' }),
    );
  });

  it('should convert homepage placeholder to website tab when clicking homepage card', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: '主页', url: 'urchin://newtab' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: [] });
      if (channel === 'history.list') {
        return Promise.resolve({
          entries: [{ url: 'https://github.com', title: 'GitHub', visitedAt: 100 }],
        });
      }
      return Promise.resolve({});
    });
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 当前标签是主页占位（urchin://newtab）→ 点击最近浏览卡片 → 主页就地转为网站标签
    await waitFor(() => expect(screen.getByText('GitHub')).toBeInTheDocument());
    fireEvent.click(screen.getByText('GitHub'));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.loadUrl', {
        tabId: 1,
        url: 'https://github.com',
      }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith('tab.create', expect.anything());
  });

  it('should navigate in current tab from address bar (no new tab for every input)', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ id: 1, title: 'A', url: 'https://a.com/' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 悬浮层地址栏导航 → ui.statusbar.action navigate（当前标签导航，不新建标签）
    act(() => getStatusBarActionHandler()({ type: 'navigate', url: 'https://b.com' }));

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('tab.loadUrl', {
        tabId: 1,
        url: 'https://b.com',
      }),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith('tab.create', {
      windowId: 1,
      url: 'https://b.com',
      active: true,
    });
  });

  it('should mark crashed tab with error icon', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({ tabs: [makeTab({ id: 1, title: 'Crashy' })] });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    await expandRightSidebar();

    const tabEventHandler = mockOn.mock.calls.find((c) => c[0] === 'tab:event')?.[1] as
      ((payload: unknown) => void) | undefined;

    act(() => {
      tabEventHandler!({
        type: 'crashed',
        snapshot: makeTab({ id: 1, title: 'Crashy', crashed: true }),
      });
    });
    // crashed 状态更新不崩溃，标签仍渲染
    expect(screen.getByText('Crashy')).toBeTruthy();
  });

  // ── 右侧边栏宽度拖拽调节 + 持久化 ──

  it('should resize right sidebar via drag handle and persist width', async () => {
    // jsdom 无 PointerEvent capture，stub 掉
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    });

    mockInvoke.mockImplementation((channel: string, req: unknown) => {
      const reqOf = <T,>(): T => req as T;
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') {
        const req = reqOf<{ key?: string }>();
        if (req?.key === 'ui.rightSidebarWidth') return Promise.resolve({ value: null }); // 无持久化宽度 → 默认 360
        return Promise.resolve({ value: 300 });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      if (channel === 'ui.layout.setState') return Promise.resolve({});
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    await expandRightSidebar();

    // 找到宽度调节手柄（展开态渲染）
    const handle = screen.getByLabelText('调节右侧栏宽度');
    expect(handle).toBeTruthy();

    // 模拟拖拽：起点 x=500，向左拖 80px → 栏变宽 80
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 420 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 420 });

    // 释放时持久化宽度（默认 360 + 拖拽量）
    const setCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'settings.set');
    expect(setCalls.length).toBeGreaterThan(0);
    const persisted = setCalls[setCalls.length - 1]?.[1] as { key: string; value: number };
    expect(persisted.key).toBe('ui.rightSidebarWidth');
    expect(persisted.value).toBe(440); // 默认 360 + 向左拖 80
    // 拖拽过程通知主进程布局
    const layoutCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'ui.layout.setState');
    expect(layoutCalls.some((c) => (c[1] as { rightWidth?: number }).rightWidth === 440)).toBe(
      true,
    );

    // 回归（2026-08-14）：折叠后再次展开，布局宽度必须用拖拽后的实际宽度（440）
    // 而非固定 RIGHT_EXPANDED（360）——否则主进程 BrowserView 布局与栏显示不一致，
    // 网页滚动条与分割线间出现空白。
    mockInvoke.mockClear();
    fireEvent.doubleClick(screen.getByLabelText('右侧边栏')); // 折叠
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.layout.setState',
        expect.objectContaining({ rightWidth: 44 }),
      ),
    );
    mockInvoke.mockClear();
    fireEvent.doubleClick(screen.getByLabelText('右侧边栏')); // 再展开
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.layout.setState',
        expect.objectContaining({ rightWidth: 440 }),
      ),
    );
  });
});

describe('App right sidebar auto-expand + collapsed icons', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => undefined,
    });
  });

  function setup(tabs: TabSnapshot[], autoExpand: boolean | null = null) {
    // settings.get 按 key 区分：自动展开开关用参数、宽度无持久化、hoverDelay 300
    mockInvoke.mockImplementation((channel: string, req: { key?: string }) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') {
        if (req?.key === 'ui.rightSidebarAutoExpand') {
          return Promise.resolve({ value: autoExpand });
        }
        if (req?.key === 'ui.rightSidebarWidth') return Promise.resolve({ value: null });
        return Promise.resolve({ value: 300 });
      }
      return Promise.resolve({});
    });
  }

  it('should show collapsed tab icons without title when sidebar collapsed', async () => {
    setup([
      {
        id: 1,
        windowId: 1,
        url: 'https://a.com',
        title: 'Alpha',
        active: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        indexInWindow: 0,
      },
      {
        id: 2,
        windowId: 1,
        url: 'https://b.com',
        title: 'Beta',
        active: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        indexInWindow: 1,
      },
    ]);
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 折叠态：显示图标按钮（aria-label 含切换到标签），不显示标题文本
    await waitFor(() => expect(screen.getByLabelText('切换到标签 Alpha')).toBeInTheDocument());
    expect(screen.getByLabelText('切换到标签 Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull(); // 折叠不显示名称
  });

  it('should not auto-expand on hover when setting disabled', async () => {
    setup([makeTab({ id: 1, title: 'One' })], false);
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 模拟鼠标悬停折叠栏（应不触发展开）
    const sidebar = screen.getByLabelText('切换到标签 One').closest('aside')!;
    fireEvent.mouseEnter(sidebar);
    await new Promise((r) => setTimeout(r, 400)); // 超过默认 300ms 延迟
    // 自动展开被禁用 → 仍处于折叠（无折叠按钮、标题未显示）
    expect(screen.queryByLabelText('折叠右侧栏')).toBeNull();
    expect(screen.queryByText('One')).toBeNull();
  });

  it('should auto-expand on hover when setting enabled (default)', async () => {
    setup([makeTab({ id: 1, title: 'One' })], true);
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    const sidebar = screen.getByLabelText('切换到标签 One').closest('aside')!;
    fireEvent.mouseEnter(sidebar);
    await new Promise((r) => setTimeout(r, 400));
    // 自动展开 → 标题可见
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());
  });
});

describe('App right sidebar double-click toggle (替代底部按钮)', () => {
  function setupTabs() {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({ tabs: [makeTab({ id: 1, title: 'One' })] });
      }
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      return Promise.resolve({});
    });
  }

  it('should expand sidebar on double-click', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    const sidebar = screen.getByLabelText('右侧边栏');
    fireEvent.doubleClick(sidebar);
    // 展开 → 标签标题可见
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());
  });

  it('should collapse sidebar on double-click when expanded', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    const sidebar = screen.getByLabelText('右侧边栏');
    fireEvent.doubleClick(sidebar); // 展开
    await waitFor(() => expect(screen.getByText('One')).toBeInTheDocument());
    fireEvent.doubleClick(sidebar); // 折叠
    await waitFor(() => expect(screen.queryByText('One')).toBeNull());
  });

  it('should not render bottom toggle button', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    // 底部折叠/展开按钮已移除
    expect(screen.queryByLabelText('折叠右侧栏')).toBeNull();
    expect(screen.queryByLabelText('展开右侧栏')).toBeNull();
  });
});

describe('App window drag via sidebars', () => {
  function setupTabs() {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({ tabs: [makeTab({ id: 1, title: 'One' })] });
      }
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      return Promise.resolve({});
    });
  }

  it('should send ui.window.dragBy when dragging sidebar blank area beyond threshold', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    const sidebar = screen.getByLabelText('右侧边栏');

    // 按下（起点 screenX/Y）+ 移动超过 3px 阈值 → 发 dragBy
    fireEvent.pointerDown(sidebar, { pointerId: 1, screenX: 100, screenY: 100, bubbles: true });
    fireEvent.pointerMove(sidebar, { pointerId: 1, screenX: 140, screenY: 130, bubbles: true });
    fireEvent.pointerUp(sidebar, { pointerId: 1, bubbles: true });

    expect(mockInvoke).toHaveBeenCalledWith('ui.window.dragBy', { dx: 40, dy: 30 });
  });

  it('should not drag window on small movement below threshold (click/double-click preserved)', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    const sidebar = screen.getByLabelText('右侧边栏');

    fireEvent.pointerDown(sidebar, { pointerId: 1, screenX: 100, screenY: 100, bubbles: true });
    fireEvent.pointerMove(sidebar, { pointerId: 1, screenX: 101, screenY: 101, bubbles: true });
    fireEvent.pointerUp(sidebar, { pointerId: 1, bubbles: true });

    expect(mockInvoke).not.toHaveBeenCalledWith('ui.window.dragBy', expect.anything());
  });

  it('should not drag window when starting on an interactive element', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    // 左侧栏顶部展开按钮（交互元素）
    const toggleBtn = screen.getByLabelText('展开左侧栏');
    fireEvent.pointerDown(toggleBtn, { pointerId: 1, screenX: 0, screenY: 0, bubbles: true });
    fireEvent.pointerMove(toggleBtn, { pointerId: 1, screenX: 100, screenY: 100, bubbles: true });
    fireEvent.pointerUp(toggleBtn, { pointerId: 1, bubbles: true });

    expect(mockInvoke).not.toHaveBeenCalledWith('ui.window.dragBy', expect.anything());
  });

  it('should clear stuck drag state when pointerup missed the sidebar (window-level backup)', async () => {
    setupTabs();
    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));
    const sidebar = screen.getByLabelText('右侧边栏');

    // 拖窗过程中指针移出窗口：pointerup 未派发给侧边栏元素，而是落在 window 上
    fireEvent.pointerDown(sidebar, { pointerId: 1, screenX: 100, screenY: 100, bubbles: true });
    fireEvent.pointerMove(sidebar, { pointerId: 1, screenX: 160, screenY: 140, bubbles: true });
    expect(mockInvoke).toHaveBeenCalledWith('ui.window.dragBy', { dx: 60, dy: 40 });
    fireEvent.pointerUp(window, { pointerId: 1, bubbles: true });

    // 拖拽状态已清理：不再继续发 dragBy，且后续新拖拽正常工作
    fireEvent.pointerMove(sidebar, { pointerId: 1, screenX: 170, screenY: 150, bubbles: true });
    const dragByCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'ui.window.dragBy').length;
    expect(dragByCalls).toBe(1);

    fireEvent.pointerDown(sidebar, { pointerId: 1, screenX: 200, screenY: 200, bubbles: true });
    fireEvent.pointerMove(sidebar, { pointerId: 1, screenX: 250, screenY: 220, bubbles: true });
    fireEvent.pointerUp(sidebar, { pointerId: 1, bubbles: true });
    expect(mockInvoke).toHaveBeenCalledWith('ui.window.dragBy', { dx: 50, dy: 20 });
  });
});
