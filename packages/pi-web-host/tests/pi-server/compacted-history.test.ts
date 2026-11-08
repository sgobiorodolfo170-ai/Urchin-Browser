/**
 * compacted-history.ts 单元测试
 *
 * 覆盖祖先回溯、压缩切片（首次 / 连续 / retain-none）、消息序列化，
 * 以及 `getCompactedMessages` 的定位失败兜底。
 *
 * 为何切片要「从前一次压缩的保留点开始」：连续压缩若每次都从会话根开始，
 * 第二次摘要会重复包含第一次已折叠的内容，历史越长越膨胀；切片边界必须
 * 落在 `firstKeptEntryId` 上，两次压缩的内容才不重叠。
 */
import { describe, expect, it } from 'vitest';
import {
  getCompactedMessages,
  serializeCompactedEntries,
  sliceCompactedEntries,
  walkAncestors,
  type SessionEntryLike,
  type SessionManagerLike,
} from '../../src/pi-server/compacted-history.js';
import type { AgentMessage } from '../../src/pi-server/serialize.js';

describe('compacted-history', () => {
  describe('walkAncestors', () => {
    it('should walk from the target back to the root and return entries in forward order', () => {
      const entries: SessionEntryLike[] = [
        { id: 'e1', parentId: null, type: 'session' },
        { id: 'e2', parentId: 'e1', type: 'message' },
        { id: 'e3', parentId: 'e2', type: 'message' },
        { id: 'e4', parentId: 'e3', type: 'compaction' },
      ];

      const res = walkAncestors('e4', entries);
      expect(res.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    });

    it('should stop safely on cycles and broken links instead of looping forever', () => {
      const loopEntries: SessionEntryLike[] = [
        { id: 'e1', parentId: 'e2', type: 'message' },
        { id: 'e2', parentId: 'e1', type: 'message' },
      ];
      expect(walkAncestors('e1', loopEntries)).toHaveLength(2);
      expect(walkAncestors('missing', loopEntries)).toEqual([]);
    });
  });

  describe('sliceCompactedEntries', () => {
    it('should extract entries before firstKeptEntryId on the first compaction', () => {
      const branch: SessionEntryLike[] = [
        { id: 's0', parentId: null, type: 'session' },
        { id: 'm1', parentId: 's0', type: 'message' },
        { id: 'm2', parentId: 'm1', type: 'message' },
        { id: 'm3', parentId: 'm2', type: 'message' },
        { id: 'm4', parentId: 'm3', type: 'message' },
        {
          id: 'c1',
          parentId: 'm4',
          type: 'compaction',
          firstKeptEntryId: 'm3',
        },
      ];

      expect(sliceCompactedEntries(branch[5], branch).map((e) => e.id)).toEqual(['s0', 'm1', 'm2']);
    });

    it('should start from the previous compaction kept point so runs never overlap', () => {
      const branch: SessionEntryLike[] = [
        { id: 's0', parentId: null, type: 'session' },
        { id: 'm1', parentId: 's0', type: 'message' },
        { id: 'm2', parentId: 'm1', type: 'message' },
        {
          id: 'c1',
          parentId: 'm2',
          type: 'compaction',
          firstKeptEntryId: 'm2',
        },
        { id: 'm3', parentId: 'c1', type: 'message' },
        { id: 'm4', parentId: 'm3', type: 'message' },
        { id: 'm5', parentId: 'm4', type: 'message' },
        {
          id: 'c2',
          parentId: 'm5',
          type: 'compaction',
          firstKeptEntryId: 'm5',
        },
      ];

      expect(sliceCompactedEntries(branch[3], branch).map((e) => e.id)).toEqual(['s0', 'm1']);
      expect(sliceCompactedEntries(branch[7], branch).map((e) => e.id)).toEqual([
        'm2',
        'c1',
        'm3',
        'm4',
      ]);
    });

    it('should fold everything before the node in retain-none mode', () => {
      const branch: SessionEntryLike[] = [
        { id: 'm1', parentId: null, type: 'message' },
        { id: 'm2', parentId: 'm1', type: 'message' },
        {
          id: 'c1',
          parentId: 'm2',
          type: 'compaction',
          firstKeptEntryId: 'c1',
        },
      ];

      expect(sliceCompactedEntries(branch[2], branch).map((e) => e.id)).toEqual(['m1', 'm2']);
    });

    it('should return an empty slice when the compaction is not on the branch or nothing precedes the kept point', () => {
      const branch: SessionEntryLike[] = [
        { id: 'm1', parentId: null, type: 'message' },
        { id: 'm2', parentId: 'm1', type: 'compaction', firstKeptEntryId: 'm1' },
      ];
      const absent: SessionEntryLike = { id: 'other', parentId: null, type: 'compaction' };
      expect(sliceCompactedEntries(absent, branch)).toEqual([]);
      expect(sliceCompactedEntries(branch[1], branch)).toEqual([]);
    });

    it('should ignore a firstKeptEntryId that sits after the compaction itself', () => {
      const branch: SessionEntryLike[] = [
        { id: 'm1', parentId: null, type: 'message' },
        { id: 'c1', parentId: 'm1', type: 'compaction', firstKeptEntryId: 'later' },
        { id: 'later', parentId: 'c1', type: 'message' },
      ];
      expect(sliceCompactedEntries(branch[1], branch).map((e) => e.id)).toEqual(['m1']);
    });

    it('should fall back to just after the previous compaction when its kept point is missing from the branch', () => {
      const branch: SessionEntryLike[] = [
        { id: 'm1', parentId: null, type: 'message' },
        { id: 'c1', parentId: 'm1', type: 'compaction', firstKeptEntryId: 'gone' },
        { id: 'm2', parentId: 'c1', type: 'message' },
        { id: 'm3', parentId: 'm2', type: 'message' },
        { id: 'c2', parentId: 'm3', type: 'compaction', firstKeptEntryId: 'm3' },
      ];
      expect(sliceCompactedEntries(branch[4], branch).map((e) => e.id)).toEqual(['m2']);
    });
  });

  describe('serializeCompactedEntries', () => {
    it('should drop internal system messages and serialize user / assistant messages', () => {
      const entries: SessionEntryLike[] = [
        {
          id: 'e1',
          parentId: null,
          type: 'message',
          message: {
            role: 'system',
            content: 'internal prompt sections',
          } as unknown as AgentMessage,
        },
        {
          id: 'e2',
          parentId: 'e1',
          type: 'message',
          message: {
            role: 'user',
            content: '用户提问 1',
            timestamp: 1700000000000,
          } as unknown as AgentMessage,
        },
        {
          id: 'e3',
          parentId: 'e2',
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '模型回答 1' }],
            timestamp: 1700000001000,
          } as unknown as AgentMessage,
        },
      ];

      const msgs = serializeCompactedEntries(entries);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toEqual([{ type: 'text', text: '用户提问 1' }]);
      expect(msgs[1].role).toBe('assistant');
      expect(msgs[1].content).toEqual([{ type: 'text', text: '模型回答 1', truncated: false }]);

      const msgsWithSeq = serializeCompactedEntries(entries, () => 42);
      expect(msgsWithSeq[0].id).toContain('-42');
      expect(msgsWithSeq[1].id).toContain('-42');
    });

    it('should include visible custom messages and skip hidden ones', () => {
      const entries: SessionEntryLike[] = [
        {
          id: 'c1',
          parentId: null,
          type: 'custom_message',
          content: 'visible note',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'c2',
          parentId: 'c1',
          type: 'custom_message',
          content: 'hidden note',
          display: false,
        },
      ];
      const msgs = serializeCompactedEntries(entries);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('custom');
      expect(msgs[0].id).toContain(String(new Date('2026-01-01T00:00:00.000Z').getTime()));
    });

    it('should skip entries without a message payload', () => {
      expect(serializeCompactedEntries([{ id: 'x', parentId: null, type: 'message' }])).toEqual([]);
    });
  });

  describe('getCompactedMessages', () => {
    it('should locate the compaction by UI id and return the folded UiMessage history', () => {
      const branch: SessionEntryLike[] = [
        {
          id: 'm1',
          parentId: null,
          type: 'message',
          message: {
            role: 'user',
            content: '历史问题',
            timestamp: 1700000000000,
          } as unknown as AgentMessage,
        },
        {
          id: 'm2',
          parentId: 'm1',
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '历史回答' }],
            timestamp: 1700000001000,
          } as unknown as AgentMessage,
        },
        {
          id: 'm3',
          parentId: 'm2',
          type: 'message',
          message: {
            role: 'user',
            content: '保留的近期问题',
            timestamp: 1700000002000,
          } as unknown as AgentMessage,
        },
        {
          id: 'cmp-node',
          parentId: 'm3',
          type: 'compaction',
          firstKeptEntryId: 'm3',
          timestamp: new Date(1700000003000).toISOString(),
          summary: '压缩摘要',
          tokensBefore: 45000,
        },
      ];

      const mockSm: SessionManagerLike = {
        getEntries: () => branch,
        getBranch: () => branch,
        buildContextEntries: () => [branch[3]],
        getEntry: (id) => branch.find((e) => e.id === id),
      };

      const result = getCompactedMessages(mockSm, 'cmp-node');
      expect(result.error).toBeUndefined();
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
    });

    it('should return compactedHistoryNotFound for an unknown compaction id', () => {
      const mockSm: SessionManagerLike = {
        getEntries: () => [],
        buildContextEntries: () => [],
      };

      const result = getCompactedMessages(mockSm, 'non-existent-id');
      expect(result.error).toBe('compactedHistoryNotFound');
      expect(result.messages).toEqual([]);
    });

    it('should resolve the compaction through getEntry and fall back to walking ancestors when getBranch fails', () => {
      const branch: SessionEntryLike[] = [
        {
          id: 'm1',
          parentId: null,
          type: 'message',
          message: { role: 'user', content: 'q', timestamp: 1 } as unknown as AgentMessage,
        },
        { id: 'c1', parentId: 'm1', type: 'compaction', firstKeptEntryId: 'c1' },
      ];
      const mockSm: SessionManagerLike = {
        getEntries: () => branch,
        getBranch: () => {
          throw new Error('branch unavailable');
        },
        buildContextEntries: () => [],
        getEntry: (id) => branch.find((e) => e.id === id),
      };

      const result = getCompactedMessages(mockSm, 'c1');
      expect(result.error).toBeUndefined();
      expect(result.messages.map((m) => m.role)).toEqual(['user']);
    });

    it('should report the thrown error message instead of crashing', () => {
      const mockSm: SessionManagerLike = {
        buildContextEntries: () => {
          throw new Error('session exploded');
        },
      };
      expect(getCompactedMessages(mockSm, 'x')).toEqual({
        messages: [],
        error: 'session exploded',
      });
    });

    it('should search by derived UI id before giving up on a non-compaction target', () => {
      const branch: SessionEntryLike[] = [
        {
          id: 'a1',
          parentId: null,
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }],
            timestamp: 1700000005000,
          } as unknown as AgentMessage,
        },
      ];
      const mockSm: SessionManagerLike = {
        getEntries: () => branch,
        buildContextEntries: () => [],
      };
      const result = getCompactedMessages(mockSm, 'a-1700000005000-1');
      expect(result.error).toBe('compactedHistoryNotFound');
    });
  });
});
