/**
 * scm.ts 单元测试
 *
 * 全部离线：每个用例在系统临时目录里 `git init` 一个本地仓库（含一个
 * --bare 远端），通过真实 git 调用驱动 scmStatus / scmHistory /
 * scmFileDiff / scmCommitDetail / scmCommitContext，并验证非仓库降级。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitDirOf,
  isNotRepoError,
  scmCommitContext,
  scmCommitDetail,
  scmFileDiff,
  scmHistory,
  scmStatus,
} from '../../src/pi-server/scm.js';

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 15_000 });
}

function initRepo(dir: string): void {
  gitIn(dir, 'init', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'test@urchin.local');
  gitIn(dir, 'config', 'user.name', 'Urchin Test');
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
}

function commitAll(dir: string, message: string): void {
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-m', message);
}

const cleanups: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，清理失败不影响断言
    }
  }
});

describe('gitDirOf', () => {
  it('should resolve the absolute git dir for a repository', async () => {
    const repo = tempDir('urchin-scm-dir-');
    initRepo(repo);
    const dir = await gitDirOf(repo);
    expect(dir).toBeTruthy();
    expect(dir!.replace(/\\/g, '/').endsWith('/.git')).toBe(true);
  });

  it('should return null for a directory that is not a repository', async () => {
    const plain = tempDir('urchin-scm-plain-');
    await expect(gitDirOf(plain)).resolves.toBeNull();
  });
});

describe('isNotRepoError', () => {
  it('should detect the git not-a-repository message', () => {
    expect(
      isNotRepoError(
        new Error('fatal: not a git repository (or any of the parent directories): .git'),
      ),
    ).toBe(true);
    expect(isNotRepoError('fatal: not a Git repository')).toBe(true);
  });

  it('should reject unrelated errors', () => {
    expect(isNotRepoError(new Error('fatal: bad revision'))).toBe(false);
    expect(isNotRepoError(undefined)).toBe(false);
  });
});

describe('scmStatus', () => {
  let repo: string;

  beforeEach(() => {
    repo = tempDir('urchin-scm-status-');
    initRepo(repo);
  });

  it('should report an empty working tree for a fresh repository', async () => {
    const status = await scmStatus(repo);
    expect(status.notRepo).toBe(false);
    expect(status.branch).toBe('main');
    expect(status.detached).toBe(false);
    expect(status.files).toEqual([]);
    expect(status.stats).toEqual({});
  });

  it('should list untracked files with ?? markers', async () => {
    writeFileSync(join(repo, 'new.txt'), 'content\n');
    const status = await scmStatus(repo);
    const entry = status.files.find((f) => f.path === 'new.txt');
    expect(entry).toBeDefined();
    expect(entry!.x).toBe('?');
    expect(entry!.y).toBe('?');
  });

  it('should report modified files and their worktree line stats', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    commitAll(repo, 'init');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');

    const status = await scmStatus(repo);
    const entry = status.files.find((f) => f.path === 'a.txt');
    expect(entry).toBeDefined();
    expect(entry!.y).toBe('M');
    expect(status.stats['a.txt']).toEqual([1, 0]);
  });

  it('should merge staged and worktree stats for the same path', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    commitAll(repo, 'init');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    gitIn(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');

    const status = await scmStatus(repo);
    expect(status.stats['a.txt']).toEqual([2, 0]);
  });

  it('should list the current local branch', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    const status = await scmStatus(repo);
    const current = status.branches.find((b) => b.name === 'main');
    expect(current).toBeDefined();
    expect(current!.current).toBe(true);
  });

  it('should parse upstream, ahead and remote branches against a local bare remote', async () => {
    const remote = tempDir('urchin-scm-remote-');
    gitIn(remote, 'init', '--bare', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    gitIn(repo, 'remote', 'add', 'origin', remote);
    gitIn(repo, 'push', '-u', 'origin', 'main');

    writeFileSync(join(repo, 'b.txt'), 'y\n');
    commitAll(repo, 'second');

    const status = await scmStatus(repo);
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.upstreamGone).toBe(false);
    const remoteBranch = status.branches.find((b) => b.name === 'origin/main');
    expect(remoteBranch).toBeDefined();
    expect(remoteBranch!.current).toBe(false);
    expect(remoteBranch!.remote).toBe('origin');
  });

  it('should report behind when the local clone fetched newer remote commits', async () => {
    const remote = tempDir('urchin-scm-remote-behind-');
    gitIn(remote, 'init', '--bare', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    gitIn(repo, 'remote', 'add', 'origin', remote);
    gitIn(repo, 'push', '-u', 'origin', 'main');

    const clone = tempDir('urchin-scm-clone-');
    gitIn(remote, 'clone', remote, clone);
    gitIn(clone, 'config', 'user.email', 'test@urchin.local');
    gitIn(clone, 'config', 'user.name', 'Urchin Test');
    writeFileSync(join(clone, 'c.txt'), 'z\n');
    gitIn(clone, 'add', '-A');
    gitIn(clone, 'commit', '-m', 'remote ahead');
    gitIn(clone, 'push', 'origin', 'main');

    gitIn(repo, 'fetch', 'origin');
    const status = await scmStatus(repo);
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(1);
  });

  it('should flag an upstream branch that disappeared', async () => {
    const remote = tempDir('urchin-scm-remote-gone-');
    gitIn(remote, 'init', '--bare', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    gitIn(repo, 'remote', 'add', 'origin', remote);
    gitIn(repo, 'push', '-u', 'origin', 'main');
    gitIn(remote, 'update-ref', '-d', 'refs/heads/main');
    gitIn(repo, 'fetch', '--prune', 'origin');

    const status = await scmStatus(repo);
    expect(status.upstream).toBe('origin/main');
    expect(status.upstreamGone).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('should flag a detached HEAD', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    gitIn(repo, 'checkout', '--detach', 'HEAD');

    const status = await scmStatus(repo);
    expect(status.detached).toBe(true);
  });

  it('should resolve with notRepo instead of throwing outside a repository', async () => {
    const plain = tempDir('urchin-scm-nonrepo-');
    // D13 回归：scmStatus 并发跑 4 条 git，非仓库下 `git diff --cached --numstat` 报的是
    // 「error: unknown option `cached'」而非 not-a-git-repository；旧实现用 Promise.all，
    // 谁先 reject 决定结果 → 高并发下偶发把 notRepo 误判成普通错误。这里连跑多次锁死语义。
    for (let i = 0; i < 5; i += 1) {
      const status = await scmStatus(plain);
      expect(status.notRepo).toBe(true);
      expect(status.empty).toBe(true);
      expect(status.files).toEqual([]);
      expect(status.branches).toEqual([]);
    }
  });

  it('should mark a repository without commits as empty', async () => {
    const status = await scmStatus(repo);
    expect(status.notRepo).toBe(false);
    expect(status.empty).toBe(true);
  });

  it('should not mark a repository with commits as empty', async () => {
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    commitAll(repo, 'init');
    const status = await scmStatus(repo);
    expect(status.empty).toBe(false);
  });
});

describe('scmHistory', () => {
  let repo: string;

  beforeEach(() => {
    repo = tempDir('urchin-scm-history-');
    initRepo(repo);
  });

  it('should return commits newest first with author, subject and hashes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    commitAll(repo, 'feat: first');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    commitAll(repo, 'fix: second');

    const history = await scmHistory(repo);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].subject).toBe('fix: second');
    expect(history[1].subject).toBe('feat: first');
    expect(history[0].author).toBe('Urchin Test');
    expect(history[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(history[0].shortHash.length).toBeGreaterThanOrEqual(7);
    expect(history[0].shortHash.length).toBeLessThanOrEqual(40);
    expect(history[0].date).toBeTruthy();
  });

  it('should return an empty history on a repository without any commit', async () => {
    await expect(scmHistory(repo)).resolves.toEqual([]);
  });
});

describe('scmFileDiff', () => {
  let repo: string;

  beforeEach(() => {
    repo = tempDir('urchin-scm-diff-');
    initRepo(repo);
  });

  it('should return both staged and worktree diffs for the path', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    commitAll(repo, 'init');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    gitIn(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');

    const diff = await scmFileDiff(repo, 'a.txt');
    expect(diff.staged).toContain('+two');
    expect(diff.staged).not.toContain('+three');
    expect(diff.worktree).toContain('+three');
  });

  it('should return empty strings instead of throwing for unknown paths', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    commitAll(repo, 'init');
    const diff = await scmFileDiff(repo, 'does-not-exist.txt');
    expect(diff).toEqual({ staged: '', worktree: '' });
  });
});

describe('scmCommitDetail', () => {
  it('should include the commit message and patch', async () => {
    const repo = tempDir('urchin-scm-detail-');
    initRepo(repo);
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    commitAll(repo, 'docs: add greeting');

    const hash = gitIn(repo, 'rev-parse', 'HEAD').trim();
    const detail = await scmCommitDetail(repo, hash);
    expect(detail).toContain('docs: add greeting');
    expect(detail).toContain('+hello');
  });
});

describe('scmCommitContext', () => {
  let repo: string;

  beforeEach(() => {
    repo = tempDir('urchin-scm-context-');
    initRepo(repo);
  });

  it('should report an empty repository with no pending changes', async () => {
    const ctx = await scmCommitContext(repo);
    expect(ctx.emptyRepo).toBe(true);
    expect(ctx.subjects).toEqual([]);
    expect(ctx.files).toEqual([]);
    expect(ctx.stagedPatch).toBe('');
    expect(ctx.worktreePatch).toBe('');
  });

  it('should collect subjects, files and both patches', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    commitAll(repo, 'feat: alpha');
    gitIn(repo, 'commit', '--allow-empty', '-m', 'feat: beta');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    gitIn(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'c.txt'), 'c\nchanged\n');
    writeFileSync(join(repo, 'b.txt'), 'untracked\n');

    const ctx = await scmCommitContext(repo);
    expect(ctx.emptyRepo).toBe(false);
    expect(ctx.subjects).toEqual(['feat: beta', 'feat: alpha']);
    expect(ctx.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(ctx.stagedPatch).toContain('+two');
    expect(ctx.stagedStat['a.txt']).toEqual([1, 0]);
    expect(ctx.worktreePatch).toContain('+changed');
  });

  it('should truncate an oversized diff with an explicit marker', async () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line-${i}-0123456789abcdef`).join('\n');
    writeFileSync(join(repo, 'big.txt'), `${lines}\n`);
    gitIn(repo, 'add', 'big.txt');

    const ctx = await scmCommitContext(repo);
    expect(ctx.stagedPatch.length).toBeLessThanOrEqual(12_000 + 40);
    expect(ctx.stagedPatch.endsWith('… (diff truncated)')).toBe(true);
  });

  it('should reject outside a repository', async () => {
    const plain = tempDir('urchin-scm-context-nonrepo-');
    await expect(scmCommitContext(plain)).rejects.toThrow(/not a git repository/i);
  });
});
