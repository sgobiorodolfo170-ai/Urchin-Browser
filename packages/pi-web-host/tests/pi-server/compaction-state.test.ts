/**
 * compaction-state.ts 单元测试
 *
 * 覆盖压缩恢复 sidecar（`<session>.compaction-state.json`）的写入、幂等清理、
 * 一次性消费、跨模块重载持久化，以及非法状态的保守行为。
 *
 * 为何要「先落 sidecar 再消费」：服务端重启后唯一能判断「上轮压缩被打断」的
 * 证据就是这个 sidecar；消费必须恰好一次，否则会重复给用户发中断提示。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomic from '../../src/pi-server/atomic-file.js';
import { consumeInterrupted, finish, mark } from '../../src/pi-server/compaction-state.js';
import { repairSessionTranscript } from '../../src/pi-server/compaction-markers.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

let dir: string;
let file: string;
let sidecar: string;
const state = { reason: 'manual', startedAt: 12345 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compaction-state-'));
  file = join(dir, 'session.jsonl');
  sidecar = `${file}.compaction-state.json`;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('compaction sidecar', () => {
  it('should persist across a module reload and be consumed exactly once', async () => {
    expect(mark(file, state)).toBe(true);
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual({ version: 1, ...state });
    vi.resetModules();
    const reopened = await import('../../src/pi-server/compaction-state.js');
    expect(reopened.consumeInterrupted(file)).toEqual(state);
    expect(reopened.consumeInterrupted(file)).toBeUndefined();
    expect(existsSync(sidecar)).toBe(false);
  });

  it('should make finish idempotent so a cleared compaction is not reported as interrupted', () => {
    mark(file, state);
    expect(finish(file)).toBe(true);
    expect(finish(file)).toBe(false);
    expect(consumeInterrupted(file)).toBeUndefined();
  });

  it.each([undefined, null, ''])(
    'should skip ephemeral session %s and write nothing',
    (session) => {
      expect(mark(session, state)).toBe(false);
      expect(finish(session)).toBe(false);
      expect(consumeInterrupted(session)).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it('should isolate sessions and replace a pending state atomically', () => {
    const other = join(dir, 'other.jsonl');
    const next = { reason: 'auto', startedAt: 54321 };
    mark(file, state);
    mark(other, state);
    mark(file, next);
    expect(consumeInterrupted(file)).toEqual(next);
    expect(consumeInterrupted(other)).toEqual(state);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('should never create or modify the transcript itself', () => {
    mark(file, state);
    expect(existsSync(file)).toBe(false);
    const transcript = '{"type":"session","id":"s1"}\n';
    writeFileSync(file, transcript);
    mark(file, state);
    consumeInterrupted(file);
    mark(file, state);
    finish(file);
    expect(readFileSync(file, 'utf8')).toBe(transcript);
  });

  it('should propagate a write failure and preserve the last durable state', () => {
    mark(file, state);
    const failure = new Error('disk full');
    vi.spyOn(atomic, 'writeJsonAtomicSync').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => mark(file, { reason: 'auto', startedAt: 99999 })).toThrow(failure);
    expect(consumeInterrupted(file)).toEqual(state);
  });

  it('should propagate an atomic rename failure and clean up temporary files', () => {
    mkdirSync(sidecar);
    expect(() => mark(file, state)).toThrow();
    expect(readdirSync(dir)).toEqual(['session.jsonl.compaction-state.json']);
  });

  it('should propagate clear/consume failure without consuming the durable state', () => {
    mark(file, state);
    const failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => finish(file)).toThrow(failure);
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => consumeInterrupted(file)).toThrow(failure);
    expect(existsSync(sidecar)).toBe(true);
    expect(consumeInterrupted(file)).toEqual(state);
  });

  it.each([
    '{',
    '{"version":2,"reason":"auto","startedAt":1}',
    '{"version":1,"reason":"auto","startedAt":null}',
  ])('should preserve an invalid state file and report it: %s', (raw) => {
    writeFileSync(sidecar, raw);
    expect(() => consumeInterrupted(file)).toThrow();
    expect(readFileSync(sidecar, 'utf8')).toBe(raw);
  });

  it('should reject an invalid pending state before replacing durable data', () => {
    mark(file, state);
    expect(() => mark(file, { reason: 'auto', startedAt: NaN })).toThrow(
      'Invalid compaction state',
    );
    expect(consumeInterrupted(file)).toEqual(state);
  });

  it('should propagate a non-ENOENT read failure when consuming', () => {
    mkdirSync(sidecar);
    expect(() => consumeInterrupted(file)).toThrow();
    expect(existsSync(sidecar)).toBe(true);
  });

  it('should keep legacy pending repair and SDK done entries compatible', () => {
    const raw =
      [
        { type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/x' },
        {
          type: 'custom',
          id: 'pending',
          parentId: null,
          customType: 'pi-web-ui/compaction-pending',
          data: state,
        },
        {
          type: 'custom',
          id: 'sdk-done',
          parentId: 'pending',
          customType: 'pi-web-ui/compaction-done',
          data: { ...state, status: 'completed' },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n';
    mark(file, state);
    const repaired = repairSessionTranscript(raw);
    expect(repaired.interrupted).toBe(true);
    expect(repaired.removedPending).toBe(1);
    expect(repaired.text).toContain('"sdk-done"');
    expect(repaired.text).toContain('"pi-web-ui/compaction-done"');
    expect(consumeInterrupted(file)).toEqual(state);
  });
});
