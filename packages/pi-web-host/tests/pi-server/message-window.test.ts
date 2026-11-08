/**
 * message-window.ts 单元测试
 *
 * 这是「历史消息窗口化」的唯一实现处：快照只下发尾部窗口、客户端按页回捞、
 * 压缩重写后必须换 lineage（historyGeneration）拒绝旧游标。
 * 每个用例都对应一个真实故障模式（重连丢历史、翻页重复、压缩后串页）。
 */
import { describe, expect, it } from 'vitest';
import {
  computeWindowStart,
  DEFAULT_HISTORY_CHARS,
  DEFAULT_HISTORY_WINDOW,
  estimateMessageChars,
  MessageWindowTap,
  pickWindowStart,
  readMessageWindowConfig,
} from '../../src/pi-server/message-window.js';
import type { ServerMessage, UiMessage, UiState } from '../../src/pi-server/protocol.js';

type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
type EarlierMessage = Extract<ServerMessage, { type: 'earlier_messages' }>;
type DeltaMessage = Extract<ServerMessage, { type: 'snapshot_delta' }>;

function msg(id: string): UiMessage {
  return { id, role: 'user', content: [{ type: 'text', text: id }] };
}

function stateWith(convId: string, messages: UiMessage[]): UiState {
  return { conversationId: convId, messages, rev: 1 } as unknown as UiState;
}

function snapshot(convId: string, messages: UiMessage[]): ServerMessage {
  return { type: 'snapshot', state: stateWith(convId, messages) };
}

function delta(convId: string, baseRev: number, appended: UiMessage[]): ServerMessage {
  return {
    type: 'snapshot_delta',
    conversationId: convId,
    rev: baseRev + 1,
    baseRev,
    appended,
    state: stateWith(convId, []),
  } as unknown as ServerMessage;
}

function makeTap(total: number, windowSize = DEFAULT_HISTORY_WINDOW) {
  const out: ServerMessage[] = [];
  const tap = new MessageWindowTap((m) => out.push(m), { windowSize, charBudget: 0, pageSize: 30 });
  const full = Array.from({ length: total }, (_, i) => msg(`m${i}`));
  return { tap, out, full };
}

describe('shared execution owner isolation', () => {
  it('should discard cached conversation IDs when switching between owners', () => {
    const { tap, out, full } = makeTap(6, 2);
    tap.setScope('owner-a');
    tap.accept(snapshot('c1', full));
    expect(tap.loadEarlier({ conversationId: 'c1', all: true })).toBe(true);
    tap.setScope('owner-b');
    expect(tap.loadEarlier({ conversationId: 'c1', all: true })).toBe(false);
    tap.accept(snapshot('c1', [msg('other-owner')]));
    const last = out.at(-1) as SnapshotMessage;
    expect(last.state.messages.map((m) => m.id)).toEqual(['other-owner']);
    tap.setScope('owner-a');
    expect(tap.loadEarlier({ conversationId: 'c1', all: true })).toBe(false);
  });
});

describe('readMessageWindowConfig', () => {
  it('should default to 300 entries, disable on off/0/false/no, and fall back on invalid values', () => {
    expect(readMessageWindowConfig({}).windowSize).toBe(DEFAULT_HISTORY_WINDOW);
    for (const off of ['0', 'off', 'false', 'no']) {
      expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: off }).windowSize).toBe(0);
    }
    expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: 'abc' }).windowSize).toBe(
      DEFAULT_HISTORY_WINDOW,
    );
    expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: '-5' }).windowSize).toBe(
      DEFAULT_HISTORY_WINDOW,
    );
    expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: '50' }).windowSize).toBe(50);
    expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: ' 12 ' })).toEqual({
      windowSize: 12,
      charBudget: DEFAULT_HISTORY_CHARS,
      pageSize: 30,
    });
  });
});

