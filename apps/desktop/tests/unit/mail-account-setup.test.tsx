import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountSetup } from '../../src/renderer/mail/AccountSetup';

const invoke = vi.fn<(channel: string, req: unknown) => Promise<unknown>>();
const onSaved = vi.fn();
function fillAccount() {
  fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'user@163.com' } });
  fireEvent.change(screen.getByLabelText('授权码 / 应用专用密码'), {
    target: { value: 'test-secret' },
  });
}
describe('邮箱单页登录', () => {
  beforeEach(() => {
    invoke.mockReset();
    onSaved.mockReset();
    invoke.mockResolvedValue({});
    Object.defineProperty(window, 'urchin', { configurable: true, value: { invoke } });
  });
  it('shows providers and account fields together without a next step', () => {
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: /Gmail/ })).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱地址')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录并添加' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '前往官网注册' })).toBeInTheDocument();
  });
  it('uses the selected provider configuration when submitting', async () => {
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /网易163邮箱/ }));
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '登录并添加' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith(
      'mail.account.add',
      expect.objectContaining({
        email: 'user@163.com',
        password: 'test-secret',
        imapHost: 'imap.163.com',
        imapPort: 993,
      }),
    );
  });
  it('blocks password submission for Outlook requiring OAuth2', () => {
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Outlook \/ Hotmail/ }));
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'user@hotmail.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
    expect(screen.getByRole('button', { name: '登录并添加' })).toBeDisabled();
    expect(screen.getByText(/当前客户端尚未实现微软 OAuth2/)).toBeInTheDocument();
  });
  it('opens registration in a new tab without passing account credentials', async () => {
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /网易163邮箱/ }));
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '前往官网注册' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'https://mail.163.com/register/index.htm',
        active: true,
      }),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('邮箱地址')).toHaveValue('user@163.com');
  });
  it('disables submission for invalid custom server ports', () => {
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '其他邮箱 / 自定义' }));
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'test-secret' } });
    fireEvent.change(screen.getByLabelText('IMAP 服务器'), {
      target: { value: 'imap.example.com' },
    });
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '65536' } });
    expect(screen.getByRole('button', { name: '登录并添加' })).toBeDisabled();
  });
  it('shows registration failures and preserves the login form', async () => {
    invoke.mockRejectedValue(new Error('tab unavailable'));
    render(<AccountSetup onSaved={onSaved} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '前往官网注册' }));
    expect(await screen.findByText(/无法打开注册页面/)).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱地址')).toBeInTheDocument();
  });
});
