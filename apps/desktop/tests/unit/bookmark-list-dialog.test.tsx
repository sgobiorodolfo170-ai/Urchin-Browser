/** 共享书签列表弹窗：扁平模式（主页）、层级模式（收藏栏文件夹）、删除与循环/空态语义。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  BookmarkListDialog,
  type BookmarkListEntry,
} from '../../src/renderer/components/bookmark-list-dialog';

beforeEach(() => {
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
});
afterEach(cleanup);

const flat: BookmarkListEntry[] = [
  {
    id: 'u1',
    parentId: null,
    type: 'bookmark',
    url: 'https://a.test/x',
    title: '页面甲',
    favicon: 'urchin://favicon/a',
  },
  { id: 'u2', parentId: null, type: 'bookmark', url: '', title: '无址页' },
];

it('扁平模式：每行带网站图标，点击行导航并关闭，无 onDelete 不显示取消收藏', () => {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(
    <BookmarkListDialog
      open
      heading="a.test · 书签列表"
      entries={flat}
      onClose={onClose}
      onNavigate={onNavigate}
    />,
  );
  const rows = within(screen.getByRole('dialog')).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.querySelector('img')).toBeTruthy();
  expect(screen.queryByLabelText('取消收藏：页面甲')).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByText('页面甲'));
  expect(onNavigate).toHaveBeenCalledWith('https://a.test/x');
  expect(onClose).toHaveBeenCalled();
});

it('扁平模式：提供 onDelete 时可取消收藏，失败展示错误后可重试成功', async () => {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  let fail = true;
  const onDelete = vi.fn(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()));
  render(
    <BookmarkListDialog
      open
      heading="a.test · 书签列表"
      entries={flat}
      onClose={onClose}
      onNavigate={onNavigate}
      onDelete={onDelete}
    />,
  );
  fireEvent.click(screen.getByLabelText('取消收藏：页面甲'));
  expect(await screen.findByRole('alert')).toHaveTextContent('取消收藏失败');
  fail = false;
  fireEvent.click(screen.getByLabelText('取消收藏：页面甲'));
  await vi.waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('层级模式：点击文件夹进入并显示返回，返回后回到首层，点击书签导航并关闭', () => {
  const entries: BookmarkListEntry[] = [
    { id: 'root', parentId: null, type: 'folder', title: '根文件夹' },
    { id: 'sub', parentId: 'root', type: 'folder', title: '子文件夹' },
    { id: 'leaf', parentId: 'sub', type: 'bookmark', url: 'https://b.test/y', title: '页面乙' },
  ];
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(
    <BookmarkListDialog
      open
      heading="根文件夹"
      entries={entries}
      rootId="root"
      onClose={onClose}
      onNavigate={onNavigate}
    />,
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('子文件夹')).toBeInTheDocument();
  expect(screen.queryByLabelText('返回上一级')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByText('子文件夹'));
  expect(within(screen.getByRole('dialog')).getByText('页面乙')).toBeInTheDocument();
  expect(screen.getByLabelText('返回上一级')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('返回上一级'));
  expect(within(screen.getByRole('dialog')).getByText('子文件夹')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByText('子文件夹'));
  fireEvent.click(within(screen.getByRole('dialog')).getByText('页面乙'));
  expect(onNavigate).toHaveBeenCalledWith('https://b.test/y');
  expect(onClose).toHaveBeenCalled();
});

it('层级模式：回指祖先的循环文件夹禁用并提示，无子项的文件夹显示为空', () => {
  // 循环引用在真实数据中表现为 parentId 互指（甲↔乙），进入乙夹后甲夹应禁用。
  const entries: BookmarkListEntry[] = [
    { id: 'a', parentId: 'b', type: 'folder', title: '甲夹' },
    { id: 'b', parentId: 'a', type: 'folder', title: '乙夹' },
    { id: 'empty', parentId: 'a', type: 'folder', title: '空夹' },
  ];
  render(
    <BookmarkListDialog
      open
      heading="甲夹"
      entries={entries}
      rootId="a"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />,
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('乙夹')).toBeInTheDocument();
  expect(within(dialog).getByText('空夹')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByText('乙夹'));
  const cyclic = within(screen.getByRole('dialog')).getByText('甲夹').closest('div')!;
  expect(cyclic).toHaveAttribute('title', '无法打开循环文件夹');
  fireEvent.click(screen.getByLabelText('返回上一级'));
  expect(within(screen.getByRole('dialog')).getByText('乙夹')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByText('空夹'));
  expect(within(screen.getByRole('dialog')).getByText('此文件夹为空')).toBeInTheDocument();
});
