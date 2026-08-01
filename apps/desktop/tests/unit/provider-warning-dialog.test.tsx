/**
 * ProviderWarningDialog 单元测试
 *
 * 验证：
 * 1. open=false 时不渲染
 * 2. 打开时调用 provider.install(confirm:false) 获取 warning
 * 3. 输入正确 confirmPhrase 后确认安装 → provider.install(confirm:true)
 * 4. 输入错误时确认按钮禁用
 * 5. 安装失败回调 onError
 * 6. 无需确认时直接 onInstalled
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ProviderWarningDialog } from '../../src/renderer/components/provider-warning-dialog';

const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke, on: vi.fn(), onMessagePort: vi.fn() },
    writable: true,
    configurable: true,
  });
});

interface Props {
  open?: boolean;
  source?: string;
}

function renderDialog({ open = true, source = 'local:./x' }: Props = {}) {
  const onClose = vi.fn();
  const onInstalled = vi.fn();
  const onError = vi.fn();
  const view = render(
    <ProviderWarningDialog
      open={open}
      source={source}
      onClose={onClose}
      onInstalled={onInstalled}
      onError={onError}
    />,
  );
  return { onClose, onInstalled, onError, container: view.container };
}

describe('ProviderWarningDialog', () => {
  it('should render nothing when open is false', () => {
    const { container } = renderDialog({ open: false });

    expect(container.firstChild).toBeNull();
  });

  it('should fetch warning on open and display it', async () => {
    mockInvoke.mockResolvedValue({
      confirmationRequired: true,
      warning: '此 Provider 来自第三方，存在安全风险',
      confirmPhrase: '我确认',
    });

    renderDialog();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('provider.install', {
        source: 'local:./x',
        confirm: false,
      });
    });
    await waitFor(() => {
      expect(screen.getByText('此 Provider 来自第三方，存在安全风险')).toBeInTheDocument();
    });
  });

  it('should confirm install when phrase matches', async () => {
    mockInvoke.mockResolvedValue({
      confirmationRequired: true,
      warning: 'warn',
      confirmPhrase: '我确认',
    });
    mockInvoke.mockResolvedValueOnce({
      confirmationRequired: true,
      warning: 'warn',
      confirmPhrase: '我确认',
    });
    mockInvoke.mockResolvedValueOnce({
      confirmationRequired: false,
      providerId: 'p1',
      source: 'local:./x',
    });

    const { onInstalled } = renderDialog();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('我确认')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('我确认') as unknown as HTMLInputElement;
    fireEvent.change(input, { target: { value: '我确认' } });

    const confirmBtn = screen.getByText('确认安装').closest('button');
    expect(confirmBtn).toBeEnabled();
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('provider.install', {
        source: 'local:./x',
        confirm: true,
      });
    });
    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalledWith({
        confirmationRequired: false,
        providerId: 'p1',
        source: 'local:./x',
      });
    });
  });

  it('should disable confirm button when phrase mismatches', async () => {
    mockInvoke.mockResolvedValue({
      confirmationRequired: true,
      warning: 'warn',
      confirmPhrase: '我确认',
    });

    renderDialog();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('我确认')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('我确认') as unknown as HTMLInputElement;
    fireEvent.change(input, { target: { value: '错误的输入' } });

    expect(screen.getByText('确认安装').closest('button')).toBeDisabled();
  });

  it('should call onError when install fails', async () => {
    mockInvoke.mockResolvedValueOnce({
      confirmationRequired: true,
      warning: 'warn',
      confirmPhrase: '我确认',
    });
    mockInvoke.mockRejectedValueOnce(new Error('install failed'));

    const { onError } = renderDialog();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('我确认')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('我确认'), { target: { value: '我确认' } });
    fireEvent.click(screen.getByText('确认安装').closest('button')!);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('install failed');
    });
  });

  it('should call onError when warning fetch fails', async () => {
    mockInvoke.mockRejectedValue(new Error('fetch failed'));

    const { onError } = renderDialog();

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('fetch failed');
    });
  });

  it('should call onInstalled directly when confirmation not required', async () => {
    mockInvoke.mockResolvedValue({
      confirmationRequired: false,
      providerId: 'p1',
      source: 'local:./x',
    });

    const { onInstalled } = renderDialog();

    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalledWith({
        confirmationRequired: false,
        providerId: 'p1',
        source: 'local:./x',
      });
    });
  });
});
