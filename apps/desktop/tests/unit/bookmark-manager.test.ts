/**
 * BookmarkManager 单元测试。
 *
 * 验证：
 * 1. create：type 推导、position 分配、默认 parentId、事件、唯一 ID
 * 2. list：全部 / 根级 / 指定父节点，按 position 升序
 * 3. search：title / url 大小写不敏感匹配、仅书签、limit、空结果
 * 4. delete：移除、不存在抛异常、文件夹级联、事件
 * 5. events：on/off 监听器注册与移除
 */
import { describe, it, expect, vi } from 'vitest';
import { BookmarkManager } from '../../src/main/bookmarks';

describe('BookmarkManager', () => {
  // ===== create 测试 =====

  it('create: bookmark with url gets type="bookmark"', () => {
    const mgr = new BookmarkManager();

    const bookmark = mgr.create({ title: 'Example', url: 'https://example.com' });

    expect(bookmark.type).toBe('bookmark');
    expect(bookmark.url).toBe('https://example.com');
  });

  it('create: bookmark without url gets type="folder"', () => {
    const mgr = new BookmarkManager();

    const folder = mgr.create({ title: 'Folder' });

    expect(folder.type).toBe('folder');
    expect(folder.url).toBeUndefined();
  });

  it('create: assigns position based on sibling count', () => {
    const mgr = new BookmarkManager();

    const b0 = mgr.create({ title: 'A', url: 'https://a.com' });
    const b1 = mgr.create({ title: 'B', url: 'https://b.com' });
    const b2 = mgr.create({ title: 'C', url: 'https://c.com' });

    expect(b0.position).toBe(0);
    expect(b1.position).toBe(1);
    expect(b2.position).toBe(2);
  });

  it('create: default parentId is null (root)', () => {
    const mgr = new BookmarkManager();

    const bookmark = mgr.create({ title: 'Root', url: 'https://example.com' });

    expect(bookmark.parentId).toBeNull();
  });

  it('create: emits "created" event', () => {
    const mgr = new BookmarkManager();
    const listener = vi.fn();
    mgr.on('created', listener);

    const bookmark = mgr.create({ title: 'Example', url: 'https://example.com' });

    expect(listener).toHaveBeenCalledWith(bookmark);
  });

  it('create: generates unique IDs', () => {
    const mgr = new BookmarkManager();

    const b1 = mgr.create({ title: 'A', url: 'https://a.com' });
    const b2 = mgr.create({ title: 'B', url: 'https://b.com' });

    expect(b1.id).not.toBe(b2.id);
    expect(b1.id.length).toBeGreaterThan(0);
  });

  // ===== list 测试 =====

  it('list: returns all bookmarks when parentId is undefined', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'A', url: 'https://a.com' });
    const folder = mgr.create({ title: 'F' });
    mgr.create({ title: 'B', url: 'https://b.com', parentId: folder.id });

    expect(mgr.list()).toHaveLength(3);
  });

  it('list: returns root bookmarks when parentId is null', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'A', url: 'https://a.com' });
    const folder = mgr.create({ title: 'F' });
    mgr.create({ title: 'B', url: 'https://b.com', parentId: folder.id });

    const root = mgr.list(null);

    expect(root).toHaveLength(2);
    expect(root.map((b) => b.title)).toEqual(['A', 'F']);
  });

  it('list: returns children of specific parent', () => {
    const mgr = new BookmarkManager();

    const folder = mgr.create({ title: 'F' });
    mgr.create({ title: 'A', url: 'https://a.com', parentId: folder.id });
    mgr.create({ title: 'B', url: 'https://b.com', parentId: folder.id });
    mgr.create({ title: 'Root', url: 'https://r.com' });

    const children = mgr.list(folder.id);

    expect(children).toHaveLength(2);
    expect(children.map((b) => b.title)).toEqual(['A', 'B']);
  });

  it('list: sorts by position asc', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'First', url: 'https://1.com' });
    mgr.create({ title: 'Second', url: 'https://2.com' });
    mgr.create({ title: 'Third', url: 'https://3.com' });

    const root = mgr.list(null);

    expect(root.map((b) => b.position)).toEqual([0, 1, 2]);
    expect(root.map((b) => b.title)).toEqual(['First', 'Second', 'Third']);
  });

  // ===== search 测试 =====

  it('search: matches by title (case-insensitive)', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'GitHub', url: 'https://example.com' });
    mgr.create({ title: 'GitLab', url: 'https://other.com' });

    const results = mgr.search('GITHUB');

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('GitHub');
  });

  it('search: matches by url (case-insensitive)', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'Social', url: 'https://GitHub.com/feed' });
    mgr.create({ title: 'Other', url: 'https://example.com' });

    const results = mgr.search('github');

    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://GitHub.com/feed');
  });

  it('search: only searches bookmarks not folders', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'GitHubFolder' });
    mgr.create({ title: 'GitHubMark', url: 'https://github.com' });

    const results = mgr.search('github');

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('GitHubMark');
    expect(results[0]!.type).toBe('bookmark');
  });

  it('search: respects limit', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'a-example', url: 'https://a.com' });
    mgr.create({ title: 'b-example', url: 'https://b.com' });
    mgr.create({ title: 'c-example', url: 'https://c.com' });

    const results = mgr.search('example', 2);

    expect(results).toHaveLength(2);
  });

  it('search: returns empty for no matches', () => {
    const mgr = new BookmarkManager();

    mgr.create({ title: 'Example', url: 'https://example.com' });

    const results = mgr.search('nonexistent');

    expect(results).toHaveLength(0);
  });

  // ===== delete 测试 =====

  it('delete: removes bookmark', () => {
    const mgr = new BookmarkManager();

    const bookmark = mgr.create({ title: 'A', url: 'https://a.com' });
    expect(mgr.getCount()).toBe(1);

    mgr.delete(bookmark.id);

    expect(mgr.getCount()).toBe(0);
    expect(mgr.list()).toHaveLength(0);
  });

  it('delete: throws for non-existent id', () => {
    const mgr = new BookmarkManager();

    expect(() => mgr.delete('non-existent-id')).toThrow(/not found/i);
  });

  it('delete: cascades deletion for folders (deletes children recursively)', () => {
    const mgr = new BookmarkManager();

    const folder = mgr.create({ title: 'Folder' });
    mgr.create({ title: 'Child1', url: 'https://1.com', parentId: folder.id });
    const subFolder = mgr.create({ title: 'SubFolder', parentId: folder.id });
    mgr.create({ title: 'GrandChild', url: 'https://2.com', parentId: subFolder.id });
    mgr.create({ title: 'Root', url: 'https://root.com' });

    expect(mgr.getCount()).toBe(5);

    mgr.delete(folder.id);

    // 文件夹 + 2 个直接子节点 + 1 个孙节点 = 4 个被删除
    expect(mgr.getCount()).toBe(1);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.title).toBe('Root');
  });

  it('delete: emits "deleted" event', () => {
    const mgr = new BookmarkManager();
    const listener = vi.fn();
    mgr.on('deleted', listener);

    const bookmark = mgr.create({ title: 'A', url: 'https://a.com' });
    mgr.delete(bookmark.id);

    expect(listener).toHaveBeenCalledWith(bookmark);
  });

  // ===== events 测试 =====

  it('events: on/off listener registration', () => {
    const mgr = new BookmarkManager();
    const listener = vi.fn();

    mgr.on('created', listener);

    mgr.create({ title: 'A', url: 'https://a.com' });
    expect(listener).toHaveBeenCalledTimes(1);

    mgr.off('created', listener);

    mgr.create({ title: 'B', url: 'https://b.com' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
