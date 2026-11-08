/**
 * wait-subscription-scan.ts 单元测试
 *
 * 该模块是「会话能否被置换 / 是否要保留活跃会话」的唯一磁盘证据来源。
 * 所有 fail-open 边界（目录缺失、坏 JSON、伪造 token、过期、跨会话/跨 pid）
 * 都必须返回「无证据」，否则会误留会话或误杀仍在运行的任务。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  hasActiveSubagentRun,
  hasPendingWaitSubscription,
  hasRunningBackgroundTask,
  resolveAsyncRunsDir,
  resolveSubscriptionsDir,
  resolveTempScopeId,
  shouldRetainActive,
} from '../../src/pi-server/wait-subscription-scan.js';

const SESSION_FILE = '/root/.pi/agent/sessions/--proj--/2026-01-01T00-00-00Z_session.jsonl';
const NOW = Date.UTC(2026, 0, 1);
const TOKEN = '0ffbdaf3-c196-4e88-8ae2-0674b2586335';

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    token: TOKEN,
    sessionId: SESSION_FILE,
    targetKind: 'async',
    runId: 'run-1',
    requestedId: 'run-1',
    createdAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-web-host-waitsub-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeRecord(dir: string, value: unknown, file = `${TOKEN}.json`): void {
  writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
}

function makeRunLayout(dir: string, runId: string, status: Record<string, unknown>): string {
  const runsDir = path.join(dir, 'async-subagent-runs');
  const marker = path.join(runsDir, '.active-runs', runId);
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, '');
  mkdirSync(path.join(runsDir, runId), { recursive: true });
  writeFileSync(path.join(runsDir, runId, 'status.json'), JSON.stringify(status));
  return runsDir;
}

function runStatus(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    sessionId: SESSION_FILE,
    state: 'running',
    startedAt: NOW - 1000,
    ...overrides,
  };
}

describe('hasPendingWaitSubscription', () => {
  it('should report no evidence when the subscriptions directory is missing', () => {
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: path.join(makeDir(), 'missing', 'wait-subscriptions'),
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should report no evidence for an empty directory', () => {
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: makeDir(),
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should retain the session for a matching unexpired subscription', () => {
    const dir = makeDir();
    writeRecord(dir, record());
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(true);
  });

  it('should ignore an expired subscription', () => {
    const dir = makeDir();
    writeRecord(dir, record({ expiresAt: NOW - 1 }));
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should ignore subscriptions belonging to another session', () => {
    const dir = makeDir();
    writeRecord(dir, record({ sessionId: '/other/session.jsonl' }));
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should treat corrupt JSON as no evidence (fail-open)', () => {
    const dir = makeDir();
    writeRecord(dir, '{ not json !!!', 'corrupt.json');
    const warnings: string[] = [];
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
        warn: (message) => warnings.push(message),
      }),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('should treat records with a missing version as no evidence', () => {
    const dir = makeDir();
    writeRecord(dir, { hello: 'world' }, 'foreign.json');
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should ignore non-json files', () => {
    const dir = makeDir();
    writeRecord(dir, record(), 'notes.txt');
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should report no evidence without a session id', () => {
    const dir = makeDir();
    writeRecord(dir, record());
    expect(hasPendingWaitSubscription({ subscriptionsDir: dir, now: () => NOW })).toBe(false);
  });

  it('should treat a non-finite expiresAt (1e999 -> Infinity) as no evidence', () => {
    const dir = makeDir();
    // 直接写原样 JSON 文本：JSON.stringify 会把 Infinity 变成 null，无法表达「非有限数值」
    const raw = JSON.stringify({ ...record(), expiresAt: 0 }).replace(
      '"expiresAt":0',
      '"expiresAt":1e999',
    );
    writeFileSync(path.join(dir, `${TOKEN}.json`), raw);
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should ignore records whose file name does not match the token', () => {
    const dir = makeDir();
    writeRecord(dir, record(), 'renamed.json');
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
      }),
    ).toBe(false);
  });

  it('should warn once on non-ENOENT IO errors and stay silent on ENOENT', () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    const dir = makeDir();
    mkdirSync(path.join(dir, 'foo.json'));
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: dir,
        sessionId: SESSION_FILE,
        now: () => NOW,
        warn,
      }),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    const silent: string[] = [];
    expect(
      hasPendingWaitSubscription({
        subscriptionsDir: path.join(makeDir(), 'nope'),
        sessionId: SESSION_FILE,
        now: () => NOW,
        warn: (m) => silent.push(m),
      }),
    ).toBe(false);
    expect(silent).toHaveLength(0);
  });
});

describe('hasActiveSubagentRun', () => {
  const STALE = 24 * 60 * 60 * 1000;

  it('should report no evidence when sessionId is missing', () => {
    const dir = makeDir();
    makeRunLayout(dir, 'run-1', runStatus());
    expect(hasActiveSubagentRun({ asyncRunsDir: path.join(dir, 'async-subagent-runs') })).toBe(
      false,
    );
  });

  it('should report no evidence when the index directory is missing', () => {
    expect(
      hasActiveSubagentRun({
        asyncRunsDir: path.join(makeDir(), 'missing', 'async-subagent-runs'),
        sessionId: SESSION_FILE,
      }),
    ).toBe(false);
  });

  it('should report no evidence for an empty index directory', () => {
    expect(
      hasActiveSubagentRun({
        asyncRunsDir: path.join(makeDir(), 'async-subagent-runs'),
        sessionId: SESSION_FILE,
      }),
    ).toBe(false);
  });

  it('should detect a running run for the same session', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus());
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
  });

  it('should detect a queued run for the same session', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus({ state: 'queued' }));
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
  });

  it('should ignore finished runs', () => {
    for (const state of ['complete', 'failed', 'partial', 'stopped', 'rejected', 'paused']) {
      const dir = makeDir();
      const runsDir = makeRunLayout(dir, 'run-1', runStatus({ state }));
      expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE }), state).toBe(
        false,
      );
    }
  });

  it('should ignore active runs of other sessions', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus({ sessionId: '/other/session.jsonl' }));
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
  });

  it('should hit when any of several runs belongs to this session', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(
      dir,
      'run-a',
      runStatus({ runId: 'run-a', sessionId: '/other/session.jsonl' }),
    );
    makeRunLayout(dir, 'run-b', runStatus({ runId: 'run-b' }));
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
  });

  it('should treat a missing or corrupt status.json as no evidence (fail-open)', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus());
    writeFileSync(path.join(runsDir, 'run-1', 'status.json'), '{ not json !!!');
    const warnings: string[] = [];
    expect(
      hasActiveSubagentRun({
        asyncRunsDir: runsDir,
        sessionId: SESSION_FILE,
        warn: (message) => warnings.push(message),
      }),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('should still trust a running status whose marker is older than 24h', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus());
    const marker = path.join(runsDir, '.active-runs', 'run-1');
    const past = NOW - STALE - 60_000;
    utimesSync(marker, new Date(past), new Date(past));
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(true);
  });

  it('should ignore stale markers whose run already finished', () => {
    const dir = makeDir();
    const runsDir = makeRunLayout(dir, 'run-1', runStatus({ state: 'complete' }));
    const marker = path.join(runsDir, '.active-runs', 'run-1');
    const past = NOW - STALE - 60_000;
    utimesSync(marker, new Date(past), new Date(past));
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
  });

  it('should ignore a marker whose status entity is missing', () => {
    const dir = makeDir();
    const runsDir = path.join(dir, 'async-subagent-runs');
    const marker = path.join(runsDir, '.active-runs', 'orphan');
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
  });

  it('should ignore hidden marker files', () => {
    const dir = makeDir();
    const runsDir = path.join(dir, 'async-subagent-runs');
    mkdirSync(path.join(runsDir, '.active-runs'), { recursive: true });
    writeFileSync(path.join(runsDir, '.active-runs', '.stale-tmp'), '');
    expect(hasActiveSubagentRun({ asyncRunsDir: runsDir, sessionId: SESSION_FILE })).toBe(false);
  });

  it('should warn on a non-ENOENT index scan failure', () => {
    const dir = makeDir();
    // 用同名文件占住 .active-runs，使 readdirSync 报 ENOTDIR 而不是 ENOENT
    const runsDir = path.join(dir, 'async-subagent-runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(path.join(runsDir, '.active-runs'), '');
    const warnings: string[] = [];
    expect(
      hasActiveSubagentRun({
        asyncRunsDir: runsDir,
        sessionId: SESSION_FILE,
        warn: (message) => warnings.push(message),
      }),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe('shouldRetainActive', () => {
  const base = {
    reviewing: false,
    wizardRunning: false,
    streaming: false,
    openTerminals: 0,
    listed: false,
    promptedSinceActive: false,
    hasActiveSubagentRun: false,
    hasPendingWake: false,
  };

  it('should allow displacement by default', () => {
    expect(shouldRetainActive(base)).toBe(false);
  });

  it('should retain while reviewing, running a wizard, streaming or with open terminals', () => {
    expect(shouldRetainActive({ ...base, reviewing: true })).toBe(true);
    expect(shouldRetainActive({ ...base, wizardRunning: true })).toBe(true);
    expect(shouldRetainActive({ ...base, streaming: true })).toBe(true);
    expect(shouldRetainActive({ ...base, openTerminals: 1 })).toBe(true);
  });

  it('should retain while a prompt is in flight', () => {
    expect(shouldRetainActive({ ...base, promptInFlight: true })).toBe(true);
  });

  it('should short-circuit before evaluating background thunks while a prompt is in flight', () => {
    expect(
      shouldRetainActive({
        ...base,
        promptInFlight: true,
        hasActiveSubagentRun: () => {
          throw new Error('must not be evaluated');
        },
        hasPendingWake: () => {
          throw new Error('must not be evaluated');
        },
      }),
    ).toBe(true);
  });

  it('should retain while compacting', () => {
    expect(shouldRetainActive({ ...base, compacting: true })).toBe(true);
  });

  it('should retain listed conversations that were prompted since activation', () => {
    expect(shouldRetainActive({ ...base, listed: true, promptedSinceActive: true })).toBe(true);
  });

  it('should retain when a pending wake subscription exists', () => {
    expect(shouldRetainActive({ ...base, hasPendingWake: true })).toBe(true);
  });

  it('should retain when an active subagent run exists', () => {
    expect(shouldRetainActive({ ...base, hasActiveSubagentRun: true })).toBe(true);
  });

  it('should always retain pinned conversations', () => {
    expect(shouldRetainActive({ ...base, pinned: true })).toBe(true);
    expect(
      shouldRetainActive({
        ...base,
        pinned: true,
        listed: false,
        promptedSinceActive: false,
        hasActiveSubagentRun: false,
        hasPendingWake: false,
      }),
    ).toBe(true);
  });

  it('should short-circuit before disk scans when pinned', () => {
    expect(
      shouldRetainActive({
        ...base,
        pinned: true,
        hasActiveSubagentRun: () => {
          throw new Error('must not be evaluated');
        },
        hasPendingWake: () => {
          throw new Error('must not be evaluated');
        },
      }),
    ).toBe(true);
  });

  it('should keep the default displacement policy when pinned is false or undefined', () => {
    expect(shouldRetainActive({ ...base, pinned: false })).toBe(false);
    expect(shouldRetainActive({ ...base, pinned: undefined })).toBe(false);
  });

  it('should evaluate the active-run thunk before the wake thunk', () => {
    expect(
      shouldRetainActive({
        ...base,
        hasActiveSubagentRun: () => true,
        hasPendingWake: () => {
          throw new Error('must not be evaluated');
        },
      }),
    ).toBe(true);
    let calls = 0;
    expect(
      shouldRetainActive({
        ...base,
        hasActiveSubagentRun: () => {
          calls += 1;
          return true;
        },
      }),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it('should evaluate thunks only after cheap checks', () => {
    expect(
      shouldRetainActive({
        ...base,
        streaming: true,
        hasActiveSubagentRun: () => {
          throw new Error('must not be evaluated');
        },
        hasPendingWake: () => {
          throw new Error('must not be evaluated');
        },
      }),
    ).toBe(true);
    let calls = 0;
    expect(
      shouldRetainActive({
        ...base,
        hasPendingWake: () => {
          calls += 1;
          return true;
        },
      }),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it('should honour boolean and thunk forms of the background task probe', () => {
    expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: true })).toBe(true);
    expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: () => true })).toBe(true);
    expect(shouldRetainActive({ ...base, hasRunningBackgroundTask: () => false })).toBe(false);
    expect(shouldRetainActive(base)).toBe(false);
  });
});

describe('resolveTempScopeId / resolveSubscriptionsDir', () => {
  const cleanEnv = { PATH: '/usr/bin' } as unknown as NodeJS.ProcessEnv;

  it('should use uid-N on platforms with getuid and user-<name> otherwise', () => {
    if (typeof process.getuid === 'function') {
      expect(resolveTempScopeId()).toMatch(/^uid-\d+$/);
    } else {
      expect(resolveTempScopeId()).toMatch(/^user-[\w.-]+$/);
    }
  });

  it('should fall back to USERNAME/USER/LOGNAME when getuid is unavailable', () => {
    expect(resolveTempScopeId({ ...cleanEnv, USER: 'john doe' }, null)).toBe('user-john-doe');
    expect(resolveTempScopeId({ ...cleanEnv, LOGNAME: 'ops' }, null)).toBe('user-ops');
    expect(resolveTempScopeId({ ...cleanEnv, USERNAME: ' Domain\\User ' }, null)).toBe(
      'user-Domain-User',
    );
  });

  it('should fall back to os.userInfo when no env user is present', () => {
    let username: string | null = null;
    try {
      username = userInfo().username;
    } catch {
      // 某些平台/容器里 userInfo() 可能抛错，此分支只作降级判断
    }
    if (username) {
      expect(resolveTempScopeId(cleanEnv, null)).toBe(`user-${username}`);
    } else {
      expect(resolveTempScopeId(cleanEnv, null)).toMatch(/^home-|^shared$/);
    }
  });

  it('should fall back to HOME/USERPROFILE and finally to shared', () => {
    expect(resolveTempScopeId({ ...cleanEnv, HOME: '/root' }, null, null)).toBe('home-root');
    expect(resolveTempScopeId({ ...cleanEnv, USERPROFILE: 'C:\\Users\\x' }, null, null)).toBe(
      'home-C-Users-x',
    );
    expect(resolveTempScopeId(cleanEnv, null, null, null)).toBe('shared');
  });

  it('should return "unknown" when the scope segment sanitizes to empty', () => {
    expect(resolveTempScopeId({ ...cleanEnv, USER: '///' }, null)).toBe('user-unknown');
  });

  it('should honour PI_SUBAGENTS_TEMP_ROOT including trailing slashes and relative paths', () => {
    expect(resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: '/tmp/custom' })).toBe(
      path.join(path.resolve('/tmp/custom'), 'wait-subscriptions'),
    );
    expect(resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: '/tmp/custom/' })).toBe(
      path.join(path.resolve('/tmp/custom'), 'wait-subscriptions'),
    );
    const resolved = resolveSubscriptionsDir({ PI_SUBAGENTS_TEMP_ROOT: 'rel/root' });
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith('wait-subscriptions')).toBe(true);
  });

  it('should share one temp root between subscriptions and async runs', () => {
    expect(resolveAsyncRunsDir({ PI_SUBAGENTS_TEMP_ROOT: '/tmp/custom' })).toBe(
      path.join(path.resolve('/tmp/custom'), 'async-subagent-runs'),
    );
    expect(resolveAsyncRunsDir(cleanEnv)).toBe(
      path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(cleanEnv)}`, 'async-subagent-runs'),
    );
    expect(path.dirname(resolveAsyncRunsDir(cleanEnv))).toBe(
      path.dirname(resolveSubscriptionsDir(cleanEnv)),
    );
  });
});

describe('hasRunningBackgroundTask', () => {
  const SESSION =
    '/home/u/.pi/agent/sessions/--proj--/2026-10-09T03-32-42-335Z_01a11eb8-60df-7150-9357-ba8dbbb73cff.jsonl';
  const UUID = '01a11eb8-60df-7150-9357-ba8dbbb73cff';
  const PID = 311227;

  function taskDir(cwd: string, pid = PID): string {
    const dir = path.join(cwd, '.pi', 'tasks', `${UUID}-${pid}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('should detect a running task in this process dir for this session', () => {
    const cwd = makeDir();
    writeFileSync(
      path.join(taskDir(cwd), 'b2c75ed2c.json'),
      JSON.stringify({ id: 'b2c75ed2c', status: 'running' }),
    );
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(true);
  });

  it('should ignore killed or completed tasks so conversations are not pinned forever', () => {
    const cwd = makeDir();
    const dir = taskDir(cwd);
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ status: 'killed', notified: false }));
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ status: 'completed' }));
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
  });

  it('should ignore leftover running tasks from another pid', () => {
    const cwd = makeDir();
    writeFileSync(path.join(taskDir(cwd, 99999), 'x.json'), JSON.stringify({ status: 'running' }));
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
  });

  it('should isolate by session UUID', () => {
    const cwd = makeDir();
    const other = path.join(cwd, '.pi', 'tasks', `00000000-0000-0000-0000-000000000000-${PID}`);
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'x.json'), JSON.stringify({ status: 'running' }));
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
  });

  it('should fail open for missing dirs, corrupt json and missing inputs', () => {
    const cwd = makeDir();
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
    writeFileSync(path.join(taskDir(cwd), 'bad.json'), '{not json');
    expect(hasRunningBackgroundTask({ cwd, sessionFile: SESSION, pid: PID })).toBe(false);
    expect(hasRunningBackgroundTask({ sessionFile: SESSION, pid: PID })).toBe(false);
    expect(hasRunningBackgroundTask({ cwd, pid: PID })).toBe(false);
  });
});
