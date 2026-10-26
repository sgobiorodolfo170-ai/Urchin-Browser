/**
 * firefox-profiles · buildFirefoxTreeFromRows 纯函数单测
 */
import { describe, it, expect } from 'vitest';
import { buildFirefoxTreeFromRows } from '../../src/main/import/firefox-profiles';
import type { MozBookmarkRow, MozPlaceRow } from '../../src/main/import/firefox-profiles';

describe('buildFirefoxTreeFromRows', () => {
  it('should build tree from known roots (menu/toolbar/unfiled/mobile) and skip tags', () => {
    // places root id=1 (parent=0)；其下 menu(2)/toolbar(3)/tags(4)/unfiled(5)
    const bookmarkRows: MozBookmarkRow[] = [
      { id: 1, parent: 0, type: 1, title: 'places', fk: null, guid: 'places-root' },
      { id: 2, parent: 1, type: 1, title: 'menu', fk: null, guid: 'menu________' },
      { id: 3, parent: 1, type: 1, title: 'toolbar', fk: null, guid: 'toolbar_____' },
      { id: 4, parent: 1, type: 1, title: 'tags', fk: null, guid: 'tags________' },
      { id: 5, parent: 1, type: 1, title: 'unfiled', fk: null, guid: 'unfiled_____' },
      // menu 下一个书签 + 一个文件夹
      { id: 10, parent: 2, type: 2, title: 'MenuLink', fk: 100, guid: 'm1' },
      { id: 11, parent: 2, type: 1, title: 'MenuFolder', fk: null, guid: 'm2' },
      { id: 12, parent: 11, type: 2, title: 'NestedLink', fk: 101, guid: 'm3' },
      // toolbar 下一个书签
      { id: 20, parent: 3, type: 2, title: 'ToolbarLink', fk: 102, guid: 't1' },
      // tags 下假数据（应被跳过）
      { id: 30, parent: 4, type: 2, title: 'tag-entry', fk: 103, guid: 'tg1' },
      // unfiled 下一个书签
      { id: 40, parent: 5, type: 2, title: 'UnfiledLink', fk: 104, guid: 'u1' },
    ];
    const placeRows: MozPlaceRow[] = [
      { id: 100, url: 'https://menu.example.com/' },
      { id: 101, url: 'https://nested.example.com/' },
      { id: 102, url: 'https://toolbar.example.com/' },
      { id: 103, url: 'https://tag.example.com/' },
      { id: 104, url: 'https://unfiled.example.com/' },
    ];

    const tree = buildFirefoxTreeFromRows(bookmarkRows, placeRows);

    // tags 被跳过：3 个根（menu/toolbar/unfiled）
    expect(tree.children).toHaveLength(3);
    const menu = tree.children![0]!;
    expect(menu.title).toBe('menu');
    expect(menu.children).toHaveLength(2);
    expect(menu.children![0]).toMatchObject({
      title: 'MenuLink',
      url: 'https://menu.example.com/',
    });
    const folder = menu.children![1]!;
    expect(folder.title).toBe('MenuFolder');
    expect(folder.children).toHaveLength(1);
    expect(folder.children![0]).toMatchObject({
      title: 'NestedLink',
      url: 'https://nested.example.com/',
    });
    expect(tree.children![1]!.title).toBe('toolbar');
    expect(tree.children![2]!.title).toBe('unfiled');
  });

  it('should return empty tree when places root missing', () => {
    const tree = buildFirefoxTreeFromRows([], []);
    expect(tree.children).toHaveLength(0);
  });
});
