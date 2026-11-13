import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NewTabPage } from '../../src/renderer/home/NewTabPage';

afterEach(cleanup);
it('收藏夹按站点展示，单页直接导航，多页弹窗按时间倒序，变更同步', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  let changed: () => void = vi.fn();
  let bookmarks = [
    { type: 'bookmark', url: 'https://example.com/old', title: '旧页面', createdAt: 1 },
    { type: 'bookmark', url: 'https://example.com/new', title: '新页面', createdAt: 3 },
    { type: 'bookmark', url: 'https://single.test/path', title: '单页', createdAt: 2 },
    { type: 'folder', title: '文件夹', createdAt: 4 },
  ];
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'bookmark.list'
        ? { bookmarks }
        : {
            entries: [{ url: 'https://recent.test/path', title: '访问页面', visitedAt: 5 }],
            total: 1,
          },
    ),
  );
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: {
      invoke,
      on: (_: string, callback: () => void) => {
        changed = callback;
        return vi.fn();
      },
    },
  });
  const navigate = vi.fn();
  render(<NewTabPage onNavigate={navigate} />);
  fireEvent.click(await screen.findByTitle('single.test'));
  expect(navigate).toHaveBeenCalledWith('https://single.test/path');
  fireEvent.click(screen.getByTitle('example.com'));
  const list = screen.getByRole('dialog');
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['新页面https://example.com/new', '旧页面https://example.com/old']);
  fireEvent.click(within(list).getByText('旧页面'));
  expect(navigate).toHaveBeenLastCalledWith('https://example.com/old');
  fireEvent.click(screen.getByTitle('recent.test'));
  expect(within(screen.getByRole('dialog')).getByText('访问页面')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('关闭列表'));
  bookmarks = [];
  changed();
  expect(await screen.findByText('收藏网页后，将自动显示在这里')).toBeInTheDocument();
});
