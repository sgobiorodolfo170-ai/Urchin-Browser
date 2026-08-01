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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
});
