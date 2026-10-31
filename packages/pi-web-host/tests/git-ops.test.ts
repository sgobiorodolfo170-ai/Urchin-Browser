/**
 * git-ops.ts 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getGitStatus, getGitHistory, getGitFileDiff, getGitCommitDetail } from '../src/git-ops';

describe('git-ops', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'pi-git-test-'));
    execSync('git init', { cwd: repoDir, timeout: 5000 });
    execSync('git config user.email test@test.com', { cwd: repoDir });
    execSync('git config user.name Test', { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('getGitStatus', () => {
    it('should return empty results for non-git directory', async () => {
      const nonGit = mkdtempSync(join(tmpdir(), 'pi-nongit-'));
      try {
        const result = await getGitStatus(nonGit);
        expect(result.ok).toBe(true);
        expect(result.files).toEqual([]);
        expect(result.branches).toEqual([]);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it('should return empty status for fresh repo', async () => {
      const result = await getGitStatus(repoDir);
      expect(result.ok).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.files).toEqual([]);
    });

    it('should detect untracked files', async () => {
      writeFileSync(join(repoDir, 'new.txt'), 'content');
      const result = await getGitStatus(repoDir);
      expect(result.ok).toBe(true);
      expect(result.files!.length).toBeGreaterThanOrEqual(1);
      const newFile = result.files!.find((f) => f.path === 'new.txt');
      expect(newFile).toBeDefined();
      expect(newFile!.x).toBe('?');
    });

    it('should detect modified files after commit', async () => {
      writeFileSync(join(repoDir, 'file.txt'), 'original');
      execSync('git add .', { cwd: repoDir });
      execSync('git commit -m "init"', { cwd: repoDir });
      writeFileSync(join(repoDir, 'file.txt'), 'modified');
      const result = await getGitStatus(repoDir);
      expect(result.ok).toBe(true);
      const modFile = result.files!.find((f) => f.path === 'file.txt');
      expect(modFile).toBeDefined();
    });

    it('should list branches', async () => {
      writeFileSync(join(repoDir, 'file.txt'), 'x');
      execSync('git add .', { cwd: repoDir });
      execSync('git commit -m "init"', { cwd: repoDir });
      const result = await getGitStatus(repoDir);
      expect(result.branches!.length).toBeGreaterThanOrEqual(1);
      const current = result.branches!.find((b) => b.current);
      expect(current).toBeDefined();
    });
  });

  describe('getGitHistory', () => {
    it('should fail for fresh repo with no commits', async () => {
      const result = await getGitHistory(repoDir);
      expect(result.ok).toBe(false);
    });

    it('should return commits after commits exist', async () => {
      writeFileSync(join(repoDir, 'file.txt'), 'content');
      execSync('git add .', { cwd: repoDir });
      execSync('git commit -m "first commit"', { cwd: repoDir });
      const result = await getGitHistory(repoDir);
      expect(result.ok).toBe(true);
      expect(result.history!.length).toBeGreaterThanOrEqual(1);
      expect(result.history![0].subject).toBe('first commit');
      expect(result.history![0].hash).toBeDefined();
      expect(result.history![0].shortHash).toBeDefined();
      expect(result.history![0].author).toBe('Test');
    });
  });

  describe('getGitFileDiff', () => {
    it('should detect untracked file', async () => {
      writeFileSync(join(repoDir, 'untracked.txt'), 'content');
      const result = await getGitFileDiff(repoDir, 'untracked.txt');
      expect(result.ok).toBe(true);
      expect(result.untracked).toBe(true);
    });

    it('should return staged and worktree diff', async () => {
      writeFileSync(join(repoDir, 'file.txt'), 'original');
      execSync('git add .', { cwd: repoDir });
      execSync('git commit -m "init"', { cwd: repoDir });
      writeFileSync(join(repoDir, 'file.txt'), 'modified content');
      execSync('git add file.txt', { cwd: repoDir });
      const result = await getGitFileDiff(repoDir, 'file.txt');
      expect(result.ok).toBe(true);
      expect(result.untracked).toBe(false);
    });
  });

  describe('getGitCommitDetail', () => {
    it('should return commit details', async () => {
      writeFileSync(join(repoDir, 'file.txt'), 'content');
      execSync('git add .', { cwd: repoDir });
      execSync('git commit -m "test commit"', { cwd: repoDir });
      const hash = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
      const result = await getGitCommitDetail(repoDir, hash);
      expect(result.ok).toBe(true);
      expect(result.stagedText).toContain('test commit');
    });

    it('should fail for non-existent commit', async () => {
      const result = await getGitCommitDetail(repoDir, 'nonexistent');
      expect(result.ok).toBe(false);
    });
  });
});
