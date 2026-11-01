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
});
