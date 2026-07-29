/**
 * App 组件单元测试（W1-D1 最小验证）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/App';

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
});

describe('App', () => {
  it('should render title and environment info', () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 1, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    render(<App />);
    expect(screen.getByText('Urchin Browser')).toBeInTheDocument();
    expect(screen.getByText(/平台：win32/)).toBeInTheDocument();
  });

  it('should show IPC success when tab.create succeeds', async () => {
    mockInvoke.mockResolvedValue({
      tab: { id: 42, windowId: 1, url: 'about:blank', title: 'Urchin' },
    });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/通过/)).toBeInTheDocument();
      expect(screen.getByText(/Tab #42/)).toBeInTheDocument();
    });
  });

  it('should show IPC error when tab.create fails', async () => {
    mockInvoke.mockRejectedValue(new Error('connection refused'));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/失败/)).toBeInTheDocument();
      expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    });
  });
});
