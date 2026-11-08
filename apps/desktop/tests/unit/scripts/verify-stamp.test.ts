/**
 * verify 内容指纹（G16 推送门禁前置件）单测——scripts/mark-verify-ok.mjs
 *
 * 背景（dev.161 → dev.162 实证盲点）：指纹以 `git stash create` 取工作区树，
 * 而 stash **不含 untracked 文件**——dev.161 提交新文档时该文件 untracked，
 * verify 通过但提交后 HEAD 树与指纹失配，push 被 G16 拦下、被迫重跑全量 verify。
 *
 * 验收口径（AGENTS.md §五.6 ①「内容已验证才可 push」）：verify（指纹）
 * → git add -A + commit 后，「提交产出的 HEAD 树」必须等于指纹树——
 * 工作区当前内容（含 untracked，排除 .gitignore 命中项，与
 * `git status --porcelain` 口径一致）被完整编入指纹。
 *
 * 测试方式：真实脚本执行（child_process 起 node 跑 scripts/mark-verify-ok.mjs），
 * 各用例独占临时 git 仓库（init → commit → 触发 → 断言），不共享状态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// tests/unit/scripts → unit → tests → apps/desktop → apps → 仓库根（5 层）
const REPO_ROOT = resolve(here, '..', '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'mark-verify-ok.mjs');
const STAMP_FILE = join('.git', 'urchin-verify-ok');

let repoDir = '';

interface Stamp {
  tree: string;
  head: string;
  at: string;
}

/** 在临时仓库内执行 git 命令（禁 gpg 签名，保证环境可重复） */
function git(args: string[], cwd: string = repoDir): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** 在临时仓库内运行 verify 指纹脚本，返回写入的 stamp */
function runStampScript(): Stamp {
  execFileSync(process.execPath, [SCRIPT], { cwd: repoDir, encoding: 'utf8' });
  const stampPath = join(repoDir, STAMP_FILE);
  return JSON.parse(readFileSync(stampPath, 'utf8')) as Stamp;
}

beforeEach(() => {
  // 基础提交：单 tracked 文件，作为全部场景的公共起点
  repoDir = mkdtempSync(join(tmpdir(), 'urchin-stamp-test-'));
  execFileSync('git', ['init'], { cwd: repoDir });
  git(['config', 'user.email', 'stamp-test@example.com']);
  git(['config', 'user.name', 'stamp-test']);
  // 统一 LF，断言只关心内容差异而非平台换行策略
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoDir, 'base.md'), 'base v1\n');
  git(['add', '-A']);
  git(['commit', '-m', 'base']);
});

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

describe('mark-verify-ok 内容指纹', () => {
  it('should include untracked files in the fingerprint so the committed tree matches (dev.161 现场：新文档 untracked)', () => {
    // dev.161 精确现场：只有 untracked 新文件，tracked 文件无修改
    const nested = join(repoDir, 'docs');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'new-doc.md'), 'new doc\n');

    const stamp = runStampScript();
    // 模拟后续 git add -A + commit
    git(['add', '-A']);
    git(['commit', '-m', 'commit new doc']);

    // 提交产出的 HEAD 树必须等于 verify 时记录的指纹（否则 G16 会拦下 push）
    const committedTree = git(['show', '-s', '--format=%T', 'HEAD']);
    expect(committedTree).toEqual(stamp.tree);
  });

  it('should match the committed tree when tracked edits and untracked files exist together', () => {
    // tracked 修改 + untracked 并存（verify → commit 前的常态工作区）
    writeFileSync(join(repoDir, 'base.md'), 'base v2\n');
    writeFileSync(join(repoDir, 'extra.txt'), 'extra\n');

    const stamp = runStampScript();
    git(['add', '-A']);
    git(['commit', '-m', 'edit + add']);

    const committedTree = git(['show', '-s', '--format=%T', 'HEAD']);
    expect(committedTree).toEqual(stamp.tree);
  });

  it('should exclude gitignored files from the fingerprint (与 git status --porcelain 口径一致)', () => {
    // .gitignore 命中项不得进指纹：add -A 自动跳过，提交后的树才是基准
    writeFileSync(join(repoDir, '.gitignore'), 'base v1\n*.log\n');
    writeFileSync(join(repoDir, 'noise.log'), 'ignored noise\n');
    writeFileSync(join(repoDir, 'real.md'), 'real work\n');

    const stamp = runStampScript();
    git(['add', '-A']);
    git(['commit', '-m', 'commit real work only']);

    const committedTree = git(['show', '-s', '--format=%T', 'HEAD']);
    expect(committedTree).toEqual(stamp.tree);
  });

  it('should use the HEAD tree when the worktree is clean (fast path 不回归)', () => {
    const stamp = runStampScript();
    const headTree = git(['show', '-s', '--format=%T', 'HEAD']);
    expect(stamp.tree).toEqual(headTree);
    // 结构不回归：head / at 字段仍在
    expect(stamp.head).toBe(git(['rev-parse', 'HEAD']));
    expect(Number.isNaN(Date.parse(stamp.at))).toBe(false);
  });

  it('should overwrite the stamp with the current worktree on each run (重复 verify 更新指纹)', () => {
    writeFileSync(join(repoDir, 'base.md'), 'base v2\n');
    const first = runStampScript();
    expect(first.tree).toBeTruthy();
    writeFileSync(join(repoDir, 'base.md'), 'base v3\n');
    const second = runStampScript();
    expect(second.tree).not.toEqual(first.tree);
  });
});
