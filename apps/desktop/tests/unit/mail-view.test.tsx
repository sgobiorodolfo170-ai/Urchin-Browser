/**
 * M25 邮箱页 · 主视图组件单测
 *
 * 覆盖：三区 grid 默认宽度、持久化宽度恢复、分割线拖拽写 mail.state、
 * 写邮件视图铺满右区（flex-1，用户反馈 2026-11-10 的回归锚点）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageList } from '../../src/renderer/mail/MessageList';
import { MailView } from '../../src/renderer/mail/MailView';
import {
  DEFAULT_FOLDER_WIDTH,
  DEFAULT_LIST_WIDTH,
  MAIL_STATE_KEY,
} from '../../src/renderer/mail/layout';

type Invoke = (channel: string, req: unknown) => Promise<unknown>;

function installUrchin(invoke: Invoke): void {
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: {
      invoke,
      on: () => () => undefined,
      onMessagePort: () => () => undefined,
      platform: 'win32',
      versions: { electron: '0', chrome: '0', node: '0' },
    },
  });
}

const ACCOUNT = {
  id: 'a1',
  name: '测试账户',
  email: 'test@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  createdAt: 1,
  hasPassword: true,
};

describe('MailView 三区布局', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'mail.account.list') return Promise.resolve({ accounts: [ACCOUNT] });
      if (channel === 'mail.folder.list') {
        return Promise.resolve({
          folders: [
            { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: [], exists: 3, unseen: 1 },
          ],
          fromCache: true,
        });
      }
      if (channel === 'mail.message.list') {
        return Promise.resolve({ messages: [], total: 0, fromCache: true });
      }
      if (channel === 'settings.get') return Promise.resolve({ value: null });
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    installUrchin(invoke as Invoke);
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('navigates between login, home and settings', async () => {
    render(<MailView />);
    fireEvent.click(await screen.findByRole('button', { name: '返回登录页' }));
    expect(screen.getByRole('heading', { name: '登录邮箱' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回邮箱主页' }));
    fireEvent.click(screen.getByTitle('邮箱设置'));
    expect(screen.getByRole('heading', { name: '邮箱设置' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回邮箱主页' }));
    expect(screen.getByRole('button', { name: '复制邮箱账号' })).toBeInTheDocument();
  });

  it('shows please login when returning without any accounts', async () => {
    const base = invoke.getMockImplementation()! as Invoke;
    invoke.mockImplementation((channel: string, req: unknown) =>
      channel === 'mail.account.list' ? Promise.resolve({ accounts: [] }) : base(channel, req),
    );
    render(<MailView />);
    fireEvent.click(await screen.findByRole('button', { name: '返回邮箱主页' }));
    expect(screen.getByText('请登录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '登录邮箱' }));
    expect(screen.getByRole('heading', { name: '登录邮箱' })).toBeInTheDocument();
  });
  it('persists default account and appearance preferences from settings', async () => {
    render(<MailView />);
    fireEvent.click(await screen.findByTitle('邮箱设置'));
    fireEvent.click(screen.getByLabelText('默认账号'));
    fireEvent.change(screen.getByLabelText('邮件列表密度'), { target: { value: 'compact' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings.set', {
        key: 'mail.preferences',
        value: expect.objectContaining({ defaultAccountId: 'a1', density: 'compact' }) as unknown,
      }),
    );
  });

  it('shows the active folder title and hides invalid dates', () => {
    render(
      <MessageList
        folderName="已发送"
        total={1}
        selectedUid={null}
        loading={false}
        onSelect={() => undefined}
        messages={[
          {
            uid: 1,
            folder: 'Sent',
            flags: [],
            envelope: {
              subject: '测试主题',
              from: 'test@example.com',
              to: [],
              date: 'invalid',
              size: 0,
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('已发送')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('keeps the latest message body when an earlier request finishes last', async () => {
    const base = invoke.getMockImplementation()! as Invoke;
    let finishFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const messages = [1, 2].map((uid) => ({
      uid,
      folder: 'INBOX',
      flags: ['\\Seen'],
      envelope: { subject: `主题${uid}`, from: 'test@example.com', to: [], date: '', size: 0 },
    }));
    invoke.mockImplementation((channel: string, req: unknown) => {
      if (channel === 'mail.message.list')
        return Promise.resolve({ messages, total: 2, fromCache: true });
      if (channel === 'mail.message.fetch')
        return (req as { uid: number }).uid === 1
          ? first
          : Promise.resolve({ uid: 2, text: '最新正文', attachments: [] });
      return base(channel, req);
    });
    render(<MailView />);
    fireEvent.click(await screen.findByRole('button', { name: /主题1/ }));
    fireEvent.click(screen.getByRole('button', { name: /主题2/ }));
    await screen.findByText('最新正文');
    finishFirst({ uid: 1, text: '旧正文', attachments: [] });
    await waitFor(() => expect(screen.queryByText('旧正文')).not.toBeInTheDocument());
    expect(screen.getByText('最新正文')).toBeInTheDocument();
  });

  it('should render three panes with default widths in grid template', async () => {
    render(<MailView />);

    const folderList = await screen.findByTestId('mail-folder-list');
    const messageList = screen.getByTestId('mail-message-list');
    expect(folderList.style.width).toBe(`${DEFAULT_FOLDER_WIDTH}px`);
    expect(messageList.style.width).toBe(`${DEFAULT_LIST_WIDTH}px`);
  });

  it('should restore persisted widths from mail.state', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'mail.account.list') return Promise.resolve({ accounts: [ACCOUNT] });
      if (channel === 'mail.folder.list') {
        return Promise.resolve({
          folders: [],
          fromCache: true,
        });
      }
      if (channel === 'mail.message.list')
        return Promise.resolve({ messages: [], total: 0, fromCache: true });
      if (channel === 'settings.get') {
        return Promise.resolve({ value: { v: 1, folderWidth: 260, listWidth: 360 } });
      }
      return Promise.resolve({});
    });
    render(<MailView />);

    const folderList = await screen.findByTestId('mail-folder-list');
    await waitFor(() => expect(folderList.style.width).toBe('260px'));
    expect(screen.getByTestId('mail-message-list').style.width).toBe('360px');
  });

  it('should persist widths to mail.state after dragging folder splitter', async () => {
    render(<MailView />);

    const splitter = await screen.findByRole('separator', { name: '调整文件夹栏宽度' });
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 260 });
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 260 });

    await waitFor(() => {
      const calls = invoke.mock.calls.filter((call) => call[0] === 'settings.set');
      expect(calls.length).toBeGreaterThan(0);
      const req = calls[calls.length - 1]?.[1] as {
        key: string;
        value: { v: number; folderWidth: number; listWidth: number };
      };
      expect(req.key).toBe(MAIL_STATE_KEY);
      expect(req.value.v).toBe(1);
      // 默认 192 + 60 位移（未越上限）
      expect(req.value.folderWidth).toBe(252);
      expect(screen.getByTestId('mail-folder-list').style.width).toBe('252px');
      expect(req.value.listWidth).toBe(DEFAULT_LIST_WIDTH);
    });
  });

  it('should clamp folder width when dragging beyond container limit', async () => {
    render(<MailView />);

    const splitter = await screen.findByRole('separator', { name: '调整文件夹栏宽度' });
    // jsdom 容器宽度测量为 0 → 组件用初始估算 1200；拖 +100000 应被 clamp 到上限
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 100200 });
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 100200 });

    await waitFor(() => {
      const calls = invoke.mock.calls.filter((call) => call[0] === 'settings.set');
      const req = calls[calls.length - 1]?.[1] as { value: { folderWidth: number } };
      // 1200 - 2*6(分割线) - 284(列表保持原值) - 320(右区下限) = 584
      expect(req.value.folderWidth).toBe(584);
    });
  });

  it('should render compose view filling the right zone', async () => {
    render(<MailView />);

    await screen.findByTestId('mail-folder-list');
    fireEvent.click(screen.getByRole('button', { name: '写邮件' }));

    const compose = await screen.findByTestId('mail-compose');
    // 回归锚点（2026-11-10）：根容器必须 flex-1 + min-w-0，铺满右区而非按内容收缩
    expect(compose.className).toContain('flex-1');
    expect(compose.className).toContain('min-w-0');
  });

  it('should show re-auth card instead of panes when password is missing', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'mail.account.list') {
        return Promise.resolve({ accounts: [{ ...ACCOUNT, hasPassword: false }] });
      }
      return Promise.resolve({});
    });
    render(<MailView />);

    expect(await screen.findByText(/需要重新登录/)).toBeInTheDocument();
    // 密码缺失时不得发起 IMAP 连接
    const folderCalls = invoke.mock.calls.filter((call) => call[0] === 'mail.folder.list');
    expect(folderCalls).toHaveLength(0);
  });

  it('should save re-auth password via mail.account.setPassword and reconnect', async () => {
    let hasPassword = false;
    invoke.mockImplementation((channel: string) => {
      if (channel === 'mail.account.list') {
        return Promise.resolve({ accounts: [{ ...ACCOUNT, hasPassword }] });
      }
      if (channel === 'mail.account.setPassword') {
        hasPassword = true;
        return Promise.resolve({ ok: true });
      }
      if (channel === 'mail.folder.list') {
        return Promise.resolve({ folders: [], fromCache: true });
      }
      if (channel === 'mail.message.list') {
        return Promise.resolve({ messages: [], total: 0, fromCache: true });
      }
      return Promise.resolve({});
    });
    render(<MailView />);

    await screen.findByText(/需要重新登录/);
    const input = screen.getByLabelText('IMAP 密码 / 授权码');
    fireEvent.change(input, { target: { value: 'qq-auth-code' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并重连' }));

    await waitFor(() => {
      const calls = invoke.mock.calls.filter((call) => call[0] === 'mail.account.setPassword');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual({ accountId: 'a1', password: 'qq-auth-code' });
    });
    // 重授权成功 → 卡片消失、三区恢复、文件夹重新加载
    await waitFor(() => {
      expect(screen.queryByText(/需要重新登录/)).not.toBeInTheDocument();
      expect(screen.getByTestId('mail-folder-list')).toBeInTheDocument();
      const folderCalls = invoke.mock.calls.filter((call) => call[0] === 'mail.folder.list');
      expect(folderCalls.length).toBeGreaterThan(0);
    });
  });
});
