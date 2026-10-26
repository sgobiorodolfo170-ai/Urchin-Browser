/**
 * import-bookmarks · importTreeIntoBookmarks 单测
 */
import { describe, it, expect } from 'vitest';
import { BookmarkManager } from '../../src/main/bookmarks';
import { importTreeIntoBookmarks } from '../../src/main/import/import-bookmarks';
import type { ImportTreeNode } from '../../src/main/import/types';

function makeManager(): BookmarkManager {
  return new BookmarkManager();
}

describe('importTreeIntoBookmarks', () => {
  it('should create root folder + nested structure, count folders/bookmarks/skipped', () => {
    const manager = makeManager();
    const tree: ImportTreeNode = {
      title: 'root',
      children: [
        { title: 'A', url: 'https://a.example.com/' },
        {
          title: 'Folder1',
          children: [
            { title: 'B', url: 'https://b.example.com/' },
            { title: '', url: 'https://empty-title.example.com/' }, // 空标题跳过
            { title: 'NoUrl' }, // 无 url 当文件夹处理（不跳过）
            { title: 'Bad', url: 'javascript:alert(1)' }, // 危险协议跳过
          ],
        },
      ],
    };

    const summary = importTreeIntoBookmarks(manager, { sourceName: 'Test', root: tree });

    // root + Folder1 + NoUrl(文件夹) = 3 folders
    expect(summary.folders).toBe(3);
    expect(summary.bookmarks).toBe(2); // A, B
    expect(summary.skipped).toBe(2); // empty title + javascript
    expect(summary.rootFolderTitle).toContain('导入自 Test (');
    // 根文件夹在根级
    const all = manager.list(null);
    expect(all.some((b) => b.id === summary.rootFolderId && b.type === 'folder')).toBe(true);
  });

  it('should preserve hierarchy via parentId chains', () => {
    const manager = makeManager();
    const tree: ImportTreeNode = {
      title: 'root',
      children: [
        {
          title: 'Outer',
          children: [
            { title: 'Inner', children: [{ title: 'Deep', url: 'https://deep.example.com/' }] },
          ],
        },
      ],
    };
    const summary = importTreeIntoBookmarks(manager, { sourceName: 'X', root: tree });
    const all = manager.list();
    const outer = all.find((b) => b.title === 'Outer' && b.type === 'folder');
    const inner = all.find((b) => b.title === 'Inner' && b.type === 'folder');
    const deep = all.find((b) => b.title === 'Deep' && b.type === 'bookmark');
    expect(outer).toBeTruthy();
    expect(inner?.parentId).toBe(outer!.id);
    expect(deep?.parentId).toBe(inner!.id);
    void summary;
  });

  it('should skip bookmarks with invalid urls', () => {
    const manager = makeManager();
    const tree: ImportTreeNode = {
      title: 'root',
      children: [
        { title: 'NoProtocol', url: 'not-a-url' },
        { title: 'Data', url: 'data:text/html,<x>' },
        { title: 'Ok', url: 'https://ok.example.com/' },
      ],
    };
    const summary = importTreeIntoBookmarks(manager, { sourceName: 'X', root: tree });
    expect(summary.bookmarks).toBe(1);
    expect(summary.skipped).toBe(2);
  });
});
