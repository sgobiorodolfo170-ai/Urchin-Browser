/**
 * session-branch.ts 单元测试
 *
 * 两条线：
 * 1. 分支选择语义（issue #567）：reask 叶子优先、元信息分支劫持纠正、
 *    有意分叉不误伤、无当前叶子时选最深分支、重排后父子序不乱；
 * 2. 时间戳缓存等价性：与逐路径解析的参考实现在畸形图 / 重复 ID / 负时间戳 /
 *    NaN / 稳定并列等场景下完全一致，且共享链只解析一次。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  calibrateSessionLeaf,
  findBranchCandidates,
  reorderEntriesForMainBranch,
  selectBestSessionLeaf,
  type BranchCandidate,
  type LeafCalibrationResult,
} from '../../src/pi-server/session-branch.js';

/**
 * 测试条目形状：SessionEntry 在 ambient shim 里带 `[key: string]: any` 索引签名，
 * 直接用会让断言与索引访问退化成 any（eslint no-unsafe-*）。测试用它保持类型安全，
 * 传入源码函数时结构兼容。
 */
interface Entry {
  id?: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string | number;
  customType?: string;
  [key: string]: unknown;
}

/** 本地强类型条目 → 源码 SessionEntry 的结构转换（ambient shim 的 SessionEntry 要求 message） */
type SourceEntry = Parameters<typeof findBranchCandidates>[0][number];

const toSource = (entries: Entry[]): SourceEntry[] => entries as unknown as SourceEntry[];
const candidatesOf = (entries: Entry[]) => findBranchCandidates(toSource(entries));
const bestLeafOf = (entries: Entry[], current?: string | null) =>
  selectBestSessionLeaf(toSource(entries), current);
const reorderOf = (entries: Entry[]) => reorderEntriesForMainBranch(toSource(entries));
const calibrateOf = (entries: Entry[], leaf: () => string | null, branch: (id: string) => void) =>
  calibrateSessionLeaf({ getEntries: () => toSource(entries), getLeafId: leaf, branch });

