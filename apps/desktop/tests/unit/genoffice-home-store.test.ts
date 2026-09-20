/**
 * GenOffice Home 本地状态存储（home-store）单元测试
 *
 * 覆盖：空状态加载、最近去重置顶与截断、星标开关、路径重绑（改名/移动）、
 * 路径遗忘（删除）、默认目录/语言持久化跨实例读取。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenOfficeHomeStore, RECENT_LIMIT } from '../../src/main/genoffice/home-store';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'urchin-genoffice-home-store-'));
  storePath = join(dir, 'genoffice-home.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GenOfficeHomeStore', () => {
  it('should load empty state when the file does not exist', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await expect(store.load()).resolves.toEqual({ recent: [], starred: [] });
  });

  it('should record recents with dedupe, most-recent-first and cap', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.recordRecent('C:\\a.md');
    await store.recordRecent('C:\\b.md');
    await store.recordRecent('C:\\a.md');

    expect(store.get().recent).toEqual(['C:\\a.md', 'C:\\b.md']);

    for (let i = 0; i < RECENT_LIMIT + 5; i += 1) {
      await store.recordRecent(`C:\\many\\${i}.md`);
    }
    expect(store.get().recent).toHaveLength(RECENT_LIMIT);
  });

  it('should toggle stars and remove recents', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.toggleStar('C:\\a.md');
    await store.toggleStar('C:\\b.md');
    expect(store.get().starred).toEqual(['C:\\b.md', 'C:\\a.md']);

    await store.toggleStar('C:\\a.md');
    expect(store.get().starred).toEqual(['C:\\b.md']);

    await store.recordRecent('C:\\a.md');
    await store.recordRecent('C:\\b.md');
    await store.removeRecent(['C:\\a.md']);
    expect(store.get().recent).toEqual(['C:\\b.md']);
  });

  it('should rebind paths after rename (files and directory prefixes)', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.recordRecent('C:\\docs\\old.md');
    await store.recordRecent('C:\\docs\\folder\\inner.md');
    await store.toggleStar('C:\\docs\\old.md');

    await store.rebindPath('C:\\docs', 'C:\\work');

    expect(store.get().recent).toEqual(['C:\\work\\folder\\inner.md', 'C:\\work\\old.md']);
    expect(store.get().starred).toEqual(['C:\\work\\old.md']);
  });

  it('should forget deleted paths and their children', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.recordRecent('C:\\docs\\keep.md');
    await store.recordRecent('C:\\docs\\gone\\a.md');
    await store.toggleStar('C:\\docs\\gone\\a.md');

    await store.forgetPaths(['C:\\docs\\gone']);

    expect(store.get().recent).toEqual(['C:\\docs\\keep.md']);
    expect(store.get().starred).toEqual([]);
  });

  it('should persist default save dir and language across instances', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.setDefaultSaveDir('C:\\work');
    await store.setLanguage('en');

    const reloaded = new GenOfficeHomeStore(storePath);
    await reloaded.load();
    expect(reloaded.get().defaultSaveDir).toBe('C:\\work');
    expect(reloaded.get().language).toBe('en');
  });

  it('should fall back to empty state for corrupted files', async () => {
    const store = new GenOfficeHomeStore(storePath);
    await store.setLanguage('zh');
    // 写入非法 JSON 后重载
    const { writeFileSync } = await import('node:fs');
    writeFileSync(storePath, '{not json', 'utf-8');

    const reloaded = new GenOfficeHomeStore(storePath);
    await expect(reloaded.load()).resolves.toEqual({ recent: [], starred: [] });
  });
});
