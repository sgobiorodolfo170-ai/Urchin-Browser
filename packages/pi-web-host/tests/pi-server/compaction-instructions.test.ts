/**
 * compaction-instructions.ts 单元测试
 *
 * 覆盖压缩保留指令常量、幂等追加、以及 `_runDefaultCompaction` 包装器的
 * 委派 / 幂等 / 证据索引追加 / 失败传播。
 *
 * 为何包装器要检查 `original.length === 5`：SDK 的方法签名若变化，盲目包装会
 * 把参数错位传下去（instructions 收到 signal），压缩仍然「成功」但完全丢失用户
 * 指令 —— 宁可放弃包装返回 false，也不静默错位。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  appendCompactionInstructions,
  COMPACTION_RETENTION_INSTRUCTIONS,
  installCompactionInstructions,
} from '../../src/pi-server/compaction-instructions.js';

function fixture(result: unknown = Promise.resolve({ summary: 'checkpoint' })) {
  const calls = vi.fn();
  const session = {
    _runDefaultCompaction(
      this: unknown,
      prep: unknown,
      model: unknown,
      instructions: unknown,
      signal: unknown,
      reason: unknown,
      ...rest: unknown[]
    ) {
      calls(this, prep, model, instructions, signal, reason, ...rest);
      return result;
    },
  };
  return { session, calls, result };
}

describe('compaction retention instructions', () => {
  it('should preserve the SDK format while requiring goals, constraints, evidence, changes, validation and next steps', () => {
    for (const category of [
      'default structured checkpoint format',
      'Goal:',
      'Constraints & Preferences:',
      'verified facts',
      'actual changes',
      'validation commands',
      'Next Steps:',
      'hypotheses',
      'unverified claims',
      'context-evidence:<sha256>',
      'earlier summaries',
      'candidate notes',
    ]) {
      expect(COMPACTION_RETENTION_INSTRUCTIONS).toContain(category);
    }
  });

  it('should append verbatim, handle absent instructions and stay idempotent', () => {
    expect(appendCompactionInstructions()).toBe(COMPACTION_RETENTION_INSTRUCTIONS);
    expect(appendCompactionInstructions('')).toBe(COMPACTION_RETENTION_INSTRUCTIONS);
    const input = '  Focus on this task.\ncontext-evidence:' + 'a'.repeat(64) + '\n';
    const once = appendCompactionInstructions(input);
    expect(once).toBe(`${input}\n\n${COMPACTION_RETENTION_INSTRUCTIONS}`);
    expect(appendCompactionInstructions(once)).toBe(once);
  });

  it('should not duplicate the policy when it already appears mid-string', () => {
    const built = `focus\n\n[Key Points / Summary to Retain]\nunverified note ${COMPACTION_RETENTION_INSTRUCTIONS}`;
    expect(appendCompactionInstructions(built)).toBe(built);
    expect(appendCompactionInstructions(built.slice(0, -10))).not.toBe(built.slice(0, -10));
  });
});

describe('installCompactionInstructions', () => {
  it.each(['manual', 'threshold', 'overflow'])(
    'should delegate %s with the original receiver, arguments and promise',
    (reason) => {
      const { session, calls, result } = fixture();
      const prep = {};
      const model = {};
      const signal = new AbortController().signal;
      expect(installCompactionInstructions(session)).toBe(true);
      const instructions = reason === 'manual' ? 'caller focus' : undefined;
      expect(session._runDefaultCompaction(prep, model, instructions, signal, reason)).toBe(result);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls).toHaveBeenCalledWith(
        session,
        prep,
        model,
        appendCompactionInstructions(instructions),
        signal,
        reason,
      );
    },
  );

  it('should be idempotent and avoid wrapping the same method twice', () => {
    const { session, calls } = fixture();
    expect(installCompactionInstructions(session)).toBe(true);
    const wrapped = session._runDefaultCompaction;
    expect(installCompactionInstructions(session)).toBe(true);
    expect(session._runDefaultCompaction).toBe(wrapped);
    const built = appendCompactionInstructions('focus');
    session._runDefaultCompaction({}, {}, built, undefined, 'manual');
    expect(calls.mock.calls[0][3]).toBe(built);
  });

  it('should wrap only the selected session without changing its prototype', () => {
    const { session: prototype, calls } = fixture();
    const original = prototype._runDefaultCompaction;
    const session = Object.create(prototype) as typeof prototype;
    expect(installCompactionInstructions(session)).toBe(true);
    expect(prototype._runDefaultCompaction).toBe(original);
    const receiver = {};
    session._runDefaultCompaction.call(receiver, 1, 2, undefined, 4, 5);
    expect(calls.mock.calls[0][0]).toBe(receiver);
  });

  it('should preserve synchronous throws and rejected promises', async () => {
    const error = new Error('cancelled');
    const { session, calls } = fixture();
    calls.mockImplementation(() => {
      throw error;
    });
    installCompactionInstructions(session);
    expect(() => session._runDefaultCompaction(1, 2, undefined, 4, 5)).toThrow(error);
    calls.mockReset();
    const rejected = fixture(Promise.reject(error));
    installCompactionInstructions(rejected.session);
    await expect(rejected.session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
  });

  it('should pass unexpected instruction types and future trailing arguments through', () => {
    const { session, calls } = fixture();
    installCompactionInstructions(session);
    const future = {};
    Reflect.apply(session._runDefaultCompaction, session, [1, 2, future, 4, 5, 6]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledWith(session, 1, 2, future, 4, 5, 6);
  });

  it('should return false for absent or incompatible methods without invoking accessors', () => {
    const getter = vi.fn(() => fixture().session._runDefaultCompaction);
    for (const session of [
      null,
      undefined,
      1,
      {},
      { _runDefaultCompaction: 'method' },
      {
        _runDefaultCompaction() {
          return undefined;
        },
      },
      Object.defineProperty({}, '_runDefaultCompaction', { get: getter }),
    ]) {
      expect(installCompactionInstructions(session)).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('should refuse to wrap a method whose signature is not the five-argument one', () => {
    const shortened = function (_a: unknown, _b: unknown, _c: unknown) {
      return [_a, _b, _c];
    };
    expect(installCompactionInstructions({ _runDefaultCompaction: shortened })).toBe(false);
  });

  it.each(['manual', 'threshold', 'overflow'])(
    'should append the host index after %s compaction and keep the result fields',
    async (reason) => {
      const original = {
        summary: 'SDK checkpoint\n## Next Steps\n1. Continue',
        tokensBefore: 123,
        details: { retained: true },
      };
      let resolveCompaction!: (result: typeof original) => void;
      const { session, calls } = fixture(
        new Promise<typeof original>((resolve) => {
          resolveCompaction = resolve;
        }),
      );
      const index = `Evidence directory (read for complete index): E:/sessions/chat.evidence\ncontext-evidence:${'c'.repeat(64)}`;
      const getEvidenceIndex = vi.fn(() => Promise.resolve(index));
      expect(installCompactionInstructions(session, { getEvidenceIndex })).toBe(true);
      const pending = session._runDefaultCompaction({}, {}, 'focus', undefined, reason);
      expect(getEvidenceIndex).not.toHaveBeenCalled();
      resolveCompaction(original);
      const result = await pending;
      expect(result).toEqual({ ...original, summary: `${original.summary}\n\n${index}` });
      expect(original.summary).toBe('SDK checkpoint\n## Next Steps\n1. Continue');
      expect(getEvidenceIndex).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0][3]).toBe(appendCompactionInstructions('focus'));
    },
  );

  it('should retain the first callback on repeated installation and refresh the index each time', async () => {
    const { session } = fixture();
    const getEvidenceIndex = vi
      .fn()
      .mockResolvedValueOnce('index one')
      .mockResolvedValueOnce('index two');
    const ignored = vi.fn(() => Promise.resolve('ignored'));
    installCompactionInstructions(session, { getEvidenceIndex });
    const wrapped = session._runDefaultCompaction;
    installCompactionInstructions(session, { getEvidenceIndex: ignored });
    expect(session._runDefaultCompaction).toBe(wrapped);
    await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).resolves.toEqual({
      summary: 'checkpoint\n\nindex one',
    });
    await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).resolves.toEqual({
      summary: 'checkpoint\n\nindex two',
    });
    expect(ignored).not.toHaveBeenCalled();
  });

  it.each(['', '  \n '])(
    'should leave the original result intact for an empty index %j',
    async (index) => {
      const original = { summary: 'checkpoint' };
      const { session } = fixture(Promise.resolve(original));
      installCompactionInstructions(session, { getEvidenceIndex: () => Promise.resolve(index) });
      expect(await session._runDefaultCompaction(1, 2, undefined, 4, 5)).toBe(original);
    },
  );

  it.each([undefined, null, {}, { summary: 123 }])(
    'should not invoke the callback for incompatible results %j',
    async (original) => {
      const { session } = fixture(Promise.resolve(original));
      const getEvidenceIndex = vi.fn(() => Promise.resolve('index'));
      installCompactionInstructions(session, { getEvidenceIndex });
      expect(await session._runDefaultCompaction(1, 2, undefined, 4, 5)).toBe(original);
      expect(getEvidenceIndex).not.toHaveBeenCalled();
    },
  );

  it('should propagate compaction failures without invoking the callback', async () => {
    const error = new Error('compaction failed');
    const { session } = fixture(Promise.reject(error));
    const getEvidenceIndex = vi.fn(() => Promise.resolve('index'));
    installCompactionInstructions(session, { getEvidenceIndex });
    await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
    expect(getEvidenceIndex).not.toHaveBeenCalled();
  });

  it('should reject on index failure instead of silently losing the index', async () => {
    const error = new Error('index unavailable');
    const { session } = fixture();
    installCompactionInstructions(session, {
      getEvidenceIndex: () => Promise.reject(error),
    });
    await expect(session._runDefaultCompaction(1, 2, undefined, 4, 5)).rejects.toBe(error);
  });

  it('should fail conservatively for non-writable sessions', () => {
    const { session } = fixture();
    const original = session._runDefaultCompaction;
    Object.freeze(session);
    expect(installCompactionInstructions(session)).toBe(false);
    expect(session._runDefaultCompaction).toBe(original);
  });
});
