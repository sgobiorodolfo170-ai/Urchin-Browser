/**
 * AppTitleBar 单元测试
 *
 * 覆盖 Windows frameless 自绘标题栏的关键交互：
 * 1. 挂载时同步最大化状态并渲染品牌/窗口控制按钮
 * 2. 最小化 / 最大化切换分别调用对应 IPC
 * 3. 关闭复用 window.close，并按当前渲染进程窗口 id 传参
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AppTitleBar } from '../../src/renderer/components/app-titlebar';

const mockInvoke = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke: mockInvoke,
      on: vi.fn().mockReturnValue(() => undefined),
      onMessagePort: vi.fn().mockReturnValue(() => undefined),
      platform: 'win32',
      versions: { electron: '32.0.0', chrome: '128.0.0', node: '22.0.0' },
    },
    writable: true,
    configurable: true,
  });
});

function mockWindowState(maximized: boolean): void {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'window.getState') return Promise.resolve({ maximized });
    if (channel === 'window.getCurrent') return Promise.resolve({ windowId: 2 });
    if (channel === 'window.toggleMaximize') return Promise.resolve({ maximized: !maximized });
    return Promise.resolve({});
  });
}

describe('AppTitleBar', () => {
  it('should sync initial maximized state and render window controls', async () => {
    mockWindowState(false);
    render(<AppTitleBar />);

    expect(screen.getByText('Urchin Browser')).toBeInTheDocument();
    expect(screen.getByLabelText('最小化窗口')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('最大化窗口')).toBeInTheDocument());
    expect(screen.getByLabelText('关闭窗口')).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith('window.getState', {});
  });

  it('should request minimize when clicking the minimize control', async () => {
    mockWindowState(false);
    render(<AppTitleBar />);

    fireEvent.click(screen.getByLabelText('最小化窗口'));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('window.minimize', {}));
  });

  it('should toggle maximize and switch the control to restore state', async () => {
    mockWindowState(false);
    render(<AppTitleBar />);

    const maximize = await screen.findByLabelText('最大化窗口');
    fireEvent.click(maximize);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('window.toggleMaximize', {}));
    await waitFor(() => expect(screen.getByLabelText('还原窗口')).toBeInTheDocument());
  });

  it('should close the current window by its resolved id', async () => {
    mockWindowState(false);
    render(<AppTitleBar />);

    fireEvent.click(screen.getByLabelText('关闭窗口'));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('window.close', { windowId: 2 }));
  });
});