describe('pickWindowStart (count and char budget, stricter wins)', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`));

  it('should only consider the count when no char budget is set', () => {
    expect(pickWindowStart(messages, { windowSize: 4, charBudget: 0 })).toBe(6);
  });

  it('should narrow the window further when the char budget is exceeded', () => {
    const heavy = [...messages.slice(0, 9), msg('x'.repeat(1000))];
    expect(pickWindowStart(heavy, { windowSize: 10, charBudget: 500 })).toBe(9);
  });

  it('should always keep the last message even when it alone exceeds the budget', () => {
    expect(pickWindowStart([msg('y'.repeat(9999))], { windowSize: 10, charBudget: 10 })).toBe(0);
  });

  it('should not trim when the budget is generous', () => {
    expect(pickWindowStart(messages, { windowSize: 10, charBudget: DEFAULT_HISTORY_CHARS })).toBe(
      0,
    );
  });

  it('should return 0 when windowing is disabled', () => {
    expect(pickWindowStart(messages, { windowSize: 0, charBudget: 100 })).toBe(0);
  });

  it('should sum only text-like fields including image dataUrl', () => {
    const m = {
      id: 'z',
      role: 'toolResult',
      content: [
        { type: 'text', text: 'abc' },
        { type: 'image', dataUrl: 'x'.repeat(10) },
      ],
    } as unknown as UiMessage;
    expect(estimateMessageChars(m)).toBe(13);
  });

  it('should count top-level summary text and ignore non-string fields', () => {
    const m = {
      id: 's',
      role: 'assistant',
      content: [
        { type: 'text', text: 'ab' },
        { type: 'toolCall', argumentsText: 'cde' },
      ],
      summary: 'xyz',
    } as unknown as UiMessage;
    expect(estimateMessageChars(m)).toBe(8);
  });
});

describe('computeWindowStart', () => {
  it('should keep the start at 0 for short conversations', () => {
    expect(computeWindowStart(-1, 20, 300)).toBe(0);
  });

  it('should use the tail window for long conversations', () => {
    expect(computeWindowStart(-1, 1000, 300)).toBe(700);
  });

  it('should never move the start forward so paged-back history is not pushed away', () => {
    expect(computeWindowStart(200, 1000, 300)).toBe(200);
  });

  it('should fall back to the tail window when the message count shrinks (compaction)', () => {
    expect(computeWindowStart(200, 320, 300)).toBe(20);
  });

  it('should return 0 when windowSize is 0 or negative', () => {
    expect(computeWindowStart(50, 1000, 0)).toBe(0);
  });
});

describe('MessageWindowTap', () => {
  it('should pass messages through untouched when windowing is disabled', () => {
    const { tap, out, full } = makeTap(1000, 0);
    tap.accept(snapshot('c1', full));
    const s = out[0] as SnapshotMessage;
    expect(s.state.messages).toBe(full);
    expect(s.state.historyStart).toBeUndefined();
  });

  it('should send only the tail window and backfill start/total for a full snapshot', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    const s = out[0] as SnapshotMessage;
    expect(s.state.messages).toHaveLength(300);
    expect(s.state.messages[0]).toBe(full[700]);
    expect(s.state.historyStart).toBe(700);
    expect(s.state.historyTotal).toBe(1000);
  });

  it('should not trim a short conversation', () => {
    const { tap, out, full } = makeTap(100);
    tap.accept(snapshot('c1', full));
    const s = out[0] as SnapshotMessage;
    expect(s.state.messages).toBe(full);
    expect(s.state.historyStart).toBe(0);
  });

  it('should serve one contiguous non-overlapping page per loadEarlier call', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    tap.loadEarlier(30);
    const page = out[1] as EarlierMessage;
    expect(page.type).toBe('earlier_messages');
    expect(page.messages).toHaveLength(30);
    expect(page.messages[0]).toBe(full[670]);
    expect(page.messages.at(-1)).toBe(full[699]);
    expect(page.historyStart).toBe(670);
    expect(page.historyStart + page.messages.length).toBe(700);
  });

  it('should page back to the very beginning with all=true and then return an empty page', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    tap.loadEarlier(undefined, true);
    const all = out[1] as EarlierMessage;
    expect(all.historyStart).toBe(0);
    expect(all.messages).toHaveLength(700);
    tap.loadEarlier(undefined, true);
    const empty = out[2] as EarlierMessage;
    expect(empty.messages).toEqual([]);
    expect(empty.historyStart).toBe(0);
  });

  it('should not push paged-back history away on a later full snapshot', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    tap.loadEarlier(100);
    const startAfterPage = (out.at(-1) as EarlierMessage).historyStart;
    expect(startAfterPage).toBe(600);
    tap.accept({ type: 'snapshot', state: stateWith('c1', full) });
    const s = out.at(-1) as SnapshotMessage;
    expect(s.state.historyStart).toBe(600);
    expect(s.state.messages).toHaveLength(400);
  });

  it('should extend the cache on delta while leaving rev/baseRev untouched', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    tap.accept(delta('c1', 1, [msg('m1000')]));
    const d = out.at(-1) as DeltaMessage;
    expect(d.appended).toHaveLength(1);
    expect(d.baseRev).toBe(1);
    expect(d.state.historyStart).toBe(700);
    expect(d.state.historyTotal).toBe(1001);
  });

  it('should pass through a delta for a conversation without a cached baseline', () => {
    const { tap, out } = makeTap(10);
    const d = delta('c9', 3, [msg('x')]);
    tap.accept(d);
    expect(out[0]).toBe(d);
  });

  it('should pass through every non-snapshot message', () => {
    const { tap, out } = makeTap(10);
    const notice = { type: 'notice', level: 'info', text: 'hi' } as ServerMessage;
    tap.accept(notice);
    expect(out[0]).toBe(notice);
  });

  it('should return false for unknown conversations until rehydrate establishes a baseline', () => {
    const { tap, out, full } = makeTap(1000, 300);
    expect(tap.loadEarlier({ conversationId: 'c_unknown', count: 30 })).toBe(false);
    expect(out).toHaveLength(0);

    tap.rehydrate('c_unknown', full, 700);
    expect(tap.loadEarlier({ conversationId: 'c_unknown', count: 30 })).toBe(true);
    expect(out).toHaveLength(1);
    const page = out[0] as EarlierMessage;
    expect(page.type).toBe('earlier_messages');
    expect(page.conversationId).toBe('c_unknown');
    expect(page.historyStart).toBe(670);
    expect(page.messages).toHaveLength(30);
  });

  it('should anchor on beforeId rather than drifting indexes', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    const ok = tap.loadEarlier({ conversationId: 'c1', count: 20, beforeId: 'm700' });
    expect(ok).toBe(true);
    const page = out[1] as EarlierMessage;
    expect(page.historyStart).toBe(680);
    expect(page.messages).toHaveLength(20);
    expect(page.messages.at(-1)?.id).toBe('m699');
  });

  it('should keep character-limited snapshots stable across repeats and appends', () => {
    const out: ServerMessage[] = [];
    const tap = new MessageWindowTap((m) => out.push(m), {
      windowSize: 300,
      charBudget: 15,
      pageSize: 2,
    });
    const full = Array.from({ length: 10 }, (_, i) => msg(`message-${i}`));
    const latest = () => (out.at(-1) as SnapshotMessage).state;
    tap.accept(snapshot('c1', full));
    expect(latest().historyStart).toBe(9);
    const generation = latest().historyGeneration;
    for (let i = 0; i < 3; i++) {
      tap.accept(snapshot('c1', [...full]));
      expect(latest().historyStart).toBe(9);
    }
    tap.accept(snapshot('c1', [...full, msg('new')]));
    expect(latest().historyStart).toBe(9);
    expect(latest().historyGeneration).toBe(generation);
    tap.loadEarlier({
      conversationId: 'c1',
      beforeId: 'message-9',
      before: 9,
      historyGeneration: generation,
    });
    tap.accept(snapshot('c1', [...full, msg('new')]));
    expect(latest().historyStart).toBe(7);
  });

  it('should rotate history generation on same-length rewrites and refuse stale pages', () => {
    const { tap, out, full } = makeTap(10, 3);
    tap.accept(snapshot('c1', full));
    const generation = (out[0] as SnapshotMessage).state.historyGeneration;
    full[0] = msg('replacement');
    tap.accept(snapshot('c1', full));
    const next = (out[1] as SnapshotMessage).state;
    expect(next.historyGeneration).not.toBe(generation);
    tap.loadEarlier({
      conversationId: 'c1',
      historyGeneration: generation,
      beforeId: 'm7',
      before: 7,
    });
    expect(out.at(-1)).toMatchObject({
      type: 'earlier_messages',
      resyncRequired: true,
      messages: [],
    });
  });

  it('should reset the window on compaction and only page from the new baseline', () => {
    const { tap, out, full } = makeTap(1000, 3);
    tap.accept(snapshot('c1', full));
    const old = (out[0] as SnapshotMessage).state;
    const compacted = Array.from({ length: 20 }, (_, i) => msg(`compacted-${i}`));
    tap.accept(snapshot('c1', compacted));
    const next = (out[1] as SnapshotMessage).state;
    expect(next.historyStart).toBe(17);
    expect(next.historyGeneration).not.toBe(old.historyGeneration);
    tap.loadEarlier({
      conversationId: 'c1',
      beforeId: old.messages[0].id,
      before: old.historyStart,
      historyGeneration: old.historyGeneration,
    });
    expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [] });
    tap.loadEarlier({
      conversationId: 'c1',
      count: 2,
      beforeId: next.messages[0].id,
      before: next.historyStart,
      historyGeneration: next.historyGeneration,
    });
    expect(out.at(-1)).toMatchObject({
      historyGeneration: next.historyGeneration,
      before: 17,
      beforeId: 'compacted-17',
      historyStart: 15,
      messages: [compacted[15], compacted[16]],
    });
  });

  it('should reject missing and displaced anchors instead of falling back to numeric cursors', () => {
    const { tap, out, full } = makeTap(10, 3);
    tap.accept(snapshot('c1', full));
    for (const opts of [
      { beforeId: 'deleted', before: 7 },
      { beforeId: 'm7', before: 6 },
    ]) {
      tap.loadEarlier({ conversationId: 'c1', ...opts });
      expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [], historyStart: 7 });
    }
  });

  it('should give rehydrated caches a new lineage and require a snapshot before paging', () => {
    const { tap, out, full } = makeTap(10, 3);
    tap.accept(snapshot('c1', full));
    const generation = (out[0] as SnapshotMessage).state.historyGeneration;
    const restored = new MessageWindowTap((m) => out.push(m), {
      windowSize: 3,
      charBudget: 0,
      pageSize: 2,
    });
    restored.rehydrate('c1', full, 7);
    restored.loadEarlier({
      conversationId: 'c1',
      historyGeneration: generation,
      beforeId: 'm7',
      before: 7,
    });
    expect(out.at(-1)).toMatchObject({ resyncRequired: true, messages: [] });
  });

  it('should slice with the self-describing before cursor', () => {
    const { tap, out, full } = makeTap(1000, 300);
    tap.accept(snapshot('c1', full));
    const ok = tap.loadEarlier({ conversationId: 'c1', count: 20, before: 500 });
    expect(ok).toBe(true);
    const page = out[1] as EarlierMessage;
    expect(page.historyStart).toBe(480);
    expect(page.messages).toHaveLength(20);
    expect(page.messages[0].id).toBe('m480');
    expect(page.messages.at(-1)?.id).toBe('m499');
  });

  it('should reject out-of-range numeric cursors and non-integer counts', () => {
    const { tap, out, full } = makeTap(10, 3);
    tap.accept(snapshot('c1', full));
    tap.loadEarlier({ conversationId: 'c1', before: 999 });
    expect(out.at(-1)).toMatchObject({ resyncRequired: true });
    tap.loadEarlier({ conversationId: 'c1', before: -1 });
    expect(out.at(-1)).toMatchObject({ resyncRequired: true });
    tap.loadEarlier({ conversationId: 'c1', count: 0, before: 7 });
    expect((out.at(-1) as EarlierMessage).messages).toHaveLength(1);
  });

  it('should evict the least recently used conversation beyond the cache bound', () => {
    const out: ServerMessage[] = [];
    const tap = new MessageWindowTap((m) => out.push(m), {
      windowSize: 2,
      charBudget: 0,
      pageSize: 2,
    });
    for (let i = 0; i < 65; i++) tap.accept(snapshot(`c${i}`, [msg('a'), msg('b'), msg('c')]));
    // 第一个会话已被淘汰（超出 64 个缓存上限）
    expect(tap.loadEarlier({ conversationId: 'c0', all: true })).toBe(false);
    expect(tap.loadEarlier({ conversationId: 'c64', all: true })).toBe(true);
  });

  it('should serve the last accepted conversation when no conversationId is given', () => {
    const { tap, full } = makeTap(10, 3);
    tap.accept(snapshot('c1', full));
    const out2: ServerMessage[] = [];
    const tap2 = new MessageWindowTap((m) => out2.push(m), {
      windowSize: 3,
      charBudget: 0,
      pageSize: 2,
    });
    tap2.accept(snapshot('c1', full));
    expect(tap2.loadEarlier(2)).toBe(true);
    expect(out2.at(-1)).toMatchObject({
      type: 'earlier_messages',
      conversationId: 'c1',
      historyStart: 5,
    });
  });
});
