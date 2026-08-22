/**
 * pi 网页版启动器视图组件单元测试
 *
 * 覆盖：
 * 1. 挂载即查询 piWeb.status；stopped 态展示「启动」按钮
 * 2. 点击启动：invoke piWeb.launch → onOpenUrl 收到返回的 URL
 * 3. 启动失败：展示错误信息，按钮回到可重试态
 * 4. running 态：展示「打开网页 / 停止服务」；停止调用 piWeb.stop
 * 5. 首次运行第三方来源说明：展示 + 「我已知晓」后写入 localStorage 不再展示
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PiWebLauncherView } from '../../src/renderer/pi-web/launcher-view';

const mockInvoke = vi.fn();
const onOpenUrl = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  onOpenUrl.mockReset();
  mockInvoke.mockResolvedValue({});
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
  localStorage.clear();
});

function mockStatus(state: 'stopped' | 'starting' | 'running' | 'error', extra?: object) {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'piWeb.status') return Promise.resolve({ state, ...extra });
    if (channel === 'piWeb.launch')
      return Promise.resolve({ ok: true, url: 'http://127.0.0.1:45001', port: 45001 });
    if (channel === 'piWeb.stop') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  });
}

describe('PiWebLauncherView', () => {
  it('should query status on mount and show start button when stopped', async () => {
    mockStatus('stopped');
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('piWeb.status', {});
    });
    expect(await screen.findByRole('button', { name: /启动 pi 网页/ })).toBeInTheDocument();
    expect(screen.getByText('服务未运行')).toBeInTheDocument();
  });

  it('should invoke piWeb.launch and call onOpenUrl with returned url on start', async () => {
    mockStatus('stopped');
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    const btn = await screen.findByRole('button', { name: /启动 pi 网页/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('piWeb.launch', {});
    });
    await waitFor(() => {
      expect(onOpenUrl).toHaveBeenCalledWith('http://127.0.0.1:45001');
    });
  });

  it('should show error message when launch fails', async () => {
    // 初始即 error 态（如上次启动失败）：按钮为「重试启动」
    mockStatus('error', { lastError: '上次启动失败' });
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'piWeb.status')
        return Promise.resolve({ state: 'error', lastError: '上次启动失败' });
      if (channel === 'piWeb.launch')
        return Promise.reject(new Error('健康检查超时（180s），pi-web-ui 未就绪'));
      return Promise.resolve({});
    });
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    const retryBtn = await screen.findByRole('button', { name: /重试启动/ });
    expect(await screen.findByText(/上次启动失败/)).toBeInTheDocument();

    fireEvent.click(retryBtn);
    // 本次启动失败的错误信息覆盖展示，且按钮仍可重试
    expect(await screen.findByText(/健康检查超时/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /重试启动/ })).toBeInTheDocument();
    expect(onOpenUrl).not.toHaveBeenCalled();
  });

  it('should show open/stop buttons when running, and stop calls piWeb.stop', async () => {
    mockStatus('running', { url: 'http://127.0.0.1:45001', port: 45001, pid: 4321 });
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    // running 态：打开 + 停止
    const openBtn = await screen.findByRole('button', { name: /打开网页/ });
    const stopBtn = screen.getByRole('button', { name: /停止服务/ });
    expect(screen.getByText(/运行中 · 端口 45001 · PID 4321/)).toBeInTheDocument();

    fireEvent.click(openBtn);
    expect(onOpenUrl).toHaveBeenCalledWith('http://127.0.0.1:45001');

    fireEvent.click(stopBtn);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('piWeb.stop', {});
    });
  });

  it('should show third-party notice on first run and hide after acknowledge', async () => {
    mockStatus('stopped');
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    expect(await screen.findByText(/pi-web-ui@0.28.2/)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /我已知晓/ }));
    await waitFor(() => {
      expect(screen.queryByText(/pi-web-ui@0.28.2/)).toBeNull();
    });
    expect(localStorage.getItem('urchin.pi-web.notice-ack-v1')).toBe('1');
  });

  it('should not show notice when already acknowledged', async () => {
    localStorage.setItem('urchin.pi-web.notice-ack-v1', '1');
    mockStatus('stopped');
    render(<PiWebLauncherView onOpenUrl={onOpenUrl} />);

    await screen.findByRole('button', { name: /启动 pi 网页/ });
    expect(screen.queryByText(/我已知晓/)).toBeNull();
  });
});
