/**
 * context-budget.ts 单元测试
 *
 * 覆盖 token 估算（文本 / 消息内容块 / bash 输出）、近期轮次保护点、
 * 两级裁剪（工具输出截断 + 完成步骤思考日志折叠）与分层调度水位。
 *
 * 为何水位要用「有效上限 = min(软上限, 物理余量)」：小窗口模型套用为大窗口
 * 算出的 reserve 时，`window - reserve` 会变成负数，水位随之为负 → 每轮都判定
 * 需要压缩。这里用回退分支保证阈值永远落在合理区间。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
}));

import {
  DEFAULT_MIN_TRIM_BYTES,
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_PRUNE_WATERMARK,
  DEFAULT_STAGE2_WATERMARK,
  DEFAULT_TAIL_LINES,
  estimateMessagesTotalTokens,
  estimateMessageTokens,
  estimateTextTokens,
  findRecentCutoffIndex,
  foldCompletedStepLogs,
  pruneContextHierarchically,
  trimDistantToolOutputs,
  type AgentMessage,
} from '../../src/pi-server/context-budget.js';

describe('context-budget constants', () => {
  it('should expose the documented default watermarks and thresholds', () => {
    expect(DEFAULT_PRUNE_WATERMARK).toBe(0.7);
    expect(DEFAULT_STAGE2_WATERMARK).toBe(0.85);
    expect(DEFAULT_PRUNE_WATERMARK).toBeLessThan(DEFAULT_STAGE2_WATERMARK);
    expect(DEFAULT_TAIL_LINES).toBe(3);
    expect(DEFAULT_KEEP_RECENT_TURNS).toBe(2);
    expect(DEFAULT_MIN_TRIM_BYTES).toBe(1000);
  });
});

describe('token estimation', () => {
  it('should estimate text tokens as four characters per token', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('1234')).toBe(1);
    expect(estimateTextTokens('12345')).toBe(2);
    expect(estimateTextTokens('12345678')).toBe(2);
  });

  it('should never estimate a message below one token', () => {
    expect(estimateMessageTokens({ role: 'user', content: '' } as unknown as AgentMessage)).toBe(1);
    expect(estimateMessageTokens({} as unknown as AgentMessage)).toBe(1);
  });

  it('should count text, thinking, tool-call arguments and images inside content arrays', () => {
    const textOnly = estimateMessageTokens({
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(400) }],
    } as unknown as AgentMessage);
    expect(textOnly).toBe(100);

    const withThinking = estimateMessageTokens({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'x'.repeat(200) }],
    } as unknown as AgentMessage);
    expect(withThinking).toBe(50);

    const withCall = estimateMessageTokens({
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }],
    } as unknown as AgentMessage);
    expect(withCall).toBe(estimateTextTokens(JSON.stringify({ path: 'a.ts' })));

    const withImage = estimateMessageTokens({
      role: 'user',
      content: [{ type: 'image' }],
    } as unknown as AgentMessage);
    expect(withImage).toBe(800);
  });

  it('should add bashExecution output on top of its content and ignore primitive blocks', () => {
    const message = {
      role: 'bashExecution',
      content: 'abcd',
      output: 'x'.repeat(40),
    } as unknown as AgentMessage;
    expect(estimateMessageTokens(message)).toBe(1 + 10);

    const primitive = estimateMessageTokens({
      role: 'user',
      content: [null, 'raw', 3],
    } as unknown as AgentMessage);
    expect(primitive).toBe(1);
  });

  it('should sum message estimates across the conversation', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(40) },
      { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(40) }] },
    ] as unknown as AgentMessage[];
    expect(estimateMessagesTotalTokens(messages)).toBe(20);
    expect(estimateMessagesTotalTokens([])).toBe(0);
  });
});

describe('findRecentCutoffIndex', () => {
  it('should protect the configured number of recent user turns', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
      { role: 'user', content: 'turn 3' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 3' }] },
    ] as unknown as AgentMessage[];

    expect(findRecentCutoffIndex(messages, 2)).toBe(2);
    expect(findRecentCutoffIndex(messages, 1)).toBe(4);
  });

  it('should fall back to the beginning when there are no user turns or the turn budget is zero', () => {
    const assistantOnly = [{ role: 'assistant', content: [] }] as unknown as AgentMessage[];
    expect(findRecentCutoffIndex(assistantOnly, 2)).toBe(0);
    expect(findRecentCutoffIndex([], 2)).toBe(0);
    expect(
      findRecentCutoffIndex([{ role: 'user', content: 'a' }] as unknown as AgentMessage[], 0),
    ).toBe(0);
  });
});

describe('trimDistantToolOutputs', () => {
  function conversationWithLongToolResult(lines: number): AgentMessage[] {
    const longText = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
    return [
      { role: 'user', content: 'read large file', timestamp: 1000 },
      {
        role: 'toolResult',
        toolCallId: 'call_123',
        toolName: 'read',
        content: [{ type: 'text', text: longText }],
        isError: false,
        details: { path: 'test.txt' },
        timestamp: 1001,
      },
      { role: 'user', content: 'recent 1', timestamp: 2000 },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2001 },
      { role: 'user', content: 'recent 2', timestamp: 3000 },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 3001 },
    ] as unknown as AgentMessage[];
  }

  it('should trim a distant oversized tool result while keeping head, tail and metadata', () => {
    const messages = conversationWithLongToolResult(50);
    const res = trimDistantToolOutputs(messages, { keepRecentTurns: 2 });
    expect(res.trimmedCount).toBe(1);
    expect(res.savedBytes).toBeGreaterThan(0);
    expect(res.savedTokens).toBeGreaterThan(0);

    const trimmedToolMsg = res.messages[1] as unknown as Record<string, unknown>;
    expect(trimmedToolMsg.toolCallId).toBe('call_123');
    expect(trimmedToolMsg.toolName).toBe('read');
    expect(trimmedToolMsg.details).toEqual({ path: 'test.txt' });

    const textBlock = (trimmedToolMsg.content as { type: string; text: string }[])[0];
    expect(textBlock.text).toContain('line 1\nline 2\nline 3');
    expect(textBlock.text).toContain('line 48\nline 49\nline 50');
    expect(textBlock.text).toContain('[Tool output trimmed:');
    expect(textBlock.text).toContain('44 lines');

    // 幂等：已带占位符的输出不再二次裁剪
    expect(trimDistantToolOutputs(res.messages, { keepRecentTurns: 2 }).trimmedCount).toBe(0);
    // 原始消息不被就地修改
    expect((messages[1] as unknown as { content: { text: string }[] }).content[0].text).toContain(
      'line 25',
    );
  });

  it('should protect tool output inside recent turns', () => {
    const longLines = Array.from({ length: 50 }, (_, i) => `recent line ${i + 1}`).join('\n');
    const messages = [
      { role: 'user', content: 'recent turn', timestamp: 1000 },
      {
        role: 'toolResult',
        toolCallId: 'call_recent',
        toolName: 'bash',
        content: [{ type: 'text', text: longLines }],
        timestamp: 1001,
      },
    ] as unknown as AgentMessage[];

    const res = trimDistantToolOutputs(messages, { keepRecentTurns: 1 });
    expect(res.trimmedCount).toBe(0);
    expect(res.messages[1]).toBe(messages[1]);
  });

  it('should honour minLines/minBytes thresholds and leave short output untouched', () => {
    const messages = [
      { role: 'user', content: 'old' },
      {
        role: 'toolResult',
        toolName: 'read',
        content: [
          {
            type: 'text',
            text: ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(40)).join('\n'),
          },
        ],
      },
      { role: 'user', content: 'now' },
    ] as unknown as AgentMessage[];

    expect(
      trimDistantToolOutputs(messages, { minLines: 100, minBytes: 100_000 }).trimmedCount,
    ).toBe(0);
    const res = trimDistantToolOutputs(messages, {
      minLines: 2,
      minBytes: 100_000,
      headLines: 1,
      tailLines: 1,
      keepRecentTurns: 1,
    });
    expect(res.trimmedCount).toBe(1);
    expect(
      (res.messages[1] as unknown as { content: { text: string }[] }).content[0].text,
    ).toContain('[Tool output trimmed: 4 lines');
  });

  it('should trim distant bashExecution output', () => {
    const output = Array.from({ length: 40 }, (_, i) => `bash line ${i + 1}`).join('\n');
    const messages = [
      { role: 'user', content: 'run it' },
      { role: 'bashExecution', output, timestamp: 1 },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
    ] as unknown as AgentMessage[];

    const res = trimDistantToolOutputs(messages, { keepRecentTurns: 2 });
    expect(res.trimmedCount).toBe(1);
    expect((res.messages[1] as unknown as { output: string }).output).toContain(
      '[Tool output trimmed:',
    );
  });

  it('should skip non-text blocks and non-tool roles', () => {
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'toolResult', toolName: 'read', content: [{ type: 'image' }, null, 'raw'] },
      { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
    ] as unknown as AgentMessage[];
    const res = trimDistantToolOutputs(messages, { keepRecentTurns: 2 });
    expect(res.trimmedCount).toBe(0);
    expect(res.savedBytes).toBe(0);
  });

  it('should treat a single very long line as eligible by bytes but keep it when there is no middle to cut', () => {
    const oneLine = 'x'.repeat(5000);
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: oneLine }] },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
    ] as unknown as AgentMessage[];
    const res = trimDistantToolOutputs(messages, { keepRecentTurns: 2 });
    expect(res.trimmedCount).toBe(0);
    expect((res.messages[1] as unknown as { content: { text: string }[] }).content[0].text).toBe(
      oneLine,
    );
  });

  it('should leave a too-short bashExecution output untouched', () => {
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'bashExecution', output: 'one line only', timestamp: 1 },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
    ] as unknown as AgentMessage[];
    expect(trimDistantToolOutputs(messages, { keepRecentTurns: 2 }).trimmedCount).toBe(0);
  });
});

describe('foldCompletedStepLogs', () => {
  it('should fold distant long thinking logs of completed steps', () => {
    const longThinking =
      'Analyzing error...\n' + 'debug details...\n'.repeat(40) + 'Conclusion: need fix.';
    const messages = [
      { role: 'user', content: 'step 1', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: longThinking },
          { type: 'text', text: 'step 1 finished' },
        ],
        timestamp: 1001,
      },
      { role: 'user', content: 'recent step', timestamp: 2000 },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }], timestamp: 2001 },
    ] as unknown as AgentMessage[];

    const res = foldCompletedStepLogs(messages, { keepRecentTurns: 1 });
    expect(res.foldedCount).toBe(1);
    expect(res.savedBytes).toBeGreaterThan(0);
    expect(res.savedTokens).toBeGreaterThan(0);

    const assistantMsg = res.messages[1] as unknown as Record<string, unknown>;
    const thinkingBlock = (assistantMsg.content as { type: string; thinking: string }[])[0];
    expect(thinkingBlock.thinking).toContain('[Completed step debug logs folded:');
    // 正文不受影响
    expect((assistantMsg.content as { type: string; text?: string }[])[1].text).toBe(
      'step 1 finished',
    );
  });

  it('should keep short thinking, already folded logs and recent steps unchanged', () => {
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'short' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'x'.repeat(600) + '[Completed step debug logs folded: 1]' },
        ],
      },
      { role: 'user', content: 'now' },
    ] as unknown as AgentMessage[];
    const res = foldCompletedStepLogs(messages, { keepRecentTurns: 1 });
    expect(res.foldedCount).toBe(0);
    expect(res.messages[1]).toBe(messages[1]);
    expect(res.messages[2]).toBe(messages[2]);
  });

  it('should ignore non-assistant messages and primitive blocks', () => {
    const messages = [
      { role: 'user', content: [{ type: 'thinking', thinking: 'z'.repeat(900) }] },
      { role: 'assistant', content: [null, 'raw'] },
      { role: 'user', content: 'now' },
    ] as unknown as AgentMessage[];
    expect(foldCompletedStepLogs(messages).foldedCount).toBe(0);
  });
});

describe('pruneContextHierarchically', () => {
  function longConversation(): AgentMessage[] {
    const longLines = Array.from(
      { length: 60 },
      (_, i) => `log line ${i + 1}: ${'x'.repeat(30)}`,
    ).join('\n');
    return [
      { role: 'user', content: 'old prompt' },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: longLines }],
      },
      { role: 'user', content: 'recent 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok 1' }] },
      { role: 'user', content: 'recent 2' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok 2' }] },
    ] as unknown as AgentMessage[];
  }

  it('should stay below the tier-1 watermark without pruning or compaction', () => {
    const messages = longConversation();
    const res = pruneContextHierarchically(messages, {
      contextWindow: 100_000,
      reserveTokens: 10_000,
    });
    expect(res.reachedTier1).toBe(false);
    expect(res.reachedTier2).toBe(false);
    expect(res.tier1.trimmedCount).toBe(0);
    expect(res.tier2.foldedCount).toBe(0);
    expect(res.needsCompaction).toBe(false);
    expect(res.messages).toBe(messages);
    expect(res.tokensAfter).toBe(res.tokensBefore);
  });

  it('should prune at tier 1 and defer full compaction', () => {
    const messages = longConversation();
    const totalTokens = estimateMessagesTotalTokens(messages);
    const res = pruneContextHierarchically(messages, {
      contextWindow: Math.floor(totalTokens * 1.3),
      reserveTokens: 100,
      tier1Watermark: 0.7,
    });
    expect(res.reachedTier1).toBe(true);
    expect(res.tier1.trimmedCount).toBe(1);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    expect(res.needsCompaction).toBe(false);
  });

  it('should require compaction when forced into a tiny window', () => {
    const res = pruneContextHierarchically(longConversation(), {
      contextWindow: 50,
      reserveTokens: 10,
      force: true,
    });
    expect(res.needsCompaction).toBe(true);
    expect(res.reachedTier1).toBe(true);
    expect(res.reachedTier2).toBe(true);
  });

  it('should keep the watermark sane when a large-window reserve leaks into a small window', () => {
    const messages = [
      { role: 'user', content: 'short prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'short answer' }] },
    ] as unknown as AgentMessage[];
    const res = pruneContextHierarchically(messages, {
      contextWindow: 128_000,
      reserveTokens: 744_000,
      softCap: 256_000,
    });
    expect(res.reachedTier1).toBe(false);
    expect(res.needsCompaction).toBe(false);
    expect(res.tier1.trimmedCount).toBe(0);
  });

  it('should clamp invalid window and reserve inputs to their defaults', () => {
    const messages = [{ role: 'user', content: 'x' }] as unknown as AgentMessage[];
    const zeroWindow = pruneContextHierarchically(messages, { contextWindow: 0, reserveTokens: 0 });
    // 默认 128k 窗口 - 默认 16384 reserve → 远大于 1 token，不触发裁剪
    expect(zeroWindow.reachedTier1).toBe(false);
    expect(zeroWindow.needsCompaction).toBe(false);

    const tinyWindow = pruneContextHierarchically(messages, {
      contextWindow: 100,
      reserveTokens: 200,
    });
    // room <= 0 → 物理余量退化为 max(1, 100 - 2048) = 1 → 必然越线
    expect(tinyWindow.needsCompaction).toBe(true);
  });

  it('should prefer the soft cap when it is lower than the physical cap', () => {
    const longLines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'y'.repeat(40)}`).join(
      '\n',
    );
    const messages = [
      { role: 'user', content: 'old' },
      { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: longLines }] },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
    ] as unknown as AgentMessage[];

    const withoutCap = pruneContextHierarchically(messages, {
      contextWindow: 1_000_000,
      reserveTokens: 1000,
    });
    expect(withoutCap.reachedTier1).toBe(false);

    const withCap = pruneContextHierarchically(messages, {
      contextWindow: 1_000_000,
      reserveTokens: 1000,
      softCap: 2000,
    });
    expect(withCap.reachedTier1).toBe(true);
    // 一级裁剪已经把窗口压回软上限以下，因此本轮不需要整段压缩
    expect(withCap.tier1.trimmedCount).toBe(1);
    expect(withCap.tokensAfter).toBeLessThan(withCap.tokensBefore);
    expect(withCap.needsCompaction).toBe(false);
  });

  it('should report tier-2 folding when only the thinking logs are foldable', () => {
    const thinking = 'debug\n'.repeat(200);
    const messages = [
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking }] },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
      { role: 'user', content: 'recent 3' },
    ] as unknown as AgentMessage[];

    const res = pruneContextHierarchically(messages, {
      contextWindow: 400,
      reserveTokens: 100,
      tier1Watermark: 0.9,
      tier2Watermark: 0.5,
    });
    expect(res.tier2.foldedCount).toBe(1);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
  });

  it('should still fold at tier 2 when forced near the cap even if the watermark was not reached', () => {
    const thinking = 'debug\n'.repeat(200);
    const messages = [
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking }] },
      { role: 'user', content: 'recent 1' },
      { role: 'user', content: 'recent 2' },
      { role: 'user', content: 'recent 3' },
    ] as unknown as AgentMessage[];

    const res = pruneContextHierarchically(messages, {
      contextWindow: 500,
      reserveTokens: 100,
      tier1Watermark: 0.99,
      tier2Watermark: 99,
      force: true,
    });
    expect(res.reachedTier2).toBe(true);
    expect(res.tier2.foldedCount).toBe(1);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
  });
});
