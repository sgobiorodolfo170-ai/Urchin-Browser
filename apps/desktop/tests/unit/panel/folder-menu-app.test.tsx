/*
  eslint-disable
  @typescript-eslint/require-await
  -- 测试 mock（invoke mock 回调无 await）
*/
/**
 * 收藏栏文件夹菜单子窗口（FolderMenuApp）交互测试：
 * 按 query folderId 渲染该文件夹子项（复用主页同款 BookmarkListPanel）、
 * 点击书签在主窗口活跃标签打开后自关、Esc 关闭、bookmark:changed 刷新。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Bookmark } from '@urchin/ipc-contract';
import { FolderMenuApp } from '../../../src/renderer/panel/FolderMenuApp';

const FOLDER: Bookmark = {
  id: 'f-1',
  type: 'folder',
  title: '工作夹',
  parentId: null,
  position: 0,
  createdAt: 3,
  updatedAt: 3,
};
const CHILD: Bookmark = {
  id: 'bm-1',
  type: 'bookmark',
  title: '子页甲',
  url: 'https://example.com/a',
  favicon: 'urchin://favicon/abc',
  parentId: 'f-1',
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
const CHILD2: Bookmark = {
  id: 'bm-2',
  type: 'bookmark',
  title: '子页乙',
  url: 'https://example.com/b',
  parentId: 'f-1',
  position: 1,
  createdAt: 2,
  updatedAt: 2,
};
const OTHER: Bookmark = {
  id: 'bm-9',
  type: 'bookmark',
  title: '顶栏书签',
  url: 'https://top.test/',
  parentId: null,
  position: 1,
  createdAt: 9,
  updatedAt: 9,
};

const invoke = vi.fn();
let changed: (() => void) | null = null;

beforeEach(() => {
  invoke.mockReset();
  changed = null;
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'bookmark.list') return { bookmarks: [FOLDER, CHILD, CHILD2, OTHER] };
    if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
    return {};
  });
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke,
      on: (_: string, callback: () => void) => {
        changed = callback;
        return vi.fn();
      },
    },
    writable: true,
    configurable: true,
  });
  window.history.replaceState({}, '', '/panel.html?mode=folder-menu&folderId=f-1');
});

describe('FolderMenuApp', () => {
  it('renders only the folder children with favicons', async () => {
    render(<FolderMenuApp />);
    await screen.findByText('子页甲');
    expect(screen.getByText('子页乙')).toBeInTheDocument();
    expect(screen.queryByText('顶栏书签')).not.toBeInTheDocument();
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.querySelector('img')).toBeTruthy();
    }
  });

  it('opens clicked bookmark in active tab and closes itself', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<FolderMenuApp />);
    fireEvent.click(await screen.findByText('子页甲'));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tab.loadUrl', {
        tabId: 1,
        url: 'https://example.com/a',
      }),
    );
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('closes on Escape', () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    render(<FolderMenuApp />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it('refreshes list on bookmark:changed broadcast', async () => {
    render(<FolderMenuApp />);
    await screen.findByText('子页甲');
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'bookmark.list') return { bookmarks: [FOLDER, CHILD] };
      if (channel === 'tab.list') return { tabs: [{ id: 1, active: true }] };
      return {};
    });
    changed?.();
    await vi.waitFor(() => expect(screen.queryByText('子页乙')).not.toBeInTheDocument());
  });
});
