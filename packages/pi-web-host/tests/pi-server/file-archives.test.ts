import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import {
  archiveName,
  createArchive,
  extractArchive,
  safeDestination,
  safeEntryPath,
} from '../../src/pi-server/file-archives.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-archive-test-'));
  roots.push(root);
  await mkdir(join(root, 'folder', 'nested'), { recursive: true });
  await mkdir(join(root, 'folder', 'empty'));
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'folder', 'nested', '中文.txt'), 'hello');
  await writeFile(join(root, 'folder', 'empty.txt'), '');
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('archiveName', () => {
  it('should use a timestamp only for folders', () => {
    expect(archiveName('/tmp/a.txt', false)).toBe('a.txt.tar.gz');
    expect(archiveName('/tmp/folder', true, new Date('2026-01-02T03:04:05Z'))).toBe(
      'folder-2026-01-02T03-04-05-000Z.tar.gz',
    );
  });
});

describe('safeEntryPath', () => {
  it.each([
    '../escape',
    '/absolute',
    'C:\\escape',
    'a/../../x',
    'a\\..\\x',
    'a//x',
    'NUL.txt',
    'a/x:stream',
    'a/\u0000x',
    'a/x.\u0020',
  ])('should reject the unsafe path %s', (name) => {
    expect(() => safeEntryPath(name)).toThrow();
  });

  it('should normalise leading ./ and trailing slashes', () => {
    expect(safeEntryPath('./folder/a.txt')).toBe('folder/a.txt');
    expect(safeEntryPath('folder/')).toBe('folder');
    expect(safeEntryPath('a/b\\c.txt')).toBe('a/b/c.txt');
  });

  it('should reject over-long names and too many segments', () => {
    expect(() => safeEntryPath('a'.repeat(4097))).toThrow();
    expect(() => safeEntryPath(Array.from({ length: 129 }, () => 'a').join('/'))).toThrow();
  });
});

describe('safeDestination', () => {
  it('should join safe segments under the destination root', async () => {
    const root = await fixture();
    expect(await safeDestination(root, 'folder/a.txt')).toBe(join(root, 'folder', 'a.txt'));
  });

  it('should reject traversal segments', async () => {
    const root = await fixture();
    await expect(safeDestination(root, '../escape.txt')).rejects.toThrow('Unsafe entry path');
  });
});

