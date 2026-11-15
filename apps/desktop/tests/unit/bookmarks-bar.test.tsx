/** 收藏栏文件夹菜单：点击文件夹请求主进程打开子窗口（定位在按钮下方），条目直接导航。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BookmarksBar } from '../../src/renderer/components/bookmarks-bar';

beforeEach(() => {
  // jsdom 无 ResizeObserver，收藏栏用其测量最小宽度。
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  });
});
afterEach(cleanup);

it('点击文件夹经主进程打开菜单子窗口（锚点为按钮左下角），点击书签直接导航', async () => {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'bookmark.list')
      return Promise.resolve({
        bookmarks: [
          {
            id: 'f1',
            parentId: null,
            type: 'folder',
            title: '开发夹',
            position: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'top',
            parentId: null,
            type: 'bookmark',
            url: 'https://top.test/',
            title: '顶栏书签',
            position: 0,
            createdAt: 4,
            updatedAt: 4,
          },
        ],
      });
    return Promise.resolve({});
  });
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: { invoke, on: () => vi.fn() },
  });
  const navigate = vi.fn();
  render(<BookmarksBar onNavigate={navigate} />);
  const folderButton = await screen.findByRole('button', { name: '开发夹' });
  expect(folderButton).toHaveAttribute('aria-haspopup', 'menu');
  fireEvent.click(folderButton);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'bookmark.openFolderMenuWindow',
      expect.objectContaining({ folderId: 'f1' }),
    ),
  );
  // 主窗口内不再渲染渲染层弹窗（子窗口由主进程创建，避免被网页视图遮挡）。
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '顶栏书签' }));
  expect(navigate).toHaveBeenCalledWith('https://top.test/');
});
