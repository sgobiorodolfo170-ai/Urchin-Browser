/**
 * session-search.ts 单元测试（含 session-parser.parseSessionInfoFast 的全文模式）
 *
 * 重点：流式检索必须能命中 256K 之后的正文与超过 16MB 的转录，
 * 不再依赖全文件读入；取消必须向外传播而不是返回半截结果；
 * 元数据命中（名称 / 文件名 / 首条消息）不因正文未命中而丢失。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

// vendored pi 包未安装在本仓 node_modules，单元测试用最小桩隔离（本文件不触达 SessionManager 逻辑）。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  // client-state -> soft-cap 在模块初始化时读取该常量（本文件不校验其数值）
  DEFAULT_COMPACTION_SETTINGS: { reserveTokens: 16384 },
  SessionManager: {
    create: (cwd: string) => ({ getSessionDir: () => join(cwd, '.sessions') }),
    open: () => {
      throw new Error('SessionManager.open is not used by session-search tests');
    },
  },
}));

import { parseSessionInfoFast } from '../../src/pi-server/session-parser.js';
import {
  collectSessionAnchors,
  isInsideSessionsDir,
  messageSearchText,
  piSessionsRoot,
  scanSessionForSearch,
  searchSessions,
  sessionMatchesMetadata,
} from '../../src/pi-server/session-search.js';
import { mapSessionsConcurrent, sessionLines } from '../../src/pi-server/session-scan.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const header = {
  type: 'session',
  id: 'test',
  cwd: '/workspace',
  timestamp: '2024-01-01T00:00:00Z',
};
const message = (role: string, content: unknown, timestamp?: number) => ({
  type: 'message',
  message: { role, content, timestamp },
});

async function transcript(records: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-host-search-'));
  dirs.push(dir);
  const path = join(dir, 'session.jsonl');
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n'));
  return path;
}

describe('streaming history search', () => {
  it('should find tail matches beyond 256K of text in a single scan with ordered anchors', async () => {
    const path = await transcript([
      header,
      message('user', 'start', 1),
      ...Array.from({ length: 320 }, (_, i) => message('assistant', 'x'.repeat(1024), i + 2)),
      message('assistant', [{ type: 'text', text: 'TAIL Needle' }], 400),
      message('user', 'needle again', 401),
    ]);
    const readFile = vi.spyOn(fsPromises, 'readFile');
    const info = (await parseSessionInfoFast(path, 1))!;
    expect(info.allMessagesText).toBe('');
    const openStream = vi.mocked(fs.createReadStream);
    openStream.mockClear();
    expect(await searchSessions([info], 'NEEDLE')).toEqual([
      {
        session: info,
        anchors: [
          { role: 'assistant', timestamp: 400 },
          { role: 'user', timestamp: 401 },
        ],
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
    expect(openStream).toHaveBeenCalledTimes(1);
  });

  it('should search transcripts larger than the old 16MB whole-file cutoff', async () => {
    const path = await transcript([
      header,
      ...Array.from({ length: 260 }, () => message('assistant', 'x'.repeat(65536), 1)),
      message('user', 'very late match', 99),
    ]);
    expect(await scanSessionForSearch(path, 'late match')).toEqual({
      matched: true,
      anchors: [{ role: 'user', timestamp: 99 }],
    });
  });

  it('should filter roles and blocks, skip malformed records, and keep valid anchors', async () => {
    const path = await transcript([
      header,
      null,
      message('toolResult', 'secret needle', 1),
      message('system', 'secret needle', 2),
      message(
        'assistant',
        [
          { type: 'thinking', text: 'secret needle' },
          { type: 'image', text: 'secret needle' },
        ],
        3,
      ),
      message('user', 'needle without timestamp'),
      message('assistant', [{ type: 'text', text: '中文 Needle' }], 5),
      message('user', 'needle', 6),
    ]);
    expect(await scanSessionForSearch(path, 'secret')).toEqual({ matched: false, anchors: [] });
    expect(await collectSessionAnchors(path, 'needle', 1)).toEqual([
      { role: 'assistant', timestamp: 5 },
    ]);
    expect(await scanSessionForSearch(path, 'without timestamp')).toEqual({
      matched: true,
      anchors: [],
    });
    expect(await scanSessionForSearch(path, 'needle', 0)).toEqual({ matched: true, anchors: [] });
    await writeFile(path, `\n{broken\n${JSON.stringify(message('user', '最后 Needle', 7))}`, {
      flag: 'a',
    });
    expect((await scanSessionForSearch(path, 'needle')).anchors.map((a) => a.timestamp)).toEqual([
      5, 6, 7,
    ]);
  });

  it('should handle UTF-8 across chunks, CRLF and an unterminated final record', async () => {
    const path = await transcript([]);
    await writeFile(
      path,
      `${JSON.stringify(header)}\r\n${JSON.stringify(message('user', `${'界'.repeat(24000)}尾部检索`, 9))}`,
    );
    expect(await scanSessionForSearch(path, '尾部检索')).toEqual({
      matched: true,
      anchors: [{ role: 'user', timestamp: 9 }],
    });
  });

  it('should keep metadata-only matches, handle missing files and scan more than 200 candidates', async () => {
    const path = await transcript([header, message('user', 'hello', 1)]);
    const info = (await parseSessionInfoFast(path, 1))!;
    const dir = dirs[0];
    const candidates = Array.from({ length: 205 }, (_, i) => ({
      ...info,
      path: join(dir, `missing-${i}.jsonl`),
      name: i === 204 ? 'Target' : 'other',
    }));
    expect(await searchSessions(candidates, 'target', { concurrency: 3 })).toEqual([
      { session: candidates[204], anchors: [] },
    ]);
    expect(await scanSessionForSearch(candidates[0].path, 'hello')).toEqual({
      matched: false,
      anchors: [],
    });
    expect(await searchSessions(candidates, '')).toHaveLength(205);
  });

  it('should treat an empty query as matched without any anchors', async () => {
    const path = await transcript([header, message('user', 'hello', 1)]);
    expect(await scanSessionForSearch(path, '   ')).toEqual({ matched: false, anchors: [] });
  });

  it('should cap anchors but still report the match', async () => {
    const path = await transcript([
      header,
      ...Array.from({ length: 5 }, (_, i) => message('user', `needle ${i}`, i + 1)),
    ]);
    const result = await scanSessionForSearch(path, 'needle', 2);
    expect(result.matched).toBe(true);
    expect(result.anchors).toHaveLength(2);
  });
});

describe('sessionMatchesMetadata / messageSearchText', () => {
  const base = {
    path: '/sessions/2026-01-01_MySession.jsonl',
    id: 'x',
    cwd: '/p',
    created: new Date(0),
    modified: new Date(0),
    firstMessage: 'First Hello',
    messageCount: 0,
    allMessagesText: '',
  };

  it('should match on name, file name and first message case-insensitively', () => {
    expect(sessionMatchesMetadata('renamed', { ...base, name: 'Renamed Chat' })).toBe(true);
    expect(sessionMatchesMetadata('mysession', base)).toBe(true);
    expect(sessionMatchesMetadata('first hello', base)).toBe(true);
    expect(sessionMatchesMetadata('absent', base)).toBe(false);
  });

  it('should extract only text blocks from array content', () => {
    expect(messageSearchText({ content: 'plain' })).toBe('plain');
    expect(
      messageSearchText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'thinking', text: 'ignored' },
          { type: 'text', text: 'b' },
          null,
        ],
      }),
    ).toBe('a\nb');
    expect(messageSearchText({ content: 42 })).toBe('');
  });
});

describe('streaming list parser fallback', () => {
  it('should retain metadata, first message, counters and the bounded legacy preview', async () => {
    const path = await transcript([
      { ...header, parentSession: '/parent.jsonl' },
      message(
        'user',
        [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'message' },
        ],
        1705000000000,
      ),
      message('toolResult', 'x'.repeat(300000), 1705000000001),
      { type: 'session_info', name: ' latest name ' },
    ]);
    const info = await parseSessionInfoFast(path, 1);
    expect(info).toMatchObject({
      id: 'test',
      cwd: '/workspace',
      name: 'latest name',
      parentSessionPath: '/parent.jsonl',
      firstMessage: 'first message',
      messageCount: 2,
      allMessagesText: '',
    });
    expect(info?.modified.getTime()).toBe(1705000000001);
    expect((await parseSessionInfoFast(path, 1, true))?.allMessagesText).toHaveLength(256 * 1024);
  });

  it('should keep fallback dates and ignore invalid records', async () => {
    const path = await transcript([header, { type: 'session_info', name: 'name' }]);
    await writeFile(path, '\n{broken\nnull\n', { flag: 'a' });
    expect(await parseSessionInfoFast(path, 1)).toMatchObject({
      firstMessage: '(no messages)',
      messageCount: 0,
      modified: new Date(header.timestamp),
    });
    expect(await parseSessionInfoFast(`${path}.missing`, 1)).toBeNull();
  });
});

describe('scan cancellation', () => {
  it('should reject pre-aborted searches without opening files, including empty queries', async () => {
    const path = await transcript([header]);
    const info = (await parseSessionInfoFast(path, 1))!;
    const controller = new AbortController();
    controller.abort();
    const openStream = vi.mocked(fs.createReadStream);
    openStream.mockClear();
    await expect(scanSessionForSearch(path, 'needle', 10, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    await expect(searchSessions([info], '', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(sessionLines(path, controller.signal).next()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(openStream).not.toHaveBeenCalled();
  });

  it('should propagate cancellation instead of returning partial results and open no queued files', async () => {
    const path = await transcript([header, message('user', 'needle', 1)]);
    const info = (await parseSessionInfoFast(path, 1))!;
    const controller = new AbortController();
    const openStream = vi.mocked(fs.createReadStream);
    const { createReadStream: original } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    openStream.mockClear();
    openStream.mockImplementationOnce((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = original(...args);
      queueMicrotask(() => controller.abort());
      return stream;
    });
    await expect(
      searchSessions(Array(20).fill(info), 'needle', { concurrency: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(openStream.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });

  it('should stop queued worker tasks after cancellation even when active tasks resolve', async () => {
    const controller = new AbortController();
    const visited: number[] = [];
    await expect(
      mapSessionsConcurrent(
        [0, 1, 2, 3],
        (n) => {
          visited.push(n);
          controller.abort();
          return Promise.resolve(n);
        },
        1,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(visited).toEqual([0]);
  });
});

describe('pi sessions root', () => {
  const original = process.env.PI_CODING_AGENT_SESSION_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = original;
  });

  it('should return PI_CODING_AGENT_SESSION_DIR verbatim when set', () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = '/tmp/custom-sessions';
    expect(piSessionsRoot()).toBe('/tmp/custom-sessions');
  });

  it('should return undefined when the env var is unset so the SDK default layout applies', () => {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    expect(piSessionsRoot()).toBeUndefined();
  });

  it('should treat an empty env value as unset', () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = '';
    expect(piSessionsRoot()).toBeUndefined();
  });

  it('should never carry the legacy per-cwd suffix', () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = '/tmp/custom-sessions';
    expect(piSessionsRoot()).not.toMatch(/--/);
  });
});

describe('isInsideSessionsDir', () => {
  const agentDir = '/tmp/agent';
  const inside = '/tmp/agent/sessions/--cwd--/a.jsonl';

  it('should accept transcripts under the sessions and bot-sessions roots', () => {
    expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/bot-sessions/client-1/a.jsonl')).toBe(true);
  });

  it('should reject sibling prefixes, traversal and unrelated paths', () => {
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/bot-sessions-other/a.jsonl')).toBe(false);
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/bot-sessions/../../evil.jsonl')).toBe(false);
    expect(isInsideSessionsDir(agentDir, '/tmp/evil.jsonl')).toBe(false);
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/sessions-evil/a.jsonl')).toBe(false);
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/sessions/../evil.jsonl')).toBe(false);
  });

  it('should reject the sessions root itself because a file inside is required', () => {
    expect(isInsideSessionsDir(agentDir, '/tmp/agent/sessions')).toBe(false);
  });

  it('should accept the extra root only while PI_CODING_AGENT_SESSION_DIR is set', () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = '/tmp/custom-sessions';
    expect(
      isInsideSessionsDir(agentDir, '/tmp/custom-sessions/2026-01-01T00-00-00-000Z_a.jsonl'),
    ).toBe(true);
    expect(isInsideSessionsDir(agentDir, '/tmp/custom-sessions-evil/a.jsonl')).toBe(false);
    expect(isInsideSessionsDir(agentDir, '/tmp/custom-sessions')).toBe(false);
    expect(isInsideSessionsDir(agentDir, inside)).toBe(true);
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    expect(isInsideSessionsDir(agentDir, '/tmp/custom-sessions/a.jsonl')).toBe(false);
  });

  it('should compare Windows drive letters case-insensitively', () => {
    if (process.platform !== 'win32') return;
    const winAgent = 'C:\\Users\\test\\.pi\\agent';
    const lowerTarget = 'c:\\users\\test\\.pi\\agent\\sessions\\sub\\a.jsonl';
    expect(isInsideSessionsDir(winAgent, lowerTarget)).toBe(true);
  });
});
