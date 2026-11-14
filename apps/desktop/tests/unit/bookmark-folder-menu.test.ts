import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
const mocks = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  popup: vi.fn(),
  owner: {},
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => mocks.owner },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      mocks.template = template;
      return { popup: mocks.popup };
    },
  },
}));
import { openBookmarkFolderMenu } from '../../src/main/bookmarks/folder-menu';

describe('bookmark folder native menu', () => {
  it('reads current folder data, supports nested folders and returns the selected URL', async () => {
    const list = vi.fn(() => [
      { id: 'root', type: 'folder', parentId: null, title: 'root' },
      { id: 'nested', type: 'folder', parentId: 'root', title: 'A&B' },
      {
        id: 'child',
        type: 'bookmark',
        parentId: 'nested',
        title: 'updated title',
        url: 'https://example.com/',
      },
    ]);
    mocks.popup.mockImplementation(() => {
      const nested = mocks.template[0]?.submenu as MenuItemConstructorOptions[];
      nested[0]?.click?.({} as never, {} as never, {});
    });
    const result = await openBookmarkFolderMenu({ list } as never, {} as never, {
      folderId: 'root',
      x: 150,
      y: 80,
    });
    expect(list).toHaveBeenCalledOnce();
    expect(mocks.template[0]?.label).toBe('A&&B');
    expect((mocks.template[0]?.submenu as MenuItemConstructorOptions[])[0]?.label).toBe(
      'updated title',
    );
    expect(mocks.popup).toHaveBeenCalledWith(
      expect.objectContaining({ x: 150, y: 80, window: mocks.owner }),
    );
    expect(result).toEqual({ url: 'https://example.com/' });
  });
  it('shows an empty folder and resolves cancellation without navigation', async () => {
    mocks.popup.mockImplementation((options: { callback: () => void }) => options.callback());
    const list = () => [{ id: 'root', type: 'folder', parentId: null, title: 'empty' }];
    expect(
      await openBookmarkFolderMenu({ list } as never, {} as never, {
        folderId: 'root',
        x: 0,
        y: 0,
      }),
    ).toEqual({ url: null });
    expect(mocks.template).toEqual([{ label: '此文件夹为空', enabled: false }]);
  });
});