describe('session-branch selection (issue #567)', () => {
  it('should honor the latest same-file reask even before a replacement message exists', () => {
    const entries: Entry[] = [
      { id: 'old1', parentId: null, type: 'message' },
      { id: 'old2', parentId: 'old1', type: 'message' },
      { id: 'first-edit', parentId: null, type: 'custom', customType: 'pi-web-ui:reask' },
      { id: 'replacement', parentId: 'first-edit', type: 'message' },
      { id: 'latest-edit', parentId: null, type: 'custom', customType: 'pi-web-ui:reask' },
    ];
    expect(bestLeafOf(entries, 'old2')).toMatchObject({
      bestLeafId: 'latest-edit',
      changed: true,
    });
    expect(bestLeafOf(entries, 'latest-edit')).toMatchObject({
      bestLeafId: 'latest-edit',
      changed: false,
    });
  });

  it('should return unchanged for a linear single-branch conversation', () => {
    const entries: Entry[] = [
      { id: 'h1', type: 'session' },
      { id: 'm1', parentId: null, type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm2', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
      { id: 'm3', parentId: 'm2', type: 'message', timestamp: '2026-10-08T10:02:00.000Z' },
    ];

    const candidates = candidatesOf(entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].leafId).toBe('m3');
    expect(candidates[0].messageCount).toBe(3);

    const result = bestLeafOf(entries, 'm3');
    expect(result).not.toBeNull();
    expect(result?.bestLeafId).toBe('m3');
    expect(result?.changed).toBe(false);

    const reordered = reorderOf(entries);
    expect(reordered.changed).toBe(false);
  });

  it('should detect and correct metadata-only branch hijacking', () => {
    const entries: Entry[] = [
      { id: 'h1', type: 'session' },
      { id: 'm1', parentId: null, type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: '8775fb27', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:30:00.000Z' },
    ];

    let prev = '8775fb27';
    for (let i = 293; i <= 556; i++) {
      const id = `m${i}`;
      entries.push({
        id,
        parentId: prev,
        type: 'message',
        timestamp: `2026-10-08T11:00:${String(i % 60).padStart(2, '0')}.000Z`,
      });
      prev = id;
    }
    entries.push({
      id: 'c9560bdb',
      parentId: prev,
      type: 'message',
      timestamp: '2026-10-08T11:14:41.139Z',
    });

    entries.push({
      id: 'plan-entry-1',
      parentId: '8775fb27',
      type: 'custom',
      customType: 'plannotator',
      timestamp: '2026-10-08T11:53:01.358Z',
    });
    entries.push({
      id: 'plan-entry-2',
      parentId: 'plan-entry-1',
      type: 'custom',
      customType: 'plannotator',
      timestamp: '2026-10-08T11:53:01.400Z',
    });

    const currentTailId = 'plan-entry-2';

    const candidates = candidatesOf(entries);
    expect(candidates).toHaveLength(2);

    const sideCand = candidates.find((c) => c.leafId === 'plan-entry-2');
    const mainCand = candidates.find((c) => c.leafId === 'c9560bdb');
    expect(sideCand?.messageCount).toBe(2);
    expect(mainCand?.messageCount).toBe(267);

    const calibrated = bestLeafOf(entries, currentTailId);
    expect(calibrated?.changed).toBe(true);
    expect(calibrated?.bestLeafId).toBe('c9560bdb');
    expect(calibrated?.currentLeafId).toBe('plan-entry-2');

    let activeLeaf = currentTailId as string | null;
    const memResult = calibrateOf(
      entries,
      () => activeLeaf,
      (id) => {
        activeLeaf = id;
      },
    );
    expect(memResult.changed).toBe(true);
    expect(memResult.calibratedLeafId).toBe('c9560bdb');
    expect(activeLeaf).toBe('c9560bdb');

    const reordered = reorderOf(entries);
    expect(reordered.changed).toBe(true);
    const nonHeader = reordered.entries.filter((e) => e.type !== 'session');
    expect(nonHeader[nonHeader.length - 1].id).toBe('c9560bdb');

    expect(reordered.entries).toHaveLength(entries.length);
    expect(reordered.entries.find((e) => e.id === 'plan-entry-1')).toBeDefined();
    expect(reordered.entries.find((e) => e.id === 'plan-entry-2')).toBeDefined();

    const indexMap = new Map<string, number>();
    const reorderedEntries: Entry[] = reordered.entries;
    reorderedEntries.forEach((e, idx) => {
      if (e.id) indexMap.set(e.id, idx);
    });
    for (const e of reorderedEntries) {
      if (e.parentId && e.id && indexMap.has(e.parentId)) {
        expect(indexMap.get(e.parentId)!).toBeLessThan(indexMap.get(e.id)!);
      }
    }
  });

  it('should preserve intentional branching when the active branch has message continuation', () => {
    const entries: Entry[] = [
      { id: 'h1', type: 'session' },
      { id: 'm1', parentId: null, type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm2', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
      { id: 'm3_old', parentId: 'm2', type: 'message', timestamp: '2026-10-08T10:02:00.000Z' },
      { id: 'm4_old', parentId: 'm3_old', type: 'message', timestamp: '2026-10-08T10:03:00.000Z' },
      { id: 'm3_fork', parentId: 'm2', type: 'message', timestamp: '2026-10-08T10:05:00.000Z' },
      {
        id: 'm4_fork',
        parentId: 'm3_fork',
        type: 'message',
        timestamp: '2026-10-08T10:06:00.000Z',
      },
    ];

    const result = bestLeafOf(entries, 'm4_fork');
    expect(result?.changed).toBe(false);
    expect(result?.bestLeafId).toBe('m4_fork');
  });

  it('should select the deepest branch when no current leaf is provided', () => {
    const entries: Entry[] = [
      { id: 'h1', type: 'session' },
      { id: 'm1', parentId: null, type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm2_short', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
      { id: 'm2_long', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:02:00.000Z' },
      {
        id: 'm3_long',
        parentId: 'm2_long',
        type: 'message',
        timestamp: '2026-10-08T10:03:00.000Z',
      },
    ];

    const result = bestLeafOf(entries, null);
    expect(result?.bestLeafId).toBe('m3_long');
    expect(result?.changed).toBe(true);
    expect(result?.reason).toContain('No current leaf');
  });

  it('should report a missing current leaf instead of silently keeping it', () => {
    const entries: Entry[] = [
      { id: 'm1', type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm2', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
      { id: 'm3', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:02:00.000Z' },
    ];
    const result = bestLeafOf(entries, 'gone');
    expect(result).toMatchObject({
      currentLeafId: 'gone',
      changed: true,
    });
    expect(result?.bestLeafId).toBe('m3');
    expect(result?.reason).toContain('not found in branch leaves');
  });

  it('should preserve valid transcript entries without an id field during reordering (#601)', () => {
    const entries: Entry[] = [
      { type: 'session', id: 'sess_1', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm1', parentId: null, type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
      { type: 'custom_note', parentId: 'm1', note: 'attached-to-m1' },
      { type: 'DiagnosticLog', note: 'dangling-no-id-no-parent' },
      { id: 'm2', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:02:00.000Z' },
      { id: 'm3', parentId: 'm2', type: 'message', timestamp: '2026-10-08T10:03:00.000Z' },
      { id: 'ext_tail', parentId: 'm1', type: 'custom', timestamp: '2026-10-08T10:04:00.000Z' },
    ];

    const reordered = reorderOf(entries);
    expect(reordered.changed).toBe(true);
    expect(reordered.entries.length).toBe(entries.length);
    expect(reordered.entries).toContain(entries[2]);
    expect(reordered.entries).toContain(entries[3]);
    const nonHeaderWithId = reordered.entries.filter(
      (e) => e.type !== 'session' && typeof e.id === 'string',
    );
    expect(nonHeaderWithId[nonHeaderWithId.length - 1]?.id).toBe('m3');
  });

  it('should return null calibration when there is nothing to branch on', () => {
    expect(bestLeafOf([])).toBeNull();
    expect(bestLeafOf([{ id: 'h', type: 'session' }])).toBeNull();
    const single = calibrateOf(
      [{ id: 'm1', type: 'message' }],
      () => 'm1',
      () => {
        throw new Error('should not branch');
      },
    );
    expect(single.changed).toBe(false);
    expect(single.calibratedLeafId).toBe('m1');
  });

  it('should not reorder when the tail already is the best leaf', () => {
    const entries: Entry[] = [
      { id: 'm1', type: 'message', timestamp: '2026-10-08T10:00:00.000Z' },
      { id: 'm2', parentId: 'm1', type: 'message', timestamp: '2026-10-08T10:01:00.000Z' },
    ];
    const reordered = reorderOf(entries);
    expect(reordered.changed).toBe(false);
    expect(reordered.entries).toBe(entries);
  });

  it('should surface calibration failures instead of throwing', () => {
    const result = calibrateSessionLeaf({
      getEntries: () => {
        throw new Error('boom');
      },
      getLeafId: () => 'leaf',
      branch: () => {
        // getEntries 抛错时不应走到 branch
      },
    });
    expect(result.changed).toBe(false);
    expect(result.calibratedLeafId).toBe('leaf');
    expect(result.reason).toContain('boom');
  });
});

function parseEntryTimestamp(ts?: unknown): number {
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  } else if (typeof ts === 'number' && !Number.isNaN(ts)) {
    return ts;
  }
  return 0;
}

/** 缓存改造前的参考实现：每条叶子路径独立解析时间戳。 */
function legacyFindBranchCandidates(entries: Entry[]): BranchCandidate[] {
  const validEntries: Entry[] = [];
  const byId = new Map<string, Entry>();
  const childCount = new Map<string, number>();

  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    if (entry.type === 'session') continue;
    validEntries.push(entry);
    byId.set(entry.id, entry);
  }

  for (const entry of validEntries) {
    const pid = typeof entry.parentId === 'string' ? entry.parentId : null;
    if (pid && byId.has(pid)) {
      childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
    }
  }

  const leaves: Entry[] = [];
  for (const entry of validEntries) {
    const id = entry.id;
    if (id === undefined) continue;
    if ((childCount.get(id) ?? 0) === 0) {
      leaves.push(entry);
    }
  }

  if (leaves.length === 0) return [];

  const candidates: BranchCandidate[] = [];

  for (const leaf of leaves) {
    const leafId = leaf.id!;
    const path: Entry[] = [];
    const visited = new Set<string>();
    let cur: string | null = leafId;

    while (cur !== null && byId.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      const node: Entry = byId.get(cur)!;
      path.push(node);
      cur = typeof node.parentId === 'string' ? node.parentId : null;
    }

    path.reverse();

    let messageCount = 0;
    let lastMessageTimestamp = 0;

    for (const node of path) {
      if (node.type === 'message') {
        messageCount += 1;
        const ts = parseEntryTimestamp(node.timestamp);
        if (ts > lastMessageTimestamp) {
          lastMessageTimestamp = ts;
        }
      }
    }

    const tailTimestamp = parseEntryTimestamp(leaf.timestamp);

    candidates.push({
      leafId,
      leafEntry: leaf as unknown as BranchCandidate['leafEntry'],
      totalEntries: path.length,
      messageCount,
      lastMessageTimestamp,
      tailTimestamp,
      pathIds: path.map((n) => n.id!),
    });
  }

  return candidates;
}

function findLowestCommonAncestor(
  branchA: BranchCandidate,
  branchB: BranchCandidate,
): string | null {
  const setA = new Set(branchA.pathIds);
  let lca: string | null = null;
  for (const id of branchB.pathIds) {
    if (setA.has(id)) {
      lca = id;
    } else {
      break;
    }
  }
  return lca;
}

function legacySelectBestSessionLeaf(
  entries: Entry[],
  currentLeafId?: string | null,
): LeafCalibrationResult | null {
  const candidates = legacyFindBranchCandidates(entries);
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    const single = candidates[0];
    return {
      bestLeafId: single.leafId,
      currentLeafId: currentLeafId ?? null,
      changed:
        currentLeafId !== undefined && currentLeafId !== null && currentLeafId !== single.leafId,
    };
  }

  const sorted = [...candidates].sort((a, b) => {
    if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
    if (b.lastMessageTimestamp !== a.lastMessageTimestamp)
      return b.lastMessageTimestamp - a.lastMessageTimestamp;
    if (b.totalEntries !== a.totalEntries) return b.totalEntries - a.totalEntries;
    return b.tailTimestamp - a.tailTimestamp;
  });

  const bestCandidate = sorted[0];

  if (!currentLeafId) {
    return {
      bestLeafId: bestCandidate.leafId,
      currentLeafId: null,
      changed: true,
      reason: 'No current leaf specified; selected deepest candidate',
    };
  }

  const currentCandidate = candidates.find((c) => c.leafId === currentLeafId);
  if (!currentCandidate) {
    return {
      bestLeafId: bestCandidate.leafId,
      currentLeafId,
      changed: true,
      reason: `Current leaf "${currentLeafId}" not found in branch leaves`,
    };
  }

  if (currentCandidate.leafId === bestCandidate.leafId) {
    return {
      bestLeafId: bestCandidate.leafId,
      currentLeafId,
      changed: false,
    };
  }

  const lca = findLowestCommonAncestor(currentCandidate, bestCandidate);
  const lcaIndexCurrent = lca ? currentCandidate.pathIds.indexOf(lca) : -1;
  const currentEntriesAfterLca =
    lcaIndexCurrent >= 0 ? currentCandidate.pathIds.slice(lcaIndexCurrent + 1) : [];

  const byId = new Map<string, Entry>();
  for (const e of entries) {
    if (e && typeof e.id === 'string') byId.set(e.id, e);
  }

  let currentMessagesAfterLca = 0;
  for (const id of currentEntriesAfterLca) {
    const node = byId.get(id);
    if (node?.type === 'message') currentMessagesAfterLca += 1;
  }

  const lcaIndexBest = lca ? bestCandidate.pathIds.indexOf(lca) : -1;
  const bestEntriesAfterLca =
    lcaIndexBest >= 0 ? bestCandidate.pathIds.slice(lcaIndexBest + 1) : [];
  let bestMessagesAfterLca = 0;
  for (const id of bestEntriesAfterLca) {
    const node = byId.get(id);
    if (node?.type === 'message') bestMessagesAfterLca += 1;
  }

  if (currentMessagesAfterLca === 0 && bestMessagesAfterLca > 0) {
    return {
      bestLeafId: bestCandidate.leafId,
      currentLeafId,
      changed: true,
      reason: `Current branch has no messages after divergence (LCA=${lca}), while main branch has ${bestMessagesAfterLca} messages`,
    };
  }

  if (bestCandidate.messageCount > currentCandidate.messageCount) {
    return {
      bestLeafId: bestCandidate.leafId,
      currentLeafId,
      changed: true,
      reason: `Main branch has ${bestCandidate.messageCount} messages vs current branch's ${currentCandidate.messageCount}`,
    };
  }

  return {
    bestLeafId: currentCandidate.leafId,
    currentLeafId,
    changed: false,
  };
}

function compare(entries: Entry[]) {
  const expected = legacyFindBranchCandidates(entries);
  const actual = candidatesOf(entries);
  expect(actual).toEqual(expected);
  actual.forEach((candidate, i) => expect(candidate.leafEntry).toBe(expected[i].leafEntry));
  for (const current of [undefined, null, 'missing', ...entries.filter(Boolean).map((e) => e.id)]) {
    expect(bestLeafOf(entries, current)).toEqual(legacySelectBestSessionLeaf(entries, current));
  }
}

describe('session branch timestamp cache', () => {
  it('should preserve malformed graphs, duplicate objects/IDs, negative timestamps and stable ties', () => {
    const duplicate = { id: 'same', type: 'message', timestamp: '1960-01-01' };
    const fixtures: unknown[][] = [
      [],
      [null, {}, { id: '' }, { id: 'header', type: 'session' }],
      [duplicate, { ...duplicate, timestamp: '2026-01-01' }, duplicate],
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ],
      [
        { id: 'a', parentId: 'b', type: 'message', timestamp: -10 },
        { id: 'b', parentId: 'a' },
        { id: 'leaf', parentId: 'a' },
      ],
      [
        { id: 'root', type: 'message', timestamp: '1960-01-01' },
        { id: 'first', parentId: 'root' },
        { id: 'second', parentId: 'root' },
      ],
      [
        { id: 'a', parentId: 'missing', type: 'message', timestamp: 'invalid' },
        { id: 'b', type: 'message', timestamp: 0 },
        { id: 'c', timestamp: NaN },
      ],
    ];
    fixtures.forEach((entries) => compare(entries as Entry[]));
    const tied = candidatesOf(fixtures[5] as Entry[]);
    expect(tied.map((c) => c.leafId)).toEqual(['first', 'second']);
    expect(tied[0].lastMessageTimestamp).toBe(0);
    let seed = 567;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const timestamps = [undefined, 'invalid', '1960-01-01', '2026-01-01', -99, 0, NaN, Infinity];
    for (let trial = 0; trial < 120; trial++) {
      const entries = Array.from({ length: 18 }, () => ({
        id: ['', 'a', 'b', 'c', 'd', 'e', 'f'][random(7)],
        parentId: [null, 'a', 'b', 'c', 'd', 'e', 'missing'][random(7)],
        type: ['message', 'custom', 'session'][random(3)],
        timestamp: timestamps[random(timestamps.length)],
      })) as Entry[];
      compare(entries);
    }
  });

  it('should parse shared-chain nodes once per call and preserve paths and selection', () => {
    const depth = 600;
    const leaves = 80;
    const entries: Entry[] = Array.from({ length: depth }, (_, i) => ({
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      type: 'message',
      timestamp: '2026-01-01',
    }));
    for (let i = 0; i < leaves; i++)
      entries.push({
        id: `leaf${i}`,
        parentId: `m${depth - 1}`,
        type: 'message',
        timestamp: '2026-01-02',
      });
    const parse = vi.spyOn(Date, 'parse');
    try {
      const oldCandidates = legacyFindBranchCandidates(entries);
      expect(parse).toHaveBeenCalledTimes(leaves * (depth + 2));
      parse.mockClear();
      expect(candidatesOf(entries)).toEqual(oldCandidates);
      expect(parse).toHaveBeenCalledTimes(depth + leaves);
      parse.mockClear();
      const oldSelection = legacySelectBestSessionLeaf(entries, 'leaf79');
      expect(parse).toHaveBeenCalledTimes(leaves * (depth + 2));
      parse.mockClear();
      expect(bestLeafOf(entries, 'leaf79')).toEqual(oldSelection);
      expect(parse).toHaveBeenCalledTimes(depth + leaves);
    } finally {
      parse.mockRestore();
    }
    entries[0].timestamp = '2030-01-01';
    expect(candidatesOf(entries)).toEqual(legacyFindBranchCandidates(entries));
    expect(candidatesOf(entries)[0].lastMessageTimestamp).toBe(Date.parse('2030-01-01'));
  });
});
