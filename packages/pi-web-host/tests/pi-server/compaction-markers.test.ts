/**
 * compaction-markers.ts 单元测试
 *
 * 覆盖压缩标记 ID 生成、转录修复（残留 pending 旁路、重复 ID 改名、环截断、
 * 主分支重排）与文件级修复（.bak 保留、健康缓存）。
 *
 * 为何 `repairSessionTranscript` 必须先「移除 pending 并把子节点接回祖先」：
 * 残留 pending 条目会让 SDK 的 parentId 链指向一个不存在于上下文的节点，
 * 回溯直接断链；只删条目不改父指针 = 把断链换成孤儿。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACTION_DONE_TYPE,
  COMPACTION_PENDING_TYPE,
  healthyRepairResult,
  isTranscriptHealthyCached,
  looksLikeChainCorruption,
  makeCompactionMarkerId,
  rememberHealthyTranscriptSig,
  repairSessionFile,
  repairSessionFileFromText,
  repairSessionTranscript,
} from '../../src/pi-server/compaction-markers.js';

const HEADER = JSON.stringify({
  type: 'session',
  version: 3,
  id: 's1',
  timestamp: '2026-09-19T00:00:00.000Z',
  cwd: '/x',
});
const msg = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-09-19T00:00:01.000Z',
    message: { role: 'user', content: 'hi' },
  });
const doneMarker = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: 'custom',
    id,
    parentId,
    timestamp: '2026-09-19T00:00:02.000Z',
    customType: COMPACTION_DONE_TYPE,
    data: { reason: 'manual', status: 'completed' },
  });
const pendingMarker = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: 'custom',
    id,
    parentId,
    timestamp: '2026-09-19T00:00:03.000Z',
    customType: COMPACTION_PENDING_TYPE,
    data: { reason: 'manual' },
  });

function tempFile(name = 's.jsonl'): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'session-repair-'));
  return { dir, file: join(dir, name) };
}

/** 转录行的最小结构（测试内自用，避免 JSON.parse 的 any 扩散）。 */
interface ParsedEntry {
  id: string;
  parentId: string | null;
  type?: string;
  customType?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

function parseLine(line: string): ParsedEntry {
  return JSON.parse(line) as ParsedEntry;
}

function walkChain(
  raw: string,
  fromId: string,
  maxSteps: number,
): { visited: string[]; cycled: boolean } {
  const byId = new Map<string, string | null>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { id?: unknown; parentId?: unknown };
      if (typeof e.id === 'string')
        byId.set(e.id, typeof e.parentId === 'string' ? e.parentId : null);
    } catch {
      // 脏行（非 JSON）在修复器里原样保留，这里同样跳过
    }
  }
  const visited: string[] = [];
  let cur: string | null = fromId;
  for (let i = 0; i < maxSteps; i++) {
    if (cur === null || !byId.has(cur)) return { visited, cycled: false };
    if (visited.includes(cur)) return { visited, cycled: true };
    visited.push(cur);
    cur = byId.get(cur) ?? null;
  }
  return { visited, cycled: true };
}

describe('makeCompactionMarkerId', () => {
  it('should be unique per call and carry a kind-specific prefix', () => {
    const a = makeCompactionMarkerId('pending');
    const b = makeCompactionMarkerId('pending');
    const c = makeCompactionMarkerId('done');
    expect(a).not.toBe(b);
    expect(a.startsWith('pi-web-ui-compaction-pending-')).toBe(true);
    expect(c.startsWith('pi-web-ui-compaction-done-')).toBe(true);
  });
});

