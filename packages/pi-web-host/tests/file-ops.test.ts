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
