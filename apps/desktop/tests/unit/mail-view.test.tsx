/**
 * M25 邮箱页 · 主视图组件单测
 *
 * 覆盖：三区 grid 默认宽度、持久化宽度恢复、分割线拖拽写 mail.state、
 * 写邮件视图铺满右区（flex-1，用户反馈 2026-11-10 的回归锚点）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