describe('repairSessionTranscript', () => {
  it('should return a healthy transcript unchanged with changed=false', () => {
    const raw = [HEADER, msg('a', null), msg('b', 'a')].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(raw);
  });

  it.each([1000, 4000])(
    'should keep a healthy %i-node chain intact with linear Map lookups',
    (size) => {
      const raw =
        [
          HEADER,
          ...Array.from({ length: size }, (_, i) => msg(`n${i}`, i === 0 ? null : `n${i - 1}`)),
        ].join('\n') + '\n';
      const get = vi.spyOn(Map.prototype, 'get');
      let lookups: number;
      let result: ReturnType<typeof repairSessionTranscript>;
      try {
        result = repairSessionTranscript(raw);
        lookups = get.mock.calls.length;
      } finally {
        get.mockRestore();
      }
      expect(result.changed).toBe(false);
      expect(result.text).toBe(raw);
      expect(result.cyclesBroken).toBe(0);
      expect(lookups).toBeLessThan(size * 20);
    },
  );

  it('should truncate only the edge chosen by the original algorithm when a long forward path closes a cycle', () => {
    const size = 4000;
    const rows = Array.from({ length: size }, (_, i) =>
      parseLine(msg(`n${i}`, i === size - 1 ? 'n2000' : `n${i + 1}`)),
    );
    rows[size - 1].message!.content = 'z'.repeat(1200);
    const raw = [HEADER, ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
    const get = vi.spyOn(Map.prototype, 'get');
    let lookups: number;
    let result: ReturnType<typeof repairSessionTranscript>;
    try {
      result = repairSessionTranscript(raw);
      lookups = get.mock.calls.length;
    } finally {
      get.mockRestore();
    }
    expect(lookups).toBeLessThan(size * 20);
    expect(result.cyclesBroken).toBe(1);
    expect(result.removedPending).toBe(0);
    expect(result.renamedIds).toBe(0);
    expect(result.rewiredParents).toBe(0);
    const actual = new Map(
      result.text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const row = parseLine(line);
          return [row.id, row];
        }),
    );
    rows[size - 1].parentId = null;
    for (const row of rows) expect(actual.get(row.id)).toEqual(row);
    expect(repairSessionTranscript(result.text).changed).toBe(false);
  });

  it('should match the legacy per-node backtrack for every four-node parent graph', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const targets = [null, 'missing', ...ids];
    for (let code = 0; code < targets.length ** ids.length; code++) {
      let digits = code;
      const rows = ids.map((id) => {
        const parent = targets[digits % targets.length];
        digits = Math.floor(digits / targets.length);
        return parseLine(msg(id, parent));
      });
      const raw = [HEADER, ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n';
      const byId = new Map(rows.map((row) => [row.id, row]));
      let cycles = 0;
      for (const row of rows) {
        const seen = new Set([row.id]);
        let prev = row;
        let cur = row.parentId;
        while (cur !== null) {
          if (seen.has(cur)) {
            prev.parentId = null;
            cycles++;
            break;
          }
          seen.add(cur);
          const next = byId.get(cur);
          if (!next) break;
          prev = next;
          cur = next.parentId;
        }
      }
      const result = repairSessionTranscript(raw);
      expect(result.cyclesBroken, `graph ${code}`).toBe(cycles);
      const repaired = new Map(
        result.text
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const row = parseLine(line);
            return [row.id, row];
          }),
      );
      for (const row of rows) expect(repaired.get(row.id), `graph ${code}`).toEqual(row);
    }
  });

  it('should remove a leftover pending marker and rewire its child to the pending parent', () => {
    const raw =
      [HEADER, msg('a', null), pendingMarker('p1', 'a'), msg('b', 'p1')].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.changed).toBe(true);
    expect(r.removedPending).toBe(1);
    expect(r.interrupted).toBe(true);
    expect(r.rewiredParents).toBe(1);
    expect(r.text.includes('compaction-pending')).toBe(false);
    const lines = r.text.split('\n').filter(Boolean);
    const b = JSON.parse(lines[2]) as { id: string; parentId: string };
    expect(b.id).toBe('b');
    expect(b.parentId).toBe('a');
  });

  it('should bypass a chain of adjacent pending markers to the nearest live ancestor', () => {
    const raw = [
      HEADER,
      msg('a', null),
      pendingMarker('p1', 'a'),
      pendingMarker('p2', 'p1'),
      msg('b', 'p2'),
    ].join('\n');
    const r = repairSessionTranscript(raw);
    expect(r.removedPending).toBe(2);
    expect(r.rewiredParents).toBe(1);
    const b = r.text
      .split('\n')
      .filter(Boolean)
      .map((line) => parseLine(line))
      .find((e) => e.id === 'b');
    expect(b!.parentId).toBe('a');
  });

  it('should keep the first duplicate done id and rename the rest, repointing references forward', () => {
    const D = 'pi-web-ui-compaction-done';
    const raw =
      [
        HEADER,
        msg('a', null),
        doneMarker(D, 'x1'),
        msg('m1', 'a'),
        doneMarker(D, 'x2'),
        msg('m2', D),
      ].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.changed).toBe(true);
    expect(r.renamedIds).toBe(1);
    const lines = r.text.split('\n').filter(Boolean);
    const dones = lines
      .map((l) => parseLine(l))
      .filter((e) => e.customType === COMPACTION_DONE_TYPE);
    expect(dones).toHaveLength(2);
    expect(dones[0].id).toBe(D);
    expect(dones[1].id.startsWith(`${D}--dup-`)).toBe(true);
    const m2 = lines.map((l) => parseLine(l)).find((e) => e.id === 'm2');
    expect(m2!.parentId).toBe(dones[1].id);
  });

  it('should terminate and cut a hand-made A<->B cycle', () => {
    const raw = [HEADER, msg('a', 'b'), msg('b', 'a')].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.cyclesBroken).toBeGreaterThan(0);
    const w = walkChain(r.text, 'a', 100);
    expect(w.cycled).toBe(false);
  });

  it('should leave a dirty non-JSON line untouched', () => {
    const raw = [HEADER, 'not json at all', msg('a', null)].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(raw);
  });

  it('should fast-extract an oversized message header while preserving its full body on rewire', () => {
    const bigMsg = JSON.stringify({
      type: 'message',
      id: 'big-b',
      parentId: 'p1',
      timestamp: '2026-09-19T00:00:05.000Z',
      message: { role: 'assistant', content: 'z'.repeat(1200) },
    });
    const raw = [HEADER, msg('a', null), pendingMarker('p1', 'a'), bigMsg].join('\n') + '\n';
    const r = repairSessionTranscript(raw);
    expect(r.changed).toBe(true);
    expect(r.rewiredParents).toBe(1);
    const lines = r.text.split('\n').filter(Boolean);
    const parsedBig = JSON.parse(lines[2]) as {
      id: string;
      parentId: string;
      message: { content: string };
    };
    expect(parsedBig.id).toBe('big-b');
    expect(parsedBig.parentId).toBe('a');
    expect(parsedBig.message.content).toBe('z'.repeat(1200));
  });
});

