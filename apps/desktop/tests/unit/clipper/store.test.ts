/**
 * 剪藏落盘：文件名净化、重名、目录创建与 Markdown 写入。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClipperStore,
  sanitizeClipName,
  uniqueClipPath,
  type ExistsFn,
} from '../../../src/main/clipper/store';

const dirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urchin-clipper-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('clipper store', () => {
  it('should sanitize Windows illegal chars and strip known extension', () => {
    expect(sanitizeClipName('a<b>c:d/e\\f?.md')).toBe('a_b_c_d_e_f_');
    expect(sanitizeClipName('   ')).toBe('untitled');
    expect(sanitizeClipName('.hidden')).toBe('.hidden');
  });

  it('should append (2) when file exists', async () => {
    const dir = await makeRoot();
    const existing = new Set<string>([join(dir, 'name.md')]);
    const exists: ExistsFn = (path) => Promise.resolve(existing.has(path));
    await expect(uniqueClipPath(dir, 'name', 'md', exists)).resolves.toBe(join(dir, 'name (2).md'));
  });

  it('should create clipper dir and save markdown', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    const path = await store.saveMarkdown('标题', '# hi');
    expect(path).toContain(join(root, 'clipper'));
    await expect(readFile(path, 'utf-8')).resolves.toBe('# hi');
  });

  it('should not overwrite when saving same name twice', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    const first = await store.saveMarkdown('same', 'one');
    const second = await store.saveMarkdown('same', 'two');
    expect(first).not.toBe(second);
    expect(second).toContain('same (2).md');
  });

  it('should write markdown to a pre-reserved path (CL11 image localization)', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    const path = await store.reservePath('clipped', 'md');
    await store.writeMarkdownTo(path, '# body with image');
    await expect(readFile(path, 'utf-8')).resolves.toBe('# body with image');
  });

  it('should save markdown into a sub-directory', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    const path = await store.saveMarkdown('note', 'body', 'subfolder');
    expect(path).toContain(join('clipper', 'subfolder'));
    await expect(readFile(path, 'utf-8')).resolves.toBe('body');
  });

  it('should list sub-directories (excluding dot-folders and files)', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    // 创建 clipper 根目录下的一些子目录和文件
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(store.clipDir, 'alpha'), { recursive: true });
    await mkdir(join(store.clipDir, 'beta'), { recursive: true });
    await mkdir(join(store.clipDir, '.hidden'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(store.clipDir, 'afile.md'), '');
    const dirs = await store.listSubDirs();
    expect(dirs).toEqual(['alpha', 'beta']);
  });

  it('should sanitize sub-directory name (reject path traversal)', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root });
    // 路径分隔符 → 下划线，开头点去除，防止路径穿越
    const path = await store.saveMarkdown('note', 'body', '../evil');
    expect(path).toContain(join('clipper', '_evil'));
    expect(path).not.toContain('..');
  });

  it('should save into custom dir when clipper.saveDir is an absolute path', async () => {
    const root = await makeRoot();
    const custom = join(root, 'custom-clips');
    const store = new ClipperStore({
      documentsRoot: root,
      customDir: () => custom,
    });
    expect(store.clipDir).toBe(custom);
    const path = await store.saveMarkdown('note', 'body');
    expect(path).toContain(join(custom, 'note.md'));
    await expect(readFile(path, 'utf-8')).resolves.toBe('body');
  });

  it('should fall back to default clipDir when custom dir is empty or relative', async () => {
    const root = await makeRoot();
    const store = new ClipperStore({ documentsRoot: root, customDir: () => '' });
    expect(store.clipDir).toBe(join(root, 'clipper'));
    // 相对路径视为未设置（isAbsolute 拦截），回退默认
    const relative = new ClipperStore({ documentsRoot: root, customDir: () => 'clips' });
    expect(relative.clipDir).toBe(join(root, 'clipper'));
    // 默认目录下正常落盘
    const path = await store.saveMarkdown('note', 'body');
    expect(path).toContain(join(root, 'clipper', 'note.md'));
  });

  it('should pick up custom dir changes dynamically (effective without restart)', async () => {
    const root = await makeRoot();
    let setting = '';
    const store = new ClipperStore({ documentsRoot: root, customDir: () => setting });
    expect(store.clipDir).toBe(join(root, 'clipper'));
    setting = join(root, 'later');
    expect(store.clipDir).toBe(join(root, 'later'));
    // 子目录也拼接到自定义目录下
    const path = await store.saveMarkdown('note', 'body', 'sub');
    expect(path).toContain(join(root, 'later', 'sub', 'note.md'));
  });
});