describe('createArchive / extractArchive', () => {
  it('should round-trip a recursive folder with unicode names, empty files and empty dirs', async () => {
    const root = await fixture();
    const archive = await createArchive(join(root, 'folder'));
    expect(archive.name).toMatch(/^folder-.*\.tar\.gz$/);
    expect(await extractArchive(archive.path, join(root, 'out'), 'skip')).toEqual({
      written: 2,
      skipped: 0,
    });
    expect(await readFile(join(root, 'out/folder/nested/中文.txt'), 'utf8')).toBe('hello');
    expect(await readdir(join(root, 'out/folder/empty'))).toEqual([]);
    expect(await readFile(join(root, 'out/folder/empty.txt'), 'utf8')).toBe('');
  });

  it('should refuse to overwrite an existing compression output', async () => {
    const root = await fixture();
    const file = join(root, 'file.txt');
    await writeFile(file, 'original');
    const first = await createArchive(file);
    const content = await readFile(first.path);
    await expect(createArchive(file)).rejects.toThrow();
    expect(await readFile(first.path)).toEqual(content);
  });

  it('should honour skip, overwrite and preflight conflict rejection', async () => {
    const root = await fixture();
    const archive = await createArchive(join(root, 'folder'));
    await mkdir(join(root, 'out/folder/nested'), { recursive: true });
    const existing = join(root, 'out/folder/nested/中文.txt');
    await writeFile(existing, 'keep');
    await expect(extractArchive(archive.path, join(root, 'out'), 'error')).rejects.toThrow(
      'already exists',
    );
    await expect(readFile(join(root, 'out/folder/empty.txt'))).rejects.toThrow();
    await extractArchive(archive.path, join(root, 'out'), 'skip');
    expect(await readFile(existing, 'utf8')).toBe('keep');
    await extractArchive(archive.path, join(root, 'out'), 'overwrite');
    expect(await readFile(existing, 'utf8')).toBe('hello');
  });

  it('should reject an invalid conflict policy and a non-directory destination', async () => {
    const root = await fixture();
    const archive = await createArchive(join(root, 'folder'));
    await expect(extractArchive(archive.path, join(root, 'out'), 'bogus' as never)).rejects.toThrow(
      'Invalid conflict policy',
    );
    const file = join(root, 'plain.txt');
    await writeFile(file, 'x');
    await expect(extractArchive(archive.path, file, 'skip')).rejects.toThrow(
      'Destination must be a directory',
    );
  });

  it('should extract gzip files', async () => {
    const root = await fixture();
    const path = join(root, 'hello.txt.gz');
    await writeFile(path, gzipSync('gzip content'));
    await extractArchive(path, join(root, 'out'), 'skip');
    expect(await readFile(join(root, 'out/hello.txt'), 'utf8')).toBe('gzip content');
  });

  it('should accept normal tar archives whose paths begin with ./', async () => {
    const root = await fixture();
    const path = join(root, 'normal.tar');
    await tar.c({ file: path, cwd: join(root, 'folder') }, ['.']);
    await extractArchive(path, join(root, 'out'), 'skip');
    expect(await readFile(join(root, 'out/nested/中文.txt'), 'utf8')).toBe('hello');
  });

  it('should extract ZIP and reject ZIP traversal before touching the destination', async () => {
    const root = await fixture();
    const good =
      'UEsDBBQAAAAIAPGRMV112oQwDQAAAAsAAAAQAAAAZm9sZGVyL2hlbGxvLnR4dKvKLFBIzs8rSc0rAQBQSwECFAMUAAAACADxkTFdddqEMA0AAAALAAAAEAAAAAAAAAAAAAAAgAEAAAAAZm9sZGVyL2hlbGxvLnR4dFBLBQYAAAAAAQABAD4AAAA7AAAAAAA=';
    const bad =
      'UEsDBBQAAAAIAPGRMV112oQwDQAAAAsAAAANAAAALi4vZXNjYXBlLnR4dKvKLFBIzs8rSc0rAQBQSwECFAMUAAAACADxkTFdddqEMA0AAAALAAAADQAAAAAAAAAAAAAAgAEAAAAALi4vZXNjYXBlLnR4dFBLBQYAAAAAAQABADsAAAA4AAAAAAA=';
    const zip = join(root, 'test.zip');
    await writeFile(zip, Buffer.from(good, 'base64'));
    await extractArchive(zip, join(root, 'out'), 'skip');
    expect(await readFile(join(root, 'out/folder/hello.txt'), 'utf8')).toBe('zip content');
    await writeFile(zip, Buffer.from(bad, 'base64'));
    await expect(extractArchive(zip, join(root, 'out'), 'overwrite')).rejects.toThrow();
    await expect(readFile(join(root, 'escape.txt'))).rejects.toThrow();
  });

  it.each(['../escape.txt', '/absolute.txt', 'C:/escape.txt'])(
    'should reject the unsafe TAR header %s',
    async (path) => {
      const root = await fixture();
      const header = new tar.Header({ path, type: 'File', size: 1, mode: 0o600 });
      header.encode();
      const archive = join(root, 'bad.tar');
      await writeFile(
        archive,
        Buffer.concat([header.block!, Buffer.from('x'), Buffer.alloc(1535)]),
      );
      await expect(extractArchive(archive, join(root, 'out'), 'overwrite')).rejects.toThrow();
      expect(await readdir(join(root, 'out'))).toEqual([]);
    },
  );

  it('should reject unsupported archive formats and filesystem roots', async () => {
    const root = await fixture();
    const weird = join(root, 'thing.rar');
    await writeFile(weird, 'not an archive');
    await expect(extractArchive(weird, join(root, 'out'), 'skip')).rejects.toThrow(
      'Supported archives: ZIP, TAR, TAR.GZ, TGZ, GZ',
    );
    await expect(createArchive(join(root, 'missing'))).rejects.toThrow();
  });

  it('should refuse to archive a source containing hard links', async () => {
    const root = await fixture();
    const a = join(root, 'folder', 'hard-a.txt');
    const b = join(root, 'folder', 'hard-b.txt');
    await writeFile(a, 'shared');
    await link(a, b);
    await expect(createArchive(join(root, 'folder'))).rejects.toThrow('hard links');
  });

  it('should reject extracting an archive whose payload would overwrite the archive itself', async () => {
    const root = await fixture();
    const dest = join(root, 'out');
    const payload = join(root, 'payload');
    await mkdir(payload);
    const name = 'self.tar.gz';
    await writeFile(join(payload, name), 'payload');
    await tar.c({ file: join(dest, name), cwd: payload, gzip: true }, [name]);
    await expect(extractArchive(join(dest, name), dest, 'skip')).rejects.toThrow(
      'overwrite itself',
    );
  });
});