describe('issue #235 original scenario', () => {
  const DUP = 'pi-web-ui-compaction-done';
  const corrupt = [
    HEADER,
    msg('a', null),
    doneMarker(DUP, 'x1'),
    msg('x1', DUP),
    doneMarker(DUP, 'x1'),
    msg('m', DUP),
  ].join('\n');

  it('should produce a cyclic chain in the corrupt transcript', () => {
    const w = walkChain(corrupt, 'm', 1000);
    expect(w.cycled).toBe(true);
  });

  it('should remove the cycle after repair', () => {
    const r = repairSessionTranscript(corrupt);
    expect(r.changed).toBe(true);
    expect(r.renamedIds).toBe(1);
    const w = walkChain(r.text, 'm', 1000);
    expect(w.cycled).toBe(false);
    expect(repairSessionTranscript(r.text).changed).toBe(false);
  });
});

describe('looksLikeChainCorruption', () => {
  it('should recognize V8 cycle errors and let ordinary errors pass', () => {
    expect(looksLikeChainCorruption(new RangeError('Invalid array length'))).toBe(true);
    expect(looksLikeChainCorruption(new Error('Maximum call stack size exceeded'))).toBe(true);
    expect(looksLikeChainCorruption(new Error('Session file is not a valid pi session'))).toBe(
      false,
    );
    expect(looksLikeChainCorruption('boom')).toBe(false);
  });
});

