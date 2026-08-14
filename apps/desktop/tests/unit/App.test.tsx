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
 * 侧边栏启动默认折叠，需点击「展开右侧栏」按钮后才能看到标签列表与新建按钮。
 * 折叠态下有两个「展开右侧栏」按钮（中部图标 + 底部切换），点击任意一个即可。
 */
async function expandRightSidebar(): Promise<void> {
  const expandBtns = await screen.findAllByLabelText('展开右侧栏');
  fireEvent.click(expandBtns[0]!);
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

  it('should render bottom bar with navigation buttons and theme toggle', async () => {
    const tab = makeTab({ id: 1, url: 'https://urchin.dev' });
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      expect(screen.getByLabelText('后退')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('前进')).toBeInTheDocument();
    expect(screen.getByLabelText('刷新')).toBeInTheDocument();
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
        url: 'about:blank',
        active: true,
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

  it('should subscribe to tab:event channel', async () => {
    const tab = makeTab();
    mockInvoke.mockResolvedValue({ tabs: [tab] });

    renderApp();

    await waitFor(() => {
      expect(mockOn).toHaveBeenCalled();
      expect(mockOn.mock.calls[0]?.[0]).toBe('tab:event');
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

    expect(screen.getByLabelText('后退')).toBeDisabled();
    expect(screen.getByLabelText('前进')).toBeDisabled();
    expect(screen.getByLabelText('刷新')).toBeDisabled();
  });

  it('should handle tab.list failure gracefully', async () => {
    mockInvoke.mockRejectedValue(new Error('IPC error'));

    renderApp();

    // 即使 tab.list 失败，UI 仍应渲染（无崩溃），侧边栏展开按钮仍可用
    await waitFor(() => {
      expect(screen.getAllByLabelText('展开右侧栏').length).toBeGreaterThan(0);
    });
  });

  // ── 左侧栏：展开加载摘要树 + 打开文档 ──

  it('should load summary tree when left sidebar expanded and open doc on click', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ url: 'https://example.com', title: 'Example' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'summary.listTree') {
        return Promise.resolve({
          tree: [
            {
              type: 'directory' as const,
              name: '2026-08',
              relativePath: '2026-08',
              children: [
                {
                  type: 'file' as const,
                  name: 'article.html',
                  relativePath: '2026-08/article.html',
                  absolutePath: 'C:\\summaries\\2026-08\\article.html',
                },
              ],
            },
          ],
          rootPath: 'C:\\summaries',
        });
      }
      if (channel === 'summary.open') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    // 点击展开左侧栏
    fireEvent.click(screen.getByLabelText('展开左侧栏'));

    // 展开后触发 summary.listTree 加载，渲染目录树
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('summary.listTree', {}));
    await waitFor(() => expect(screen.getByText('2026-08')).toBeTruthy());

    // 点击文件节点 → summary.open
    fireEvent.click(screen.getByText('article.html'));
    expect(mockInvoke).toHaveBeenCalledWith('summary.open', {
      absolutePath: 'C:\\summaries\\2026-08\\article.html',
    });
  });

  // ── AI 入口：创建 urchin://ai 标签页 ──

  it('should create ai tab via left sidebar AI button', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'tab.create') {
        return Promise.resolve({ tab: makeTab({ id: 2, url: 'urchin://ai', title: 'AI 助手' }) });
      }
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('AI 助手'));
    expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
      windowId: 1,
      url: 'urchin://ai',
      active: true,
    });
  });

  // ── 设置入口：创建 urchin://settings 标签页 ──

  it('should create settings tab when none exists', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') return Promise.resolve({ tabs: [makeTab()] });
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
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
    expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
      windowId: 1,
      url: 'urchin://settings',
      active: true,
    });
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
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('收藏到书签'));
    expect(mockInvoke).toHaveBeenCalledWith('bookmark.create', {
      url: 'https://example.com',
      title: 'Example',
      type: 'bookmark',
    });
    // toast
    await waitFor(() => expect(screen.getByText('已添加到书签')).toBeTruthy());
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
    // 等收藏状态刷新完成（bookmark.search 返回已收藏）
    await waitFor(() => expect(screen.getByLabelText('已收藏')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('已收藏'));
    expect(mockInvoke).toHaveBeenCalledWith('bookmark.delete', { id: 'b1' });
    await waitFor(() => expect(screen.getByText('已从书签移除')).toBeTruthy());
  });

  // ── 摘要（AI 助手）：summary.run ──

  it('should run summary extraction and show toast', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'tab.list') {
        return Promise.resolve({
          tabs: [makeTab({ url: 'https://example.com', title: 'Example' })],
        });
      }
      if (channel === 'bookmark.list') return Promise.resolve({ bookmarks: [] });
      if (channel === 'bookmark.search') return Promise.resolve({ bookmarks: [] });
      if (channel === 'settings.get') return Promise.resolve({ value: 300 });
      if (channel === 'summary.run') {
        return Promise.resolve({
          filePath: 'C:\\summaries\\a.html',
          relativePath: 'a.html',
          documentTitle: 'Example 摘要',
        });
      }
      return Promise.resolve({});
    });

    renderApp();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 }));

    fireEvent.click(screen.getByLabelText('提取网页内容并保存'));
    expect(mockInvoke).toHaveBeenCalledWith('summary.run', { tabId: 1 });
    await waitFor(() => expect(screen.getByText('已保存：Example 摘要')).toBeTruthy());
  });

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
    fireEvent.click(screen.getByLabelText('折叠右侧栏'));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        'ui.layout.setState',
        expect.objectContaining({ rightWidth: 44 }),
      ),
    );
    mockInvoke.mockClear();
    fireEvent.click(screen.getAllByLabelText('展开右侧栏')[0]!);
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
