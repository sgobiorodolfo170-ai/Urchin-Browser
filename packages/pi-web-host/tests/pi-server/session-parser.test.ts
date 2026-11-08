/**
 * session-parser.ts 单元测试
 *
 * 覆盖三块磁盘侧逻辑：
 * 1. filterForkedParentSessions：fork 链只展示叶子、环/自环不误伤、跨平台路径归一；
 * 2. discoverRecentProjectsFromDisk：扁平根 + 每项目子目录两种布局、去重、排序、limit；
 * 3. findMostRecentSessionFileFast：按 cwd 匹配最新会话、额外会话根、缺失目录。
 *
 * vendored pi 未安装：SessionManager.create 用桩返回可预测的项目会话目录。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  DEFAULT_COMPACTION_SETTINGS: { reserveTokens: 16384 },
  // 真实 SessionManager.create(cwd).getSessionDir() 返回 agent 目录下的每 cwd 子目录；
  // 这里用可预测的 <cwd>/.pi-sessions 便于构造 fixture。
  SessionManager: {
    create: (cwd: string) => ({ getSessionDir: () => join(cwd, '.pi-sessions') }),
    open: () => {
      throw new Error('SessionManager.open is not used by session-parser tests');
    },
  },
}));

import {
  discoverRecentProjectsFromDisk,
  filterForkedParentSessions,
  findMostRecentSessionFileFast,
  parseSessionInfoFast,
} from '../../src/pi-server/session-parser.js';

const roots: string[] = [];

function makeDir(prefix = 'pi-web-host-parser-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const headerLine = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00.000Z', ...extra });

function writeSession(
  path: string,
  cwd: string,
  id = basename(path, '.jsonl'),
  atMs?: number,
): string {
  writeFileSync(
    path,
    [
      headerLine(id, cwd),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', timestamp: 1 } }),
      '',
    ].join('\n'),
  );
  if (atMs !== undefined) utimesSync(path, new Date(atMs), new Date(atMs));
  return path;
}

const originalSessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR;

afterEach(() => {
  if (originalSessionsRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
  else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionsRoot;
});

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface MockSessionInfo {
  path: string;
  parentSessionPath?: string;
  name?: string;
  modified: Date;
}

describe('filterForkedParentSessions', () => {
  it('should hide forked parents by default and keep only chain leaves plus independents', () => {
    const now = Date.now();
    const sessions: MockSessionInfo[] = [
      { path: '/sessions/session-1.jsonl', modified: new Date(now - 3000) },
      {
        path: '/sessions/session-2.jsonl',
        parentSessionPath: '/sessions/session-1.jsonl',
        modified: new Date(now - 2000),
      },
      {
        path: '/sessions/session-3.jsonl',
        parentSessionPath: '/sessions/session-2.jsonl',
        modified: new Date(now - 1000),
      },
      { path: '/sessions/independent.jsonl', modified: new Date(now - 500) },
    ];

    expect(filterForkedParentSessions(sessions, false).map((s) => s.path)).toEqual([
      '/sessions/session-3.jsonl',
      '/sessions/independent.jsonl',
    ]);
  });

  it('should keep parents and children when showForkedParents is true', () => {
    const now = Date.now();
    const sessions: MockSessionInfo[] = [
      { path: '/sessions/session-1.jsonl', modified: new Date(now - 2000) },
      {
        path: '/sessions/session-2.jsonl',
        parentSessionPath: '/sessions/session-1.jsonl',
        modified: new Date(now - 1000),
      },
    ];

    expect(filterForkedParentSessions(sessions, true).map((s) => s.path)).toEqual([
      '/sessions/session-1.jsonl',
      '/sessions/session-2.jsonl',
    ]);
  });

  it('should normalize path case and separators across platforms', () => {
    const sessions: MockSessionInfo[] = [
      { path: 'C:\\Sessions\\Parent.jsonl', modified: new Date() },
      {
        path: 'C:\\Sessions\\Child.jsonl',
        parentSessionPath: 'c:/sessions/parent.jsonl',
        modified: new Date(),
      },
    ];

    expect(filterForkedParentSessions(sessions).map((s) => s.path)).toEqual([
      'C:\\Sessions\\Child.jsonl',
    ]);
  });

  it('should not hide an entire parent/child cycle', () => {
    const sessions: MockSessionInfo[] = [
      { path: '/sessions/a.jsonl', parentSessionPath: '/sessions/b.jsonl', modified: new Date() },
      { path: '/sessions/b.jsonl', parentSessionPath: '/sessions/a.jsonl', modified: new Date() },
      { path: '/sessions/independent.jsonl', modified: new Date() },
    ];
    expect(filterForkedParentSessions(sessions).map((s) => s.path)).toEqual([
      '/sessions/a.jsonl',
      '/sessions/b.jsonl',
      '/sessions/independent.jsonl',
    ]);
  });

  it('should not hide a session whose parentSessionPath points to itself', () => {
    const sessions: MockSessionInfo[] = [
      {
        path: '/sessions/self.jsonl',
        parentSessionPath: '/sessions/self.jsonl',
        modified: new Date(),
      },
      { path: '/sessions/other.jsonl', modified: new Date() },
    ];
    expect(filterForkedParentSessions(sessions).map((s) => s.path)).toEqual([
      '/sessions/self.jsonl',
      '/sessions/other.jsonl',
    ]);
  });

  it('should keep a single session untouched and fall back to the input when everything is filtered', () => {
    const single: MockSessionInfo[] = [{ path: '/sessions/only.jsonl', modified: new Date() }];
    expect(filterForkedParentSessions(single)).toBe(single);

    // 两条互相指向的父子链 + 显式父路径不存在 → 无过滤依据，原样返回
    const dangling: MockSessionInfo[] = [
      {
        path: '/sessions/a.jsonl',
        parentSessionPath: '/missing/parent.jsonl',
        modified: new Date(),
      },
      {
        path: '/sessions/b.jsonl',
        parentSessionPath: '/missing/parent.jsonl',
        modified: new Date(),
      },
    ];
    expect(filterForkedParentSessions(dangling)).toBe(dangling);
  });
});

describe('discoverRecentProjectsFromDisk', () => {
  it('should collect recent projects from flat session files newest-first and dedupe by cwd', async () => {
    const root = makeDir();
    const projectA = makeDir('pi-proj-a-');
    const projectB = makeDir('pi-proj-b-');
    writeSession(join(root, 'a-old.jsonl'), projectA, 'a-old', 1_000);
    writeSession(join(root, 'a-new.jsonl'), projectA, 'a-new', 3_000);
    writeSession(join(root, 'b.jsonl'), projectB, 'b', 2_000);

    const projects = await discoverRecentProjectsFromDisk([root]);
    expect(projects.map((p) => p.path)).toEqual([projectA, projectB]);
    expect(projects[0].lastUsed).toBe(3_000);
  });

  it('should skip session files without a cwd or whose cwd no longer exists', async () => {
    const root = makeDir();
    const projectA = makeDir('pi-proj-a-');
    writeSession(join(root, 'no-cwd.jsonl'), '', 'no-cwd', 5_000);
    writeSession(join(root, 'gone.jsonl'), join(root, 'does-not-exist'), 'gone', 4_000);
    writeSession(join(root, 'ok.jsonl'), projectA, 'ok', 1_000);

    const projects = await discoverRecentProjectsFromDisk([root]);
    expect(projects.map((p) => p.path)).toEqual([projectA]);
  });

  it('should discover projects from per-cwd subdirectories using the newest transcript header', async () => {
    const root = makeDir();
    const projectA = makeDir('pi-proj-a-');
    const projectB = makeDir('pi-proj-b-');
    const dirA = join(root, 'proj-a');
    const dirB = join(root, 'proj-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    writeSession(join(dirA, 'older.jsonl'), projectA, 'older', 1_000);
    writeSession(join(dirA, 'newest.jsonl'), projectA, 'newest', 9_000);
    writeSession(join(dirB, 'only.jsonl'), projectB, 'only', 2_000);
    // 无 jsonl 的子目录被忽略
    mkdirSync(join(root, 'empty-project'));

    const projects = await discoverRecentProjectsFromDisk([root]);
    expect(projects.map((p) => p.path)).toEqual([projectA, projectB]);
    expect(projects[0].lastUsed).toBe(9_000);
  });

  it('should respect the limit and skip roots that do not exist', async () => {
    const missing = join(makeDir(), 'missing-root');
    const root = makeDir();
    const projectDirs = [makeDir('pi-proj-1-'), makeDir('pi-proj-2-'), makeDir('pi-proj-3-')];
    projectDirs.forEach((dir, i) =>
      writeSession(join(root, `s${i}.jsonl`), dir, `s${i}`, 1_000 + i),
    );

    expect(await discoverRecentProjectsFromDisk([missing, root], 10)).toHaveLength(3);
    const limited = await discoverRecentProjectsFromDisk([root], 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].path).toBe(projectDirs[2]);
    expect(await discoverRecentProjectsFromDisk([missing])).toEqual([]);
  });

  it('should ignore non-jsonl files and filesystem entries it cannot stat', async () => {
    const root = makeDir();
    const projectA = makeDir('pi-proj-a-');
    writeFileSync(join(root, 'readme.txt'), 'not a session');
    writeSession(join(root, 'session.jsonl'), projectA, 'session', 1_000);
    expect((await discoverRecentProjectsFromDisk([root])).map((p) => p.path)).toEqual([projectA]);
  });

  it('should stop early once the limit is reached across roots and flat files', async () => {
    const rootA = makeDir();
    const rootB = makeDir();
    const projectA = makeDir('pi-proj-a-');
    const projectB = makeDir('pi-proj-b-');
    writeSession(join(rootA, 'a.jsonl'), projectA, 'a', 2_000);
    writeSession(join(rootB, 'b.jsonl'), projectB, 'b', 1_000);

    const limited = await discoverRecentProjectsFromDisk([rootA, rootB], 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].path).toBe(projectA);
  });

  it('should batch-scan more than sixteen project subdirectories', async () => {
    const root = makeDir();
    const projects: string[] = [];
    for (let i = 0; i < 20; i++) {
      const dir = join(root, `proj-${String(i).padStart(2, '0')}`);
      mkdirSync(dir);
      const project = makeDir('pi-proj-batch-');
      projects.push(project);
      writeSession(join(dir, 'session.jsonl'), project, `s${i}`, 1_000 + i);
    }

    const found = await discoverRecentProjectsFromDisk([root], 20);
    expect(found).toHaveLength(20);
    // 最新的子目录（mtime 最大）排在最前
    expect(found[0].path).toBe(projects[19]);
  });
});

describe('findMostRecentSessionFileFast', () => {
  it('should return the newest transcript in a flat session dir', async () => {
    const dir = makeDir();
    const older = writeSession(join(dir, 'older.jsonl'), makeDir('pi-proj-old-'), 'older', 1_000);
    const newer = writeSession(join(dir, 'newer.jsonl'), makeDir('pi-proj-new-'), 'newer', 5_000);
    expect(await findMostRecentSessionFileFast(dir)).toBe(newer);
    expect(newer).not.toBe(older);
  });

  it('should prefer the newest transcript whose header cwd matches the target', async () => {
    const dir = makeDir();
    const projectA = makeDir('pi-proj-a-');
    const projectB = makeDir('pi-proj-b-');
    writeSession(join(dir, 'a.jsonl'), projectA, 'a', 1_000);
    writeSession(join(dir, 'b.jsonl'), projectB, 'b', 5_000);

    expect(await findMostRecentSessionFileFast(dir, projectA)).toBe(join(dir, 'a.jsonl'));
  });

  it('should fall back to the newest transcript when no header matches the target cwd', async () => {
    const dir = makeDir();
    writeSession(join(dir, 'b.jsonl'), makeDir('pi-proj-b-'), 'b', 5_000);
    expect(await findMostRecentSessionFileFast(dir, join(dir, 'unrelated'))).toBe(
      join(dir, 'b.jsonl'),
    );
  });

  it('should consult the per-cwd project dir when the session dir is flat-empty', async () => {
    const cwd = makeDir('pi-proj-cwd-');
    const projectDir = join(cwd, '.pi-sessions');
    mkdirSync(projectDir);
    const projectFile = writeSession(join(projectDir, 'project.jsonl'), cwd, 'project', 1_000);
    delete process.env.PI_CODING_AGENT_SESSION_DIR;

    expect(await findMostRecentSessionFileFast(cwd, cwd)).toBe(projectFile);
  });

  it('should pick the newest across the extra sessions root and its project-name subdir', async () => {
    const cwd = makeDir('pi-proj-cwd-');
    const projectDir = join(cwd, '.pi-sessions');
    mkdirSync(projectDir);
    writeSession(join(projectDir, 'project.jsonl'), cwd, 'project', 1_000);

    const extraRoot = makeDir('pi-extra-sessions-');
    const extraFile = writeSession(join(extraRoot, 'extra.jsonl'), cwd, 'extra', 9_000);
    const extraSubdir = join(extraRoot, basename(projectDir));
    mkdirSync(extraSubdir);
    writeSession(join(extraSubdir, 'sub.jsonl'), cwd, 'sub', 2_000);
    process.env.PI_CODING_AGENT_SESSION_DIR = extraRoot;

    // 三处都在候选集里：取最新
    expect(await findMostRecentSessionFileFast(cwd, cwd)).toBe(extraFile);

    // 目标 cwd 不匹配任何 header → 回退到整体最新
    expect(await findMostRecentSessionFileFast(cwd, join(extraRoot, 'nope'))).toBe(extraFile);
  });

  it('should fall back to the extra subdir transcript when it is the only newer candidate', async () => {
    const cwd = makeDir('pi-proj-cwd-');
    const projectDir = join(cwd, '.pi-sessions');
    mkdirSync(projectDir);
    writeSession(join(projectDir, 'project.jsonl'), cwd, 'project', 1_000);

    const extraRoot = makeDir('pi-extra-sessions-');
    const extraSubdir = join(extraRoot, basename(projectDir));
    mkdirSync(extraSubdir);
    const subFile = writeSession(join(extraSubdir, 'sub.jsonl'), cwd, 'sub', 5_000);
    process.env.PI_CODING_AGENT_SESSION_DIR = extraRoot;

    expect(await findMostRecentSessionFileFast(cwd, cwd)).toBe(subFile);
  });

  it('should return undefined for a missing session dir', async () => {
    const missing = join(makeDir(), 'not-there');
    expect(await findMostRecentSessionFileFast(missing)).toBeUndefined();
  });

  it('should return undefined when neither the dir nor the project dir has transcripts', async () => {
    const cwd = makeDir('pi-proj-empty-');
    const emptyRoot = join(cwd, 'no-sessions');
    mkdirSync(emptyRoot);
    process.env.PI_CODING_AGENT_SESSION_DIR = join(cwd, 'also-missing');
    expect(await findMostRecentSessionFileFast(emptyRoot)).toBeUndefined();
  });
});

describe('parseSessionInfoFast delegation', () => {
  it('should delegate to the incremental list scan by default and only gather text on request', async () => {
    const dir = makeDir();
    const cwd = makeDir('pi-proj-cwd-');
    const file = writeSession(join(dir, 's.jsonl'), cwd, 'sess-1', 1_000);

    const fast = await parseSessionInfoFast(file, 1_000);
    expect(fast).toMatchObject({
      id: 'sess-1',
      cwd,
      firstMessage: 'hi',
      messageCount: 1,
      allMessagesText: '',
    });

    const withText = await parseSessionInfoFast(file, 1_000, true);
    expect(withText?.allMessagesText).toContain('hi');
  });

  it('should return null for a transcript without a session header', async () => {
    const dir = makeDir();
    const file = join(dir, 'broken.jsonl');
    writeFileSync(file, '{"type":"message","message":{"role":"user","content":"hi"}}\n');
    expect(await parseSessionInfoFast(file, 1_000)).toBeNull();
    expect(await parseSessionInfoFast(file, 1_000, true)).toBeNull();
  });
});
