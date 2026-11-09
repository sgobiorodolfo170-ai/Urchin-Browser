/**
 * vision-bridge.ts 单元测试
 *
 * 重点回归 D8（类型缺口 → 运行时缺口）：`ModelRuntime.completeSimple()` 在旧 shim 里
 * 返回 `any`，于是 `msg.content.filter((b) => …)` 在 content 不是数组时直接抛
 * `TypeError: msg.content.filter is not a function`——调用方拿到的是一个与业务无关的崩溃，
 * 而不是「视觉模型返回了空的转写结果」这种可诊断错误。
 *
 * 本文件用 fake runtime（不触网、不 mock 模块）锁住三件事：
 * 1. provider 返回漂移形状时不崩，按空转写降级；
 * 2. 正常路径的块筛选与拼接正确（只取 text 块，thinking / toolCall 丢弃）；
 * 3. 发出去的请求形状正确（data URL 前缀已剥离、maxTokens 与 systemPrompt 到位）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  buildVisionBridgePrompt,
  extractAssistantText,
  findVisionModels,
  getVisionSystemPrompt,
  transcribeImages,
} from '../../src/pi-server/vision-bridge.js';

interface CompleteSimpleCall {
  model: unknown;
  context: unknown;
  options: unknown;
}

/**
 * 造一个 fake ModelRuntime。
 *
 * `response` 故意声明为 `unknown`：本文件的用途之一就是模拟 provider 运行期漂移
 * （content 是字符串、块缺字段等），这些形状在类型上非法、在运行期真实存在。
 */
function makeRuntime(response: unknown): {
  runtime: ModelRuntime;
  calls: CompleteSimpleCall[];
} {
  const calls: CompleteSimpleCall[] = [];
  const runtime = {
    getProviders: () => [{ id: 'prov-1' }],
    hasConfiguredAuth: () => true,
    getModels: () => [{ id: 'vision-1', name: 'Vision One', input: ['text', 'image'] }],
    getModel: () => ({ id: 'vision-1', provider: 'prov-1', input: ['text', 'image'] }),
    completeSimple: (model: unknown, context: unknown, options: unknown) => {
      calls.push({ model, context, options });
      return Promise.resolve(response);
    },
  };
  return { runtime: runtime as unknown as ModelRuntime, calls };
}

/** 正常的助手消息：两个 text 块 + 一个应被丢弃的 thinking 块。 */
function assistantMessage(content: unknown): unknown {
  return { role: 'assistant', stopReason: 'stop', content, timestamp: 1 };
}

/**
 * 只会「卡住」的 runtime：completeSimple 一直 pending，直到收到 abort 才 reject。
 *
 * 用来覆盖两条真实中断路径：外部 signal 透传（onOuterAbort）与超时定时器
 * （TRANSCRIBE_TIMEOUT_MS）。真实 provider 收到 abort 也是这个行为。
 */
