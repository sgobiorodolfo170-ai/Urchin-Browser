/**
 * session-open.ts 单元测试
 *
 * 背景：会话打开是「点开历史会话」的首个卡点。异步预解析版本（构造器直灌 entries）
 * 必须与 SDK 的同步 open() 语义一致，任何不一致都要能安全回退。
 *
 * vendored 的 @earendil-works/pi-coding-agent 在本仓未安装，改用语义等价的
 * SessionManager 桩（见 helpers/session-manager-stub.ts）钉住本模块的分支判定。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@earendil-works/pi-coding-agent',
  async () => await import('./helpers/session-manager-stub.js'),
);

import { StubSessionManager } from './helpers/session-manager-stub.js';
import { openSessionManagerAsync, parseJsonlSliced } from '../../src/pi-server/session-open.js';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  StubSessionManager.forceMismatch = false;
  StubSessionManager.openCalls.length = 0;
});

function pair(content: string): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), 'pi-web-host-open-'));
  dirs.push(dir);
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  writeFileSync(a, content);
  writeFileSync(b, content);
  return [a, b];
}

function snapshot(manager: unknown) {
  const stub = manager as StubSessionManager;
  return {
    id: stub.getSessionId(),
    cwd: stub.getCwd(),
    leaf: stub.getLeafId(),
    header: stub.getHeader(),
    entries: stub.getEntries(),
    branch: stub.getBranch().map((entry) => entry.id),
  };
}

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: '0191a07a-32d0-7208-b133-cf7870ab850e',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/proj/x',
    ...extra,
  });
const msg = (id: string, parentId: string | null, role: string, text: string) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role, content: [{ type: 'text', text }], timestamp: 1 },
  });

const cases: Record<string, string> = {
  normal: [header(), msg('a', null, 'user', 'hi'), msg('b', 'a', 'assistant', 'yo'), ''].join('\n'),
  'no trailing newline': [
    header(),
    msg('a', null, 'user', 'hi'),
    msg('b', 'a', 'assistant', 'yo'),
  ].join('\n'),
  'blank / malformed / falsy lines': [
    header(),
    '',
    '   ',
    '{bad json',
    '0',
    'false',
    'null',
    msg('a', null, 'user', 'hi'),
    '',
  ].join('\n'),
  crlf:
    [header(), msg('a', null, 'user', 'hi'), msg('b', 'a', 'assistant', 'x')].join('\r\n') + '\r\n',
  branches: [
    header(),
    msg('a', null, 'user', 'q'),
    msg('b', 'a', 'assistant', 'old'),
    msg('c', 'a', 'assistant', 'new'),
    msg('d', 'c', 'user', 'next'),
    '',
  ].join('\n'),
  'large lines': [
    header(),
    msg('a', null, 'user', 'x'.repeat(200_000)),
    msg('b', 'a', 'assistant', '中文😀'.repeat(5000)),
    '',
  ].join('\n'),
};

describe('openSessionManagerAsync', () => {
  for (const [name, content] of Object.entries(cases)) {
    it(`should match the synchronous open semantics for the "${name}" transcript`, async () => {
      const [a, b] = pair(content);
      const sync = StubSessionManager.open(a);
      const asyncM = await openSessionManagerAsync(b);
      expect(snapshot(asyncM)).toEqual(snapshot(sync));
      expect(asyncM.getSessionFile()).toBe(b);
    });
  }

  it('should take the pre-parsed constructor path for a valid session without calling open', async () => {
    const [, b] = pair(cases.branches);
    const spy = vi.spyOn(StubSessionManager, 'open');
    try {
      const manager = await openSessionManagerAsync(b);
      expect(spy).not.toHaveBeenCalled();
      expect(manager.getEntries()).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  });

  it('should append the missing trailing newline so later appends stay separate records', async () => {
    const [a, b] = pair(cases['no trailing newline']);
    const manager = await openSessionManagerAsync(b);
    expect(readFileSync(b, 'utf8')).toBe(`${readFileSync(a, 'utf8')}\n`);
    expect(manager.getEntries()).toHaveLength(2);
  });

  it('should leave an already newline-terminated file byte-identical', async () => {
    const [a, b] = pair(cases.normal);
    await openSessionManagerAsync(b);
    expect(readFileSync(b, 'utf8')).toBe(readFileSync(a, 'utf8'));
  });

  it('should produce a writable persisted manager that survives reopening', async () => {
    const [, b] = pair(cases.normal);
    const manager = await openSessionManagerAsync(b);
    expect(manager.isPersisted()).toBe(true);
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'appended' }],
      timestamp: 2,
    });
    const reopened = StubSessionManager.open(b);
    expect(reopened.getEntries().length).toBe(manager.getEntries().length);
    expect(reopened.getEntries().at(-1)).toMatchObject({ message: { timestamp: 2 } });
  });

  it('should fall back to the SDK path when the file is not a pi session', async () => {
    const [a, b] = pair('{"type":"message","id":"x"}\n');
    expect(() => StubSessionManager.open(a)).toThrow();
    await expect(openSessionManagerAsync(b)).rejects.toThrow();
    expect(StubSessionManager.openCalls).toContain(resolve(b));
  });

  it('should fall back to the SDK path for an empty file', async () => {
    const [a, b] = pair('');
    const sync = StubSessionManager.open(a);
    const asyncM = await openSessionManagerAsync(b);
    expect(asyncM.getEntries()).toEqual(sync.getEntries());
  });

  it('should fall back to the SDK path when the file cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-web-host-open-'));
    dirs.push(dir);
    const missing = join(dir, 'missing.jsonl');
    // 桩 open 读文件会抛 ENOENT，等价于 SDK 的失败语义。
    await expect(openSessionManagerAsync(missing)).rejects.toThrow();
    expect(StubSessionManager.openCalls).toContain(resolve(missing));
  });

  it('should fall back to the SDK path when the constructed manager does not verify', async () => {
    const [, b] = pair(cases.normal);
    StubSessionManager.forceMismatch = true;
    const manager = await openSessionManagerAsync(b);
    expect(StubSessionManager.openCalls).toContain(resolve(b));
    expect(manager.getSessionId()).toBe('mismatched-id');
  });

  it('should bypass pre-parsing when PI_WEB_ASYNC_SESSION_OPEN is "0"', async () => {
    const prev = process.env.PI_WEB_ASYNC_SESSION_OPEN;
    process.env.PI_WEB_ASYNC_SESSION_OPEN = '0';
    try {
      const [, b] = pair(cases.normal);
      const manager = await openSessionManagerAsync(b);
      expect(manager.getEntries()).toHaveLength(2);
      expect(StubSessionManager.openCalls).toContain(resolve(b));
    } finally {
      if (prev === undefined) delete process.env.PI_WEB_ASYNC_SESSION_OPEN;
      else process.env.PI_WEB_ASYNC_SESSION_OPEN = prev;
    }
  });
});

describe('parseJsonlSliced', () => {
  it('should yield to the event loop while parsing a large payload', async () => {
    const raw = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ i, pad: 'x'.repeat(200) }),
    ).join('\n');
    let ranDuringParse = false;
    let done = false;
    const probe = new Promise<void>((r) =>
      setImmediate(() => {
        ranDuringParse = !done;
        r();
      }),
    );
    const res = await parseJsonlSliced(raw, 0);
    done = true;
    await probe;
    expect(ranDuringParse).toBe(true);
    expect(res.entries).toHaveLength(5000);
    expect(res.tail).not.toBe('');
  });

  it('should skip blank, malformed and falsy lines', async () => {
    const raw = ['{"a":1}', '', '   ', '{bad', '0', 'null', '{"b":2}', ''].join('\n');
    const res = await parseJsonlSliced(raw, 60_000);
    expect(res.entries).toEqual([{ a: 1 }, { b: 2 }]);
    expect(res.tail).toBe('');
  });

  it('should return the trailing fragment as tail when the payload has no final newline', async () => {
    const res = await parseJsonlSliced('{"a":1}\n{"partial":', 60_000);
    expect(res.entries).toEqual([{ a: 1 }]);
    expect(res.tail).toBe('{"partial":');
  });

  it('should parse a single unterminated record as both entry and tail', async () => {
    const res = await parseJsonlSliced('{"a":1}', 60_000);
    expect(res.entries).toEqual([{ a: 1 }]);
    expect(res.tail).toBe('{"a":1}');
  });
});
