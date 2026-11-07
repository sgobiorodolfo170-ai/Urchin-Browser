/**
 * file-ops.ts 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleFileOps } from '../src/file-ops';

describe('file-ops', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-fileops-test-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('list_files', () => {
    it('should list files in agentDir', async () => {
      writeFileSync(join(agentDir, 'file1.txt'), 'hello');
      writeFileSync(join(agentDir, 'file2.ts'), 'code');
      const result = await handleFileOps({ type: 'list_files', path: '' }, agentDir);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('files');
      const files = (
        result as unknown as { files: { entries: { name: string; isDirectory: boolean }[] } }
      ).files;
      expect(files.entries.length).toBeGreaterThanOrEqual(2);
      const names = files.entries.map((e) => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('file2.ts');
    });

    it('should list subdirectory contents', async () => {
      mkdirSync(join(agentDir, 'subdir'), { recursive: true });
      writeFileSync(join(agentDir, 'subdir', 'inner.txt'), 'inner');
      const result = await handleFileOps({ type: 'list_files', path: 'subdir' }, agentDir);
      expect(result).not.toBeNull();
      const files = (result as unknown as { files: { entries: { name: string }[] } }).files;
      expect(files.entries[0].name).toBe('inner.txt');
    });

    it('should return empty entries for non-existent path', async () => {
      const result = await handleFileOps({ type: 'list_files', path: 'nonexistent' }, agentDir);
      expect(result).not.toBeNull();
      const files = (result as unknown as { files: { entries: unknown[] } }).files;
      expect(files.entries).toEqual([]);
    });
  });

  describe('read_file', () => {
    it('should read file content', async () => {
      writeFileSync(join(agentDir, 'test.txt'), 'Hello World');
      const result = await handleFileOps({ type: 'read_file', path: 'test.txt' }, agentDir);
      expect(result).not.toBeNull();
      const content = (
        result as unknown as { content: { text: string; name: string; kind: string } }
      ).content;
      expect(content.text).toBe('Hello World');
      expect(content.name).toBe('test.txt');
      expect(content.kind).toBe('text');
    });

    it('should return null for empty path', async () => {
      const result = await handleFileOps({ type: 'read_file', path: '' }, agentDir);
      expect(result).toBeNull();
    });

    it('should return null for non-existent file', async () => {
      const result = await handleFileOps({ type: 'read_file', path: 'nope.txt' }, agentDir);
      expect(result).toBeNull();
    });
  });

  describe('write_file', () => {
    it('should write file and return file_changed', async () => {
      const result = await handleFileOps(
        { type: 'write_file', path: 'new.txt', text: 'written content' },
        agentDir,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe('file_changed');
      expect((result as unknown as { path: string }).path).toBe('new.txt');
    });

    it('should create parent directories', async () => {
      const result = await handleFileOps(
        { type: 'write_file', path: 'sub/deep/file.txt', text: 'nested' },
        agentDir,
      );
      expect(result).not.toBeNull();
    });

    it('should return null for empty path', async () => {
      const result = await handleFileOps({ type: 'write_file', path: '', text: 'x' }, agentDir);
      expect(result).toBeNull();
    });
  });

  describe('complete_path', () => {
    it('should return matching entries for prefix', async () => {
      writeFileSync(join(agentDir, 'apple.txt'), '');
      writeFileSync(join(agentDir, 'app.ts'), '');
      writeFileSync(join(agentDir, 'banana.txt'), '');
      const result = await handleFileOps({ type: 'complete_path', path: 'app' }, agentDir);
      expect(result).not.toBeNull();
      const completions = (result as unknown as { completions: { name: string; type: string }[] })
        .completions;
      expect(completions.length).toBe(2);
      const names = completions.map((c) => c.name);
      expect(names).toContain('apple.txt');
      expect(names).toContain('app.ts');
    });

    it('should return empty for no matches', async () => {
      const result = await handleFileOps({ type: 'complete_path', path: 'zzz' }, agentDir);
      expect(result).not.toBeNull();
      expect((result as unknown as { completions: unknown[] }).completions).toEqual([]);
    });

    it('should handle directory prefix', async () => {
      mkdirSync(join(agentDir, 'src'), { recursive: true });
      writeFileSync(join(agentDir, 'src', 'index.ts'), '');
      writeFileSync(join(agentDir, 'src', 'util.ts'), '');
      const result = await handleFileOps({ type: 'complete_path', path: 'src/i' }, agentDir);
      expect(result).not.toBeNull();
      const completions = (result as unknown as { completions: { name: string }[] }).completions;
      expect(completions).toHaveLength(1);
      expect(completions[0].name).toBe('index.ts');
    });

    // ── 以下是 cwd 选择器真目录浏览（机器根/跨 agentDir 绝对路径）──
    // 回归背景：旧实现经 safePath 锁死 agentDir，绝对路径一律 throw → 空列表，
    // 「打开项目」弹窗因此无法浏览磁盘（盘符/目录列表恒空）。

    const getCompletions = (result: unknown): { name: string; path: string; type: string }[] =>
      (result as { completions: { name: string; path: string; type: string }[] }).completions;

    it('should list disk drives for machine root @root', async () => {
      const result = await handleFileOps({ type: 'complete_path', path: '@root' }, agentDir);
      const completions = getCompletions(result);
      if (process.platform === 'win32') {
        // Windows：至少有系统盘，条目形如 "C:"。
        expect(completions.length).toBeGreaterThan(0);
        for (const c of completions) {
          expect(c.type).toBe('dir');
          expect(c.path).toMatch(/^[A-Za-z]:$/);
        }
      } else {
        // posix：机器根即 "/"（不可列出则允许空，Terminal 只在桌面机跑）。
        if (completions.length > 0) expect(completions[0].path).toBe('/');
      }
    });

    it('should browse an absolute directory outside agentDir', async () => {
      // 旧实现此处 throw('path outside root') → 空列表（打开项目主根因）。
      const outside = mkdtempSync(join(tmpdir(), 'pi-fileops-outside-'));
      try {
        mkdirSync(join(outside, 'myproject'), { recursive: true });
        writeFileSync(join(outside, 'myproject', 'README.md'), 'x');
        writeFileSync(join(outside, 'loose.txt'), '');
        const result = await handleFileOps(
          { type: 'complete_path', path: `${outside.replace(/\\/g, '/')}/` },
          agentDir,
        );
        const completions = getCompletions(result);
        const names = completions.map((c) => c.name);
        expect(names).toContain('myproject');
        expect(names).toContain('loose.txt');
        const project = completions.find((c) => c.name === 'myproject')!;
        expect(project.type).toBe('dir');
        // wire path 为 "/" 分隔绝对路径（前端直接 setBrowsePath 往下走）。
        expect(project.path.replace(/\\/g, '/')).toBe(
          join(outside, 'myproject').replace(/\\/g, '/'),
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('should apply prefix filtering on absolute paths', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'pi-fileops-prefix-'));
      try {
        mkdirSync(join(outside, 'alpha'), { recursive: true });
        mkdirSync(join(outside, 'beta'), { recursive: true });
        const result = await handleFileOps(
          { type: 'complete_path', path: `${outside.replace(/\\/g, '/')}/a` },
          agentDir,
        );
        const completions = getCompletions(result);
        expect(completions).toHaveLength(1);
        expect(completions[0].name).toBe('alpha');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('should expand ~ to home directory listings', async () => {
      const result = await handleFileOps({ type: 'complete_path', path: '~/' }, agentDir);
      const completions = getCompletions(result);
      // 内容不可断言（机器差异），但应成功解析为主目录而不是回空前的 throw 路径：
      // 至少保证回数组（多数系统 . Thumbs 之类文件存在；空数组不算失败，
      // 这里只验证不抛错且条目若存在必为绝对 "/" 风格路径）。
      expect(Array.isArray(completions)).toBe(true);
      for (const c of completions) {
        expect(c.path.startsWith('/') || /^[A-Za-z]:\//.test(c.path)).toBe(true);
      }
    });

    it('should return empty for a nonexistent absolute directory', async () => {
      const result = await handleFileOps(
        { type: 'complete_path', path: 'G:/pi-fileops-definitely-missing-99999/' },
        agentDir,
      );
      expect(getCompletions(result)).toEqual([]);
    });
  });

  describe('search_files', () => {
    it('should return empty result with ok=true', async () => {
      const result = await handleFileOps(
        { type: 'search_files', reqId: 1, query: 'test' },
        agentDir,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe('search_files_result');
      expect((result as unknown as { reqId: number; ok: boolean; results: unknown[] }).ok).toBe(
        true,
      );
      expect((result as unknown as { results: unknown[] }).results).toEqual([]);
    });
  });

  describe('get_settings / set_settings', () => {
    it('should return empty settings when no file', async () => {
      const result = await handleFileOps({ type: 'get_settings' }, agentDir);
      expect(result).not.toBeNull();
      expect((result as unknown as { settings: Record<string, unknown> }).settings).toEqual({});
    });

    it('should persist and read settings', async () => {
      await handleFileOps(
        { type: 'set_settings', settings: { theme: 'dark', fontSize: 14 } },
        agentDir,
      );
      const result = await handleFileOps({ type: 'get_settings' }, agentDir);
      expect(result).not.toBeNull();
      const settings = (result as unknown as { settings: Record<string, unknown> }).settings;
      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
    });

    it('should overwrite settings on re-set', async () => {
      await handleFileOps({ type: 'set_settings', settings: { a: 1 } }, agentDir);
      await handleFileOps({ type: 'set_settings', settings: { b: 2 } }, agentDir);
      const result = await handleFileOps({ type: 'get_settings' }, agentDir);
      const settings = (result as unknown as { settings: Record<string, unknown> }).settings;
      expect(settings.a).toBeUndefined();
      expect(settings.b).toBe(2);
    });
  });

  describe('unknown types', () => {
    it('should return null for unknown message type', async () => {
      const result = await handleFileOps({ type: 'unknown_op' }, agentDir);
      expect(result).toBeNull();
    });
  });
});
