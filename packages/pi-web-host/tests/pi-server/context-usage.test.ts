/**
 * context-usage.ts 单元测试
 *
 * 覆盖 base 上下文（提示词 + 工具 schema）估算、按类别拆分权重（含流式消息
 * 与 WeakMap 缓存）、以及类别归一到权威总用量。
 *
 * 为何要「先按类别估算、再归一到权威总量」：估算只用于解释构成，真实用量来自
 * SDK usage；两者不一致时必须以权威值为准，差额记入 Other，否则 UI 各项相加
 * 会大于或小于显示的总数。
 *
 * 说明：`estimateTokens` 来自 vendored `@earendil-works/pi-coding-agent`，
 * 本仓未安装该包（esbuild 别名打包），此处用同语义的字符数估算桩替代。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  estimateTokens: (message: { content?: unknown; summary?: unknown }) => {
    let chars = 0;
    const content = message?.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') chars += b.text.length;
        if (typeof b.thinking === 'string') chars += b.thinking.length;
        if (b.type === 'toolCall') {
          const name = typeof b.name === 'string' ? b.name : '';
          chars += name.length + JSON.stringify(b.arguments ?? {}).length;
        }
        if (b.type === 'image') chars += 4000;
      }
    }
    if (typeof message?.summary === 'string') chars += message.summary.length;
    return Math.ceil(chars / 4);
  },
}));

import {
  estimateBaseContext,
  estimateContextWeights,
  reconcileContextCategories,
  type ContextWeights,
} from '../../src/pi-server/context-usage.js';
import { estimatePromptTokens, renderPromptTemplate } from '../../src/pi-server/prompt-composer.js';
import type { AgentMessage } from '../../src/pi-server/serialize.js';

const empty: ContextWeights = {
  systemPrompt: 0,
  memoryFiles: 0,
  tools: 0,
  skills: 0,
  toolResults: 0,
  messages: 0,
  other: 0,
};

function base(
  options: {
    promptTemplate?: string;
    promptOverrides?: Record<string, string>;
    promptDisabled?: string[];
  } = {},
) {
  const texts = {
    soul: 'System instructions.',
    context: 'Project memory.',
    skills: 'Skills catalog.',
    tools: 'Tools catalog.',
  };
  const full = renderPromptTemplate(
    options.promptTemplate ?? '',
    texts,
    options.promptOverrides,
    options.promptDisabled,
  );
  return {
    result: estimateBaseContext({ full, texts, toolsSchema: 'Tool schemas.' }, options),
    full,
  };
}

function totalWeights(weights: ContextWeights): number {
  return Object.values(weights).reduce((sum, tokens) => sum + tokens, 0);
}

describe('context usage categories', () => {
  it('should keep the prompt + schema baseline and separate the prompt sources', () => {
    const { result, full } = base();
    expect(result.tokens).toBe(estimatePromptTokens(full) + estimatePromptTokens('Tool schemas.'));
    expect(result.weights.memoryFiles).toBe(estimatePromptTokens('Project memory.'));
    expect(result.weights.skills).toBe(estimatePromptTokens('Skills catalog.'));
    expect(result.weights.tools).toBe(
      estimatePromptTokens('Tools catalog.') + estimatePromptTokens('Tool schemas.'),
    );
    expect(Object.values(result.weights).reduce((n, value) => n + value, 0)).toBeCloseTo(
      result.tokens,
    );
  });

  it('should respect overridden, omitted, disabled and repeated prompt sections', () => {
    const { result } = base({
      promptTemplate: 'Custom instructions {{context}} {{context}} {{skills}}',
      promptOverrides: { context: 'Replacement memory' },
      promptDisabled: ['skills'],
    });
    expect(result.weights.memoryFiles).toBe(2 * estimatePromptTokens('Replacement memory'));
    expect(result.weights.skills).toBe(0);
    expect(result.weights.tools).toBe(estimatePromptTokens('Tool schemas.'));
    expect(result.weights.systemPrompt).toBeGreaterThan(0);
  });

  it('should scale sections down when the template repeats them beyond the rendered prompt', () => {
    const texts = { context: 'x'.repeat(4000), skills: '', tools: '' };
    const template = 'short {{context}}';
    const full = renderPromptTemplate(template, texts, undefined, undefined);
    const { weights, tokens } = estimateBaseContext(
      { full, texts, toolsSchema: '' },
      { promptTemplate: template },
    );
    expect(weights.memoryFiles).toBeLessThanOrEqual(estimatePromptTokens(texts.context));
    expect(weights.systemPrompt).toBeGreaterThanOrEqual(0);
    expect(tokens).toBe(estimatePromptTokens(full));
  });

  it('should scale section weights down to the rendered prompt when the snapshot text is longer', () => {
    // 快照 full 用一个很短的覆盖值渲染，但 texts.context 仍有 4000 字符：
    // 说明"按来源估算"的总和超过了真实提示词，必须等比缩放后再算系统提示词。
    const texts = { context: 'y'.repeat(4000) };
    const { weights, tokens } = estimateBaseContext(
      { full: 'x', texts, toolsSchema: '' },
      { promptTemplate: '{{context}}' },
    );
    expect(tokens).toBe(estimatePromptTokens('x'));
    expect(weights.memoryFiles).toBeCloseTo(estimatePromptTokens('x'));
    expect(weights.systemPrompt).toBe(0);
  });

  it('should treat an absent section text as empty when there is no override', () => {
    const { weights, tokens } = estimateBaseContext(
      { full: 'prompt only', texts: {}, toolsSchema: '' },
      { promptTemplate: '{{context}}{{skills}}{{tools}}' },
    );
    expect(tokens).toBe(estimatePromptTokens('prompt only'));
    expect(weights.memoryFiles).toBe(0);
    expect(weights.skills).toBe(0);
    expect(weights.tools).toBe(0);
    expect(weights.systemPrompt).toBe(tokens);
  });

  it('should separate tool arguments/results, skill bodies, messages and compaction summaries', () => {
    const messages = [
      { role: 'system', content: 'Already counted in the baseline' },
      { role: 'user', content: 'Hello world' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Inspecting the file' },
          { type: 'toolCall', id: '1', name: 'read', arguments: { path: 'README.md' } },
        ],
      },
      { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'File contents' }] },
      {
        role: 'toolResult',
        toolName: 'skill',
        content: [{ type: 'text', text: 'Skill instructions' }],
      },
      { role: 'compactionSummary', summary: 'Previous context' },
    ] as unknown as AgentMessage[];

    const weights = estimateContextWeights(empty, messages);
    expect(weights.systemPrompt).toBe(0);
    expect(weights.messages).toBeGreaterThan(0);
    expect(weights.toolResults).toBeGreaterThan(0);
    expect(weights.skills).toBeGreaterThan(0);
    expect(weights.other).toBeGreaterThan(0);

    const compacted = estimateContextWeights(empty, [messages[5]]);
    expect(compacted.toolResults).toBe(0);
    expect(compacted.skills).toBe(0);
    expect(compacted.other).toBeGreaterThan(0);
  });

  it('should count bashExecution output as tool results', () => {
    const weights = estimateContextWeights(empty, [
      { role: 'bashExecution', content: 'run', output: 'x'.repeat(400) },
    ]);
    expect(weights.toolResults).toBeGreaterThan(0);
    expect(weights.messages).toBe(0);
  });

  it('should count streaming content once and never mutate its source messages', () => {
    const streaming = { role: 'assistant', content: [{ type: 'text', text: 'Streaming answer' }] };
    const original = JSON.stringify(streaming);
    expect(estimateContextWeights(empty, [], streaming)).toEqual(
      estimateContextWeights(empty, [streaming], streaming),
    );
    expect(JSON.stringify(streaming)).toBe(original);
  });

  it('should ignore non-object entries', () => {
    expect(estimateContextWeights(empty, [null, 'raw', 3, undefined])).toEqual(empty);
  });

  it('should reuse settled-message estimates and re-estimate growing streaming content', () => {
    const cache = new WeakMap<object, ContextWeights>();
    const settled = { role: 'user', content: 'Settled message' };
    const streaming = { role: 'assistant', content: [{ type: 'text', text: 'Now' }] };
    const before = estimateContextWeights(empty, [settled, streaming], streaming, cache);
    expect(cache.has(settled)).toBe(true);
    expect(cache.has(streaming)).toBe(false);
    streaming.content[0].text = 'A much longer streaming answer that is still being generated';
    const after = estimateContextWeights(empty, [settled, streaming], streaming, cache);
    expect(after.messages).toBeGreaterThan(before.messages);
    expect(estimateContextWeights(empty, [], undefined, cache).messages).toBe(0);
  });

  it('should refresh the final message after an extension replaces it in place', async () => {
    const cache = new WeakMap<object, ContextWeights>();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'first', name: 'read', arguments: {} }],
      },
      {
        role: 'toolResult',
        toolName: 'read',
        toolCallId: 'first',
        content: [{ type: 'text', text: 'original' }],
      },
    ] as unknown as AgentMessage[];
    const final = messages[1];
    const before = estimateContextWeights(empty, messages, undefined, cache);
    await Promise.resolve();
    Object.assign(final, {
      content: [{ type: 'text', text: 'replacement tool result\n'.repeat(1000) }],
    });
    const after = estimateContextWeights(empty, messages, undefined, cache);
    expect(messages[1]).toBe(final);
    expect(after.toolResults).toBeGreaterThan(before.toolResults);
    expect(after).toEqual(estimateContextWeights(empty, messages));
    messages.push({ role: 'user', content: 'Continue', timestamp: 1 } as unknown as AgentMessage);
    expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(
      estimateContextWeights(empty, messages),
    );
  });

  it('should reuse stable prefix estimates without rereading large content', () => {
    const cache = new WeakMap<object, ContextWeights>();
    const content = vi.fn(() => 'Stable prefix\n'.repeat(10000));
    const prefix = {
      role: 'user',
      get content() {
        return content();
      },
    };
    const last = { role: 'user', content: 'Last message' };
    const messages = [prefix, last];
    const before = estimateContextWeights(empty, messages, undefined, cache);
    const reads = content.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(cache.has(prefix)).toBe(true);
    for (let count = 0; count < 20; count++) {
      expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(before);
    }
    expect(content).toHaveBeenCalledTimes(reads);
  });

  it('should evict a previously cached prefix once it becomes the final message', async () => {
    const cache = new WeakMap<object, ContextWeights>();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'first', name: 'read', arguments: {} }],
      },
      {
        role: 'toolResult',
        toolName: 'read',
        toolCallId: 'first',
        content: [{ type: 'text', text: 'original' }],
      },
      { role: 'user', content: 'Continue', timestamp: 1 },
    ] as unknown as AgentMessage[];
    estimateContextWeights(empty, messages, undefined, cache);
    const final = messages[1];
    expect(cache.has(final)).toBe(true);
    messages.pop();
    estimateContextWeights(empty, messages, undefined, cache);
    await Promise.resolve();
    Object.assign(final, { content: [{ type: 'text', text: 'changed\n'.repeat(1000) }] });
    messages.push({
      role: 'user',
      content: 'Continue again',
      timestamp: 2,
    } as unknown as AgentMessage);
    expect(estimateContextWeights(empty, messages, undefined, cache)).toEqual(
      estimateContextWeights(empty, messages),
    );
  });

  it('should keep the base weights untouched while accumulating message weights', () => {
    const baseWeights = { ...empty, systemPrompt: 7, tools: 3 };
    const weights = estimateContextWeights(baseWeights, [{ role: 'user', content: 'abcd' }]);
    expect(weights.systemPrompt).toBe(7);
    expect(weights.tools).toBe(3);
    expect(weights.messages).toBe(1);
    expect(totalWeights(weights)).toBe(11);
  });
});

describe('reconcileContextCategories', () => {
  it.each([0, 1, 17, 99, 100, 251, 1000])(
    'should reconcile categories to the authoritative total %i without negative values',
    (total) => {
      const weights = {
        ...empty,
        systemPrompt: 71.25,
        memoryFiles: 13.5,
        tools: 12.75,
        messages: 99.5,
      };
      const rows = reconcileContextCategories(weights, total);
      expect(rows.reduce((n, row) => n + row.tokens, 0)).toBe(total);
      expect(rows.every((row) => Number.isInteger(row.tokens) && row.tokens > 0)).toBe(true);
    },
  );

  it('should put unexplained usage in Other without inflating the known categories', () => {
    const rows = reconcileContextCategories({ ...empty, systemPrompt: 40, tools: 10 }, 100);
    expect(rows).toEqual([
      { category: 'systemPrompt', tokens: 40 },
      { category: 'tools', tokens: 10 },
      { category: 'other', tokens: 50 },
    ]);
  });

  it('should scale everything down proportionally when estimates exceed the authoritative total', () => {
    const rows = reconcileContextCategories({ ...empty, systemPrompt: 100, tools: 100 }, 100);
    expect(rows.reduce((n, row) => n + row.tokens, 0)).toBe(100);
    expect(rows.find((row) => row.category === 'systemPrompt')?.tokens).toBe(50);
    expect(rows.find((row) => row.category === 'tools')?.tokens).toBe(50);
  });

  it('should coerce non-finite and negative inputs to zero', () => {
    const rows = reconcileContextCategories(
      {
        ...empty,
        systemPrompt: Number.NaN,
        tools: -5,
        messages: Number.POSITIVE_INFINITY,
      },
      0,
    );
    expect(rows).toEqual([]);
    expect(reconcileContextCategories(empty, Number.NaN)).toEqual([]);
  });
});