function makeHangingRuntime(): { runtime: ModelRuntime; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const runtime = {
    getProviders: () => [{ id: 'prov-1' }],
    hasConfiguredAuth: () => true,
    getModels: () => [{ id: 'vision-1', name: 'Vision One', input: ['image'] }],
    getModel: () => ({ id: 'vision-1', provider: 'prov-1' }),
    completeSimple: (_model: unknown, _context: unknown, options: unknown) =>
      new Promise<never>((_resolve, reject) => {
        const signal = (options as { signal?: AbortSignal }).signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        signals.push(signal);
        if (signal.aborted) {
          reject(new Error('aborted before start'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
      }),
  };
  return { runtime: runtime as unknown as ModelRuntime, signals };
}

const ONE_IMAGE = [{ data: 'data:image/png;base64,QUJD', mimeType: 'image/png' }];

describe('transcribeImages', () => {
  it('should join text blocks in order and drop non-text blocks', async () => {
    const { runtime } = makeRuntime(
      assistantMessage([
        { type: 'text', text: '  第一行  ' },
        { type: 'thinking', thinking: '推理内容不应出现' },
        { type: 'text', text: '第二行' },
      ]),
    );

    // 拼接保留块内空格，整体 trim 由 transcribeImages 统一收口。
    await expect(transcribeImages(runtime, ONE_IMAGE)).resolves.toBe('第一行  \n第二行');
  });

  it('should degrade to the empty-transcript error when provider returns a string content', async () => {
    // D8 红用例：修复前这里抛 `TypeError: msg.content.filter is not a function`
    const { runtime } = makeRuntime(assistantMessage('整段文本而不是数组'));

    await expect(transcribeImages(runtime, ONE_IMAGE)).rejects.toThrow(
      /empty transcript|空的转写结果/,
    );
  });

  it('should skip malformed blocks instead of crashing', async () => {
    const { runtime } = makeRuntime(
      assistantMessage([null, 42, { type: 'text' }, { type: 'text', text: 'ok' }]),
    );

    await expect(transcribeImages(runtime, ONE_IMAGE)).resolves.toBe('ok');
  });

  it('should surface the provider error message when stopReason is error', async () => {
    const { runtime } = makeRuntime({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'upstream 429',
      content: [],
    });

    await expect(transcribeImages(runtime, ONE_IMAGE)).rejects.toThrow('upstream 429');
  });

  it('should send images without the data-url prefix and keep the token budget', async () => {
    const { runtime, calls } = makeRuntime(assistantMessage([{ type: 'text', text: 'ok' }]));

    await transcribeImages(runtime, ONE_IMAGE);

    expect(calls).toHaveLength(1);
    const context = calls[0]?.context as {
      systemPrompt?: string;
      messages: { role: string; content: { type: string; data?: string; text?: string }[] }[];
    };
    expect(typeof context.systemPrompt).toBe('string');
    expect(context.systemPrompt?.length).toBeGreaterThan(0);
    const blocks = context.messages[0]?.content ?? [];
    expect(blocks[0]).toMatchObject({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    expect(calls[0]?.options).toMatchObject({ maxTokens: 4000 });
  });

  it('should fail with a clear message when no vision model is configured', async () => {
    const calls: CompleteSimpleCall[] = [];
    const runtime = {
      getProviders: () => [{ id: 'prov-1' }],
      hasConfiguredAuth: () => true,
      getModels: () => [{ id: 'text-only', input: ['text'] }],
      getModel: () => undefined,
      completeSimple: (model: unknown, context: unknown, options: unknown) => {
        calls.push({ model, context, options });
        return Promise.resolve(assistantMessage([]));
      },
    } as unknown as ModelRuntime;

    await expect(transcribeImages(runtime, ONE_IMAGE)).rejects.toThrow(
      /No vision-capable model|未找到可用的视觉模型/,
    );
    expect(calls).toHaveLength(0);
  });

  it('should fail when the runtime lists a vision model but returns none for it', async () => {
    // findVisionModels 命中、但 getModel 返回空（models.json 与运行时状态不一致）。
    const runtime = {
      getProviders: () => [{ id: 'prov-1' }],
      hasConfiguredAuth: () => true,
      getModels: () => [{ id: 'vision-1', name: 'Vision', input: ['image'] }],
      getModel: () => undefined,
      completeSimple: () => Promise.resolve(assistantMessage([])),
    } as unknown as ModelRuntime;

    await expect(transcribeImages(runtime, ONE_IMAGE)).rejects.toThrow(
      /Vision model unavailable|视觉模型不可用/,
    );
  });

  it('should report an abnormal termination when stopReason is aborted', async () => {
    const { runtime } = makeRuntime({ role: 'assistant', stopReason: 'aborted', content: [] });

    await expect(transcribeImages(runtime, ONE_IMAGE)).rejects.toThrow(
      /terminated abnormally|异常终止/,
    );
  });

  it('should default an unknown mime type to png and keep multiple images in order', async () => {
    const { runtime, calls } = makeRuntime(assistantMessage([{ type: 'text', text: 'ok' }]));

    await transcribeImages(runtime, [
      { data: 'QUJD', mimeType: 'application/octet-stream' },
      { data: 'REVG', mimeType: 'image/jpeg' },
    ]);

    const context = calls[0]?.context as {
      messages: { content: { type: string; data?: string; mimeType?: string; text?: string }[] }[];
    };
    const blocks = context.messages[0]?.content ?? [];
    expect(blocks.slice(0, 2)).toEqual([
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      { type: 'image', data: 'REVG', mimeType: 'image/jpeg' },
    ]);
    // 多图时用户提示切到「按顺序逐张」的批次文案。
    expect(blocks[2]?.text).toContain('Image 1 to Image 2');
  });

  it('should honour a caller supplied system prompt and language', async () => {
    const { runtime, calls } = makeRuntime(assistantMessage([{ type: 'text', text: 'ok' }]));

    await transcribeImages(runtime, ONE_IMAGE, { systemPrompt: '自定义系统提示', lang: 'zh' });

    const context = calls[0]?.context as {
      systemPrompt?: string;
      messages: { content: { text?: string }[] }[];
    };
    expect(context.systemPrompt).toBe('自定义系统提示');
    expect(context.messages[0]?.content.at(-1)?.text).toContain('请逐字转写');
  });

  it('should forward an outer abort to the provider call', async () => {
    const { runtime, signals } = makeHangingRuntime();
    const controller = new AbortController();

    const attempt = transcribeImages(runtime, ONE_IMAGE, { signal: controller.signal });
    const rejection = expect(attempt).rejects.toThrow('aborted by signal');
    controller.abort();
    await rejection;

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('should abort the request when the transcription timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, signals } = makeHangingRuntime();
      const attempt = transcribeImages(runtime, ONE_IMAGE);
      const rejection = expect(attempt).rejects.toThrow('aborted by signal');
      // 默认 90s，这里推进足够长的一段时间，避免与 PI_WEB_VISION_TIMEOUT_MS 耦合。
      await vi.advanceTimersByTimeAsync(10_000_000);
      await rejection;
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('findVisionModels', () => {
  it('should only list image models of providers with configured auth', () => {
    const runtime = {
      getProviders: () => [{ id: 'ok' }, { id: 'no-auth' }],
      hasConfiguredAuth: (id: string) => id === 'ok',
      getModels: (id: string) =>
        id === 'ok'
          ? [
              { id: 'vision', name: 'Vision', input: ['text', 'image'] },
              { id: 'text-only', name: 'Text only', input: ['text'] },
              { id: 'no-input', name: 'No input' },
            ]
          : [{ id: 'hidden', name: 'Hidden', input: ['image'] }],
    } as unknown as ModelRuntime;

    expect(findVisionModels(runtime)).toEqual([
      { provider: 'ok', id: 'vision', label: 'Vision (ok)' },
    ]);
  });

  it('should fall back to the model id when the display name is missing', () => {
    const runtime = {
      getProviders: () => [{ id: 'p' }],
      hasConfiguredAuth: () => true,
      getModels: () => [{ id: 'img-only', input: ['image'] }],
    } as unknown as ModelRuntime;

    expect(findVisionModels(runtime)).toEqual([
      { provider: 'p', id: 'img-only', label: 'img-only (p)' },
    ]);
  });
});

describe('extractAssistantText', () => {
  it('should return an empty string for non-array content', () => {
    // D8 的形状：provider 把整段文本直接塞进 content，而不是块数组。
    expect(extractAssistantText('整段文本')).toBe('');
    expect(extractAssistantText(undefined)).toBe('');
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText({ type: 'text', text: 'x' })).toBe('');
  });

  it('should skip malformed blocks and keep only string text blocks', () => {
    expect(
      extractAssistantText([
        null,
        42,
        'text',
        [],
        { type: 'text' },
        { type: 'text', text: 123 },
        { type: 'thinking', text: '不应出现' },
        { type: 'toolCall', name: 'read' },
        { type: 'text', text: 'ok' },
      ]),
    ).toBe('ok');
  });

  it('should join blocks in order with newlines and preserve inner spacing', () => {
    expect(
      extractAssistantText([
        { type: 'text', text: '  第一行  ' },
        { type: 'text', text: '第二行' },
      ]),
    ).toBe('  第一行  \n第二行');
  });
});

describe('vision prompts', () => {
  it('should expose a non-empty default system prompt per language', () => {
    expect(getVisionSystemPrompt('en')).toContain('vision bridge');
    expect(getVisionSystemPrompt('zh')).toContain('视觉桥');
  });

  it('should replace the base prompt when mode is replace', () => {
    expect(buildVisionBridgePrompt('replace', '  自定义提示  ', 'en')).toBe('自定义提示');
  });

  it('should append the custom prompt when mode is append', () => {
    const merged = buildVisionBridgePrompt('append', '额外要求', 'en');
    expect(merged).toContain(getVisionSystemPrompt('en'));
    expect(merged.endsWith('额外要求')).toBe(true);
  });

  it('should fall back to the base prompt when custom text is blank', () => {
    expect(buildVisionBridgePrompt('append', '   ', 'en')).toBe(getVisionSystemPrompt('en'));
    expect(buildVisionBridgePrompt('replace', '', 'en')).toBe(getVisionSystemPrompt('en'));
  });
});
