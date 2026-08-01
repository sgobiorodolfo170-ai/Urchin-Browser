/**
 * SummaryManager · 摘要文档本地存储管理单元测试
 *
 * 验证：
 * 1. setSaveDirectory / getSaveDirectory：自定义目录解析与默认目录回退
 * 2. listTree：递归扫描生成目录树（目录在前/文件按 mtime 降序/空目录跳过/非 html 忽略）
 * 3. listTree：目录不存在时返回空树
 * 4. saveDocument：按年月分目录、净化非法文件名、mkdir+writeFile、返回路径
 * 5. deleteDocument：目录内删除成功、目录外路径拒绝
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    readdir: fsMocks.readdir,
    stat: fsMocks.stat,
    mkdir: fsMocks.mkdir,
    writeFile: fsMocks.writeFile,
    unlink: fsMocks.unlink,
  },
  default: {
    promises: {
      readdir: fsMocks.readdir,
      stat: fsMocks.stat,
      mkdir: fsMocks.mkdir,
      writeFile: fsMocks.writeFile,
      unlink: fsMocks.unlink,
    },
  },
}));

vi.mock('node:fs/promises', () => ({
  readdir: fsMocks.readdir,
  stat: fsMocks.stat,
  mkdir: fsMocks.mkdir,
  writeFile: fsMocks.writeFile,
  unlink: fsMocks.unlink,
}));

import { SummaryManager } from '../../src/main/summary/summary-manager';
import * as path from 'node:path';

function makeDirent(name: string, type: 'file' | 'directory'): import('node:fs').Dirent {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as import('node:fs').Dirent;
}

describe('SummaryManager', () => {
  const userData = 'C:\\UserData';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('save directory', () => {
    it('should use default userData/summaries when no custom dir set', () => {
      const m = new SummaryManager(userData);
      expect(m.getSaveDirectory()).toBe(path.join(userData, 'summaries'));
    });

    it('should resolve custom dir with trim', () => {
      const m = new SummaryManager(userData);
      m.setSaveDirectory('  C:\\My  Summaries  ');
      expect(m.getSaveDirectory()).toBe(path.resolve('C:\\My  Summaries'));
    });

    it('should fall back to default when null / empty / whitespace', () => {
      const m = new SummaryManager(userData);
      m.setSaveDirectory(null);
      expect(m.getSaveDirectory()).toBe(path.join(userData, 'summaries'));
      m.setSaveDirectory('');
      expect(m.getSaveDirectory()).toBe(path.join(userData, 'summaries'));
      m.setSaveDirectory('   ');
      expect(m.getSaveDirectory()).toBe(path.join(userData, 'summaries'));
    });
  });

  describe('listTree', () => {
    it('should scan recursively and build tree with dirs before files', async () => {
      const root = path.join(userData, 'summaries');
      fsMocks.readdir.mockImplementation((dir: string) => {
        if (dir === root) {
          return [
            makeDirent('2026-07', 'directory'),
            makeDirent('2026-08', 'directory'),
            makeDirent('readme.txt', 'file'),
            makeDirent('note.html', 'file'),
          ];
        }
        if (dir === path.join(root, '2026-07')) {
          return [makeDirent('empty-sub', 'directory'), makeDirent('a.html', 'file')];
        }
        if (dir === path.join(root, '2026-08')) {
          return [makeDirent('b.html', 'file'), makeDirent('c.html', 'file')];
        }
        if (dir === path.join(root, '2026-07', 'empty-sub')) {
          return []; // 空目录应被跳过
        }
        return [];
      });
      fsMocks.stat.mockImplementation((file: string) => {
        if (String(file).endsWith('a.html')) return Promise.resolve({ size: 10, mtimeMs: 100 });
        if (String(file).endsWith('b.html')) return Promise.resolve({ size: 20, mtimeMs: 300 });
        if (String(file).endsWith('c.html')) return Promise.resolve({ size: 30, mtimeMs: 200 });
        return Promise.resolve({ size: 0, mtimeMs: 0 });
      });

      const m = new SummaryManager(userData);
      const { tree, rootPath } = await m.listTree();

      expect(rootPath).toBe(root);
      // 目录在前：2026-08 > 2026-07（降序）
      expect(tree[0]!.type).toBe('directory');
      expect(tree[0]!.name).toBe('2026-08');
      expect(tree[1]!.name).toBe('2026-07');
      // 文件：note.html（相对路径含根目录）
      expect(tree[2]!.type).toBe('file');
      expect(tree[2]!.name).toBe('note.html');
      // 非 html 文件 readme.txt 被忽略
      expect(tree.map((n) => n.name)).not.toContain('readme.txt');

      const july = tree[1] as unknown as { children: { name: string }[] };
      // 空目录 empty-sub 被跳过，只有 a.html
      expect(july.children.map((c) => c.name)).toEqual(['a.html']);

      const august = tree[0] as unknown as { children: { name: string; modifiedAt: number }[] };
      expect(august.children.map((c) => c.name)).toEqual(['b.html', 'c.html']);
      // 文件按 mtime 降序：b(300) 在 c(200) 前
    });

    it('should return empty tree when root unreadable', async () => {
      fsMocks.readdir.mockRejectedValue(new Error('ENOENT'));
      const m = new SummaryManager(userData);
      const { tree } = await m.listTree();
      expect(tree).toEqual([]);
    });

    it('should include file stat info when available', async () => {
      fsMocks.readdir.mockResolvedValue([makeDirent('x.html', 'file')]);
      fsMocks.stat.mockResolvedValue({ size: 42, mtimeMs: 1234 });
      const m = new SummaryManager(userData);
      const { tree } = await m.listTree();

      expect(tree[0]).toMatchObject({ name: 'x.html', size: 42, modifiedAt: 1234 });
    });

    it('should tolerate stat failure', async () => {
      fsMocks.readdir.mockResolvedValue([makeDirent('x.html', 'file')]);
      fsMocks.stat.mockRejectedValue(new Error('EACCES'));
      const m = new SummaryManager(userData);
      const { tree } = await m.listTree();

      expect(tree[0]).toMatchObject({ size: undefined, modifiedAt: undefined });
    });
  });

  describe('saveDocument', () => {
    it('should create month dir and write sanitized file', async () => {
      const m = new SummaryManager(userData);
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dateStr = `${yearMonth}-${String(now.getDate()).padStart(2, '0')}`;

      const result = await m.saveDocument('<html></html>', 'My: Doc / "Title"');

      const root = path.join(userData, 'summaries');
      expect(fsMocks.mkdir).toHaveBeenCalledWith(path.join(root, yearMonth), { recursive: true });
      const fileName = `${dateStr}_My_ Doc _ _Title_.html`;
      expect(fsMocks.writeFile).toHaveBeenCalledWith(
        path.join(root, yearMonth, fileName),
        '<html></html>',
        'utf-8',
      );
      expect(result.relativePath).toBe(`${yearMonth}/${fileName}`);
      expect(result.documentTitle).toBe('My: Doc / "Title"');
    });

    it('should use untitled for empty title and collapse whitespace', async () => {
      const m = new SummaryManager(userData);
      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const dateStr = `${yearMonth}-${String(now.getDate()).padStart(2, '0')}`;

      const result = await m.saveDocument('<html></html>', '  ');

      expect(result.relativePath).toBe(`${yearMonth}/${dateStr}_untitled.html`);
      expect(fsMocks.writeFile).toHaveBeenCalled();
    });
  });

  describe('deleteDocument', () => {
    const root = path.join(userData, 'summaries');

    it('should unlink file inside save directory', async () => {
      const m = new SummaryManager(userData);
      const target = path.join(root, '2026-08', 'doc.html');

      await m.deleteDocument(target);

      expect(fsMocks.unlink).toHaveBeenCalledWith(target);
    });

    it('should throw when path outside save directory', async () => {
      const m = new SummaryManager(userData);
      const outside = path.join(userData, 'other', 'secret.html');

      await expect(m.deleteDocument(outside)).rejects.toThrow(/outside save directory/i);
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });
  });
});
