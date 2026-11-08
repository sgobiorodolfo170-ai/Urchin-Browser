/**
 * message-deletion.ts 单元测试
 *
 * 删除消息是破坏性操作：必须精确算出「这一条 + 与之绑定的附件 / 工具结果」，
 * 且对已被删除、非活跃分支、不可删角色的目标一律拒绝，而不是删错东西。
 *
 * 说明：SessionEntry 在 ambient shim 里是宽松索引签名（vendored SDK 未安装），
 * 测试用本地强类型 Entry 构造 fixture，仅在调用源码函数处做一次结构转换，
 * 避免整份断言退化到 any。
 */
import { describe, expect, it } from 'vitest';
import {
  messageDeletionTargets,
  undeletedContextEntries,
} from '../../src/pi-server/message-deletion.js';

type SourceEntries = Parameters<typeof messageDeletionTargets>[0];

interface Entry {
  type: string;
  id: string;
  parentId?: string | null;
  customType?: string;
  targetId?: string;
  replacement?: unknown;
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    customType?: string;
  };
}

type Entries = Entry[];

const asSource = (entries: Entries): SourceEntries => entries as unknown as SourceEntries;

const deletionTargets = (entries: Entries, targetId: string): string[] =>
  messageDeletionTargets(asSource(entries), targetId);

const visibleEntries = (entries: Entries): Entries => undeletedContextEntries(asSource(entries));

const entry = (value: Record<string, unknown>): Entry => value as unknown as Entry;

const user = (id: string, text = 'question'): Entry => ({
  type: 'message',
  id,
  parentId: null,
  message: { role: 'user', content: text },
});

const assistantWithCall = (id: string, callId: string): Entry => ({
  type: 'message',
  id,
  message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name: 'read', arguments: {} }],
  },
});

const toolResult = (id: string, callId: string): Entry => ({
  type: 'message',
  id,
  message: {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'read',
    content: [{ type: 'text', text: 'ok' }],
  },
});

const aside = (id: string, customType = 'file'): Entry => ({
  type: 'custom_message',
  id,
  customType,
});

const contextEdit = (targetId: string, replacement: unknown = null): Entry => ({
  type: 'context_edit',
  id: `edit-${targetId}`,
  targetId,
  replacement,
});

describe('messageDeletionTargets', () => {
  it('should include the assistant tool calls and their matching results', () => {
    const entries: Entries = [
      user('u1'),
      assistantWithCall('a1', 'call1'),
      toolResult('r1', 'call1'),
      user('u2'),
    ];
    expect(deletionTargets(entries, 'a1')).toEqual(['a1', 'r1']);
  });

  it('should ignore tool results belonging to other calls', () => {
    const entries: Entries = [
      user('u1'),
      assistantWithCall('a1', 'call1'),
      toolResult('r1', 'call1'),
      toolResult('r2', 'call2'),
      user('u2'),
    ];
    expect(deletionTargets(entries, 'a1')).toEqual(['a1', 'r1']);
  });

  it('should return only the selected user message when it has no attachment aside', () => {
    const entries: Entries = [user('u1'), assistantWithCall('a1', 'call1'), user('u2')];
    expect(deletionTargets(entries, 'u2')).toEqual(['u2']);
  });

  it('should include the attachment asides that immediately precede the selected user message', () => {
    const entries: Entries = [
      user('u1'),
      aside('f1'),
      aside('f2', 'parallel-work-reminder'),
      user('u2'),
    ];
    expect(deletionTargets(entries, 'u2')).toEqual(['u2', 'f2', 'f1']);
  });

  it('should stop attaching asides once a real message is reached', () => {
    const entries: Entries = [user('u1'), aside('f1'), user('u2')];
    expect(deletionTargets(entries, 'u2')).toEqual(['u2', 'f1']);
    // 只删 u1 时不会把属于 u2 的附件算进去
    expect(deletionTargets(entries, 'u1')).toEqual(['u1']);
  });

  it('should stop scanning at compaction or branch summary boundaries', () => {
    const entries: Entries = [
      aside('f1'),
      entry({ type: 'compaction', id: 'c1' }),
      user('u1'),
      aside('f2'),
      entry({ type: 'branch_summary', id: 's1' }),
      user('u2'),
    ];
    // 边界把附件挡在外面：两个目标都不继承边界之前的 aside
    expect(deletionTargets(entries, 'u2')).toEqual(['u2']);
    expect(deletionTargets(entries, 'u1')).toEqual(['u1']);
  });

  it('should treat entries removed by a null context edit as already deleted', () => {
    const entries: Entries = [user('u1'), contextEdit('u1'), user('u2')];
    expect(() => deletionTargets(entries, 'u1')).toThrow(
      'Message is no longer available for deletion',
    );
    expect(deletionTargets(entries, 'u2')).toEqual(['u2']);
  });

  it('should keep entries whose context edit carries a replacement', () => {
    const entries: Entries = [user('u1'), contextEdit('u1', { role: 'user', content: 'edited' })];
    expect(deletionTargets(entries, 'u1')).toEqual(['u1']);
  });

  it('should reject unknown ids, non-message entries and non-deletable roles', () => {
    const entries: Entries = [
      entry({ type: 'session', id: 'h' }),
      user('u1'),
      entry({ type: 'message', id: 'sys', message: { role: 'system', content: 'x' } }),
      entry({ type: 'message', id: 'tr', message: { role: 'toolResult', toolCallId: 'nope' } }),
    ];
    expect(() => deletionTargets(entries, 'missing')).toThrow();
    expect(() => deletionTargets(entries, 'h')).toThrow();
    expect(() => deletionTargets(entries, 'sys')).toThrow();
    expect(() => deletionTargets(entries, 'tr')).toThrow();
  });

  it('should not treat an inactive duplicate branch entry as deletable', () => {
    const entries: Entries = [
      user('u1'),
      assistantWithCall('a1', 'call1'),
      toolResult('r1', 'call1'),
    ];
    // 目标被 context edit 摘掉 = 不在活跃分支上
    const inactive: Entries = [...entries, contextEdit('a1')];
    expect(() => deletionTargets(inactive, 'a1')).toThrow();
  });
});

describe('undeletedContextEntries', () => {
  it('should drop entries deleted by a null context edit and keep the rest in order', () => {
    const entries: Entries = [
      user('u1'),
      assistantWithCall('a1', 'c1'),
      contextEdit('a1'),
      user('u2'),
    ];
    expect(visibleEntries(entries).map((e) => e.id)).toEqual(['u1', 'edit-a1', 'u2']);
  });

  it('should keep entries replaced by a non-null context edit', () => {
    const entries: Entries = [user('u1'), contextEdit('u1', { role: 'user', content: 'edited' })];
    expect(visibleEntries(entries).map((e) => e.id)).toEqual(['u1', 'edit-u1']);
  });

  it('should return every entry when no context edit exists', () => {
    const entries: Entries = [user('u1'), user('u2')];
    expect(visibleEntries(entries)).toHaveLength(2);
  });

  it('should apply a deletion set so later messages survive', () => {
    const entries: Entries = [
      user('u1'),
      assistantWithCall('a1', 'call1'),
      toolResult('r1', 'call1'),
      user('u2'),
    ];
    const targets = deletionTargets(entries, 'a1');
    const rewritten: Entries = [...entries, ...targets.map((id) => contextEdit(id))];
    expect(visibleEntries(rewritten).map((e) => e.id)).toEqual([
      'u1',
      'u2',
      ...targets.map((id) => `edit-${id}`),
    ]);
  });
});
