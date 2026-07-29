/**
 * App 组件单元测试（W2-D1）
 *
 * 验证：
 * 1. 标题与环境信息渲染
 * 2. IPC tab.create 链路成功/失败
 * 3. M1 window.create 按钮可触发 IPC
 * 4. M19 主题切换按钮可用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { ThemeProvider } from '../../src/renderer/theme/theme-provider';

// Mock window.urchin（preload 在测试环境不存在）
const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke: mockInvoke,
      platform: 'win32',
      versions: { electron: '32.0.0', chrome: '128.0.0', node: '22.0.0' },
    },
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

function renderApp() {
  return render(
    <ThemeProvider defaultTheme="light">
      <App />
    </ThemeProvider>,
  );
}

describe('App', () => {
  it('should render title and environment info', () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 1, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    renderApp();
    expect(screen.getByText('Urchin Browser')).toBeInTheDocument();
    expect(screen.getByText(/平台：win32/)).toBeInTheDocument();
  });

  it('should show IPC success when tab.create succeeds', async () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 42, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    renderApp();
    await waitFor(() => {
      expect(screen.getByText(/通过/)).toBeInTheDocument();
      expect(screen.getByText(/Tab #42/)).toBeInTheDocument();
    });
  });

  it('should show IPC error when tab.create fails', async () => {
    mockInvoke.mockRejectedValue(new Error('connection refused'));
    renderApp();
    await waitFor(() => {
      expect(screen.getByText(/失败/)).toBeInTheDocument();
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
  });

  it('should render M1 Window Lifecycle section with create button', () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 1, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    renderApp();
    expect(screen.getByText('M1 Window Lifecycle')).toBeInTheDocument();
    expect(screen.getByText('创建新窗口')).toBeInTheDocument();
  });

  it('should call window.create when button clicked', async () => {
    mockInvoke.mockResolvedValueOnce({
      tab: { id: 1, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    mockInvoke.mockResolvedValueOnce({ windowId: 2 });

    renderApp();
    await waitFor(() => {
      expect(screen.getByText(/通过/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('创建新窗口'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('window.create', { incognito: false });
      expect(screen.getByText(/windowId=2/)).toBeInTheDocument();
    });
  });

  it('should toggle theme when theme button clicked', () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 1, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    renderApp();

    const themeButton = screen.getByLabelText('切换主题');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    fireEvent.click(themeButton);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(themeButton);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