describe('repairSessionFile', () => {
  it('should only read a healthy file and create no backup', () => {
    const { file } = tempFile();
    const raw = [HEADER, msg('a', null)].join('\n') + '\n';
    writeFileSync(file, raw, 'utf8');
    const r = repairSessionFile(file);
    expect(r?.changed).toBe(false);
    expect(r?.backup).toBeNull();
    expect(r?.file).toBe(file);
    expect(existsSync(`${file}.bak`)).toBe(false);
  });

  it('should write the repaired transcript and keep the earliest backup', () => {
    const { file } = tempFile();
    const corrupt =
      [HEADER, msg('a', null), pendingMarker('p1', 'a'), msg('b', 'p1')].join('\n') + '\n';
    writeFileSync(file, corrupt, 'utf8');
    writeFileSync(`${file}.bak`, 'ORIGINAL', 'utf8');
    const r = repairSessionFile(file);
    expect(r?.changed).toBe(true);
    expect(r?.backup).toBe(`${file}.bak`);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('ORIGINAL');
    expect(readFileSync(file, 'utf8').includes('compaction-pending')).toBe(false);
  });

  it('should prune a transcript hijacked by a stale metadata side branch', () => {
    const { file } = tempFile('s567.jsonl');
    const custom1 = JSON.stringify({
      type: 'custom',
      customType: 'plannotator',
      id: 'plan-1',
      parentId: '8775fb27',
      timestamp: '2026-10-08T11:53:01.000Z',
    });
    const custom2 = JSON.stringify({
      type: 'custom',
      customType: 'plannotator',
      id: 'plan-2',
      parentId: 'plan-1',
      timestamp: '2026-10-08T11:53:02.000Z',
    });
    writeFileSync(
      file,
      [
        HEADER,
        msg('m1', null),
        msg('8775fb27', 'm1'),
        msg('m3', '8775fb27'),
        msg('c9560bdb', 'm3'),
        custom1,
        custom2,
      ].join('\n'),
      'utf8',
    );

    const r = repairSessionFile(file);
    expect(r?.changed).toBe(true);
    expect(r?.reorderedBranches).toBe(true);
    expect(r?.backup).toBe(`${file}.bak`);

    const repaired = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => parseLine(line));
    expect(repaired.at(-1)?.id).toBe('c9560bdb');
    expect(repaired.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['m1', '8775fb27', 'm3', 'c9560bdb', 'plan-1', 'plan-2']),
    );
    expect(repairSessionTranscript(readFileSync(file, 'utf8')).changed).toBe(false);
  });

  it('should return null for a missing file', () => {
    const { dir } = tempFile('absent.jsonl');
    expect(repairSessionFile(join(dir, 'absent.jsonl'))).toBeNull();
  });

  it('should return null when the repaired transcript cannot be written', () => {
    const { dir } = tempFile();
    const corrupt = [HEADER, msg('a', null), pendingMarker('p1', 'a'), msg('b', 'p1')].join('\n');
    // 父目录不存在 → 备份写入失败 → 保守返回 null（不声称修好了却写不回去）
    const file = join(dir, 'missing-dir', 's.jsonl');
    expect(repairSessionFileFromText(file, corrupt)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('should remember a healthy transcript signature and reuse it', () => {
    const file = '/virtual/session.jsonl';
    rememberHealthyTranscriptSig(file, 'sig-1');
    expect(isTranscriptHealthyCached(file, 'sig-1')).toBe(true);
    expect(isTranscriptHealthyCached(file, 'sig-2')).toBe(false);
    expect(healthyRepairResult(file)).toEqual({
      text: '',
      changed: false,
      removedPending: 0,
      renamedIds: 0,
      rewiredParents: 0,
      cyclesBroken: 0,
      interrupted: false,
      file,
      backup: null,
    });
  });

  it('should evict the oldest healthy signature once the cache exceeds its bound', () => {
    const oldest = '/virtual/oldest.jsonl';
    rememberHealthyTranscriptSig(oldest, 'sig');
    for (let i = 0; i < 513; i++) rememberHealthyTranscriptSig(`/virtual/n${i}.jsonl`, 'sig');
    expect(isTranscriptHealthyCached(oldest, 'sig')).toBe(false);
    expect(isTranscriptHealthyCached('/virtual/n512.jsonl', 'sig')).toBe(true);
  });

  it('should return null when the transcript path is a directory', () => {
    const { dir } = tempFile();
    expect(repairSessionFile(dir)).toBeNull();
  });
});
