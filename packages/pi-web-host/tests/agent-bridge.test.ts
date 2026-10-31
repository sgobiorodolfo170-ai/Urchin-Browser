/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/only-throw-error, @typescript-eslint/no-empty-function -- 测试 vendored pi 边界纯函数：返回类型 Model 为 any（ambient shim），mock streamSimple 用空 async generator 模拟空流 */
/**
 * agent-bridge.ts 单元测试
 *
 * 仅覆盖纯函数：normalizeProviderId / resolveModel / extractDeltaForTest /
 * extractAgentEndMeta / getProviderList / createLlmProvider。
 * vendored pi 模块（@earendil-works/*）经 esbuild 别名打包，vitest 无法直接解析，
 * 故用 vi.mock 替换为可控桩；createAgentBridge 需 mock pi SDK，留待 P3。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getModelMock, getProvidersMock, streamSimpleMock } = vi.hoisted(() => ({
  getModelMock: vi.fn<(providerId: string, modelId: string) => any>(),
  getProvidersMock: vi.fn<() => any>(() => []),
  streamSimpleMock: vi.fn<(...args: any[]) => any>(),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: streamSimpleMock,
  getModel: getModelMock,
  getProviders: getProvidersMock,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashTool: vi.fn(),
  createReadTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
}));

import {
  normalizeProviderId,
  resolveModel,
  extractDeltaForTest,
  extractAgentEndMeta,
  createLlmProvider,
  getProviderList,
} from '../src/agent-bridge';

describe('normalizeProviderId', () => {
  it('should map azure-openai-responses to azure', () => {
    expect(normalizeProviderId('azure-openai-responses')).toBe('azure');
  });

  it('should return original id for unknown providers', () => {
    expect(normalizeProviderId('openai')).toBe('openai');
    expect(normalizeProviderId('anthropic')).toBe('anthropic');
    expect(normalizeProviderId('custom-xyz')).toBe('custom-xyz');
  });

  it('should be idempotent for already-normalized azure', () => {
    expect(normalizeProviderId('azure')).toBe('azure');
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    getModelMock.mockReset();
  });

  it('should return builtin model when available', () => {
    getModelMock.mockReturnValue({ id: 'gpt-4', name: 'GPT-4', provider: 'openai' });
    const model = resolveModel('openai', 'gpt-4');
    expect(model.id).toBe('gpt-4');
    expect(model.name).toBe('GPT-4');
    expect(getModelMock).toHaveBeenCalledWith('openai', 'gpt-4');
  });

  it('should return builtin as-is when no baseUrl', () => {
    const builtin = { id: 'claude-3', name: 'Claude 3', provider: 'anthropic' };
    getModelMock.mockReturnValue(builtin);
    const model = resolveModel('anthropic', 'claude-3');
    expect(model).toBe(builtin);
  });

  it('should apply trimmed baseUrl override to builtin model', () => {
    getModelMock.mockReturnValue({ id: 'gpt-4', name: 'GPT-4', provider: 'openai' });
    const model = resolveModel('openai', 'gpt-4', '  https://custom.api/v1  ');
    expect(model.baseUrl).toBe('https://custom.api/v1');
  });

  it('should not add baseUrl when override is whitespace-only', () => {
    getModelMock.mockReturnValue({ id: 'gpt-4', name: 'GPT-4', provider: 'openai' });
    const model = resolveModel('openai', 'gpt-4', '   ');
    expect(model.baseUrl).toBeUndefined();
  });

  it('should construct minimal OpenAI-compatible fallback when builtin missing', () => {
    getModelMock.mockReturnValue(null);
    const model = resolveModel('custom', 'my-model') as Record<string, unknown>;
    expect(model.id).toBe('my-model');
    expect(model.name).toBe('my-model');
    expect(model.provider).toBe('custom');
    expect(model.api).toBe('openai-completions');
    expect(model.reasoning).toBe(false);
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16_384);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.input).toEqual(['text']);
  });

  it('should use baseUrl in fallback model when provided', () => {
    getModelMock.mockReturnValue(null);
    const model = resolveModel('custom', 'my-model', 'https://api.example.com');
    expect(model.baseUrl).toBe('https://api.example.com');
  });

  it('should leave baseUrl undefined in fallback when not provided', () => {
    getModelMock.mockReturnValue(null);
    const model = resolveModel('custom', 'my-model');
    expect(model.baseUrl).toBeUndefined();
  });

  it('should normalize provider id before calling getModel', () => {
    getModelMock.mockReturnValue(null);
    resolveModel('azure-openai-responses', 'gpt-4');
    expect(getModelMock).toHaveBeenCalledWith('azure', 'gpt-4');
  });
});

describe('extractDeltaForTest', () => {
  it('should return delta for text_delta event', () => {
    expect(extractDeltaForTest({ type: 'text_delta', delta: 'hello' })).toBe('hello');
  });

  it('should return empty string when delta is missing', () => {
    expect(extractDeltaForTest({ type: 'text_delta' })).toBe('');
  });

  it('should return empty string when delta is null', () => {
    expect(extractDeltaForTest({ type: 'text_delta', delta: null })).toBe('');
  });

  it('should return empty string for non-text_delta events', () => {
    expect(extractDeltaForTest({ type: 'tool_call', delta: 'hello' })).toBe('');
    expect(extractDeltaForTest({ type: 'message_start' })).toBe('');
  });
});

describe('extractAgentEndMeta', () => {
  it('should extract usage from last assistant message', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', usage: { input: 10, output: 20 } },
      ],
    });
    expect(meta.finishReason).toBe('stop');
    expect(meta.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('should default usage tokens to 0 when input/output missing', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', usage: {} }],
    });
    expect(meta.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('should only use input/output, not totalTokens', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', usage: { input: 5, output: 7, totalTokens: 99 } }],
    });
    expect(meta.usage).toEqual({ promptTokens: 5, completionTokens: 7 });
  });

  it('should return undefined usage when assistant has no usage field', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: 'hi' }],
    });
    expect(meta.finishReason).toBe('stop');
    expect(meta.usage).toBeUndefined();
  });

  it('should return undefined usage when no assistant message exists', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(meta.finishReason).toBe('stop');
    expect(meta.usage).toBeUndefined();
  });

  it('should return undefined usage for empty messages', () => {
    const meta = extractAgentEndMeta({ type: 'agent_end', messages: [] });
    expect(meta.finishReason).toBe('stop');
    expect(meta.usage).toBeUndefined();
  });

  it('should pick the last assistant when multiple assistants exist', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [
        { role: 'assistant', usage: { input: 1, output: 2 } },
        { role: 'user', content: 'again' },
        { role: 'assistant', usage: { input: 3, output: 4 } },
      ],
    });
    expect(meta.usage).toEqual({ promptTokens: 3, completionTokens: 4 });
  });

  it('should detect error finishReason when stopReason is error', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'something went wrong' }],
    });
    expect(meta.finishReason).toBe('error');
    expect(meta.errorMessage).toBe('something went wrong');
  });

  it('should include usage alongside error', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'boom',
          usage: { input: 8, output: 9 },
        },
      ],
    });
    expect(meta.finishReason).toBe('error');
    expect(meta.errorMessage).toBe('boom');
    expect(meta.usage).toEqual({ promptTokens: 8, completionTokens: 9 });
  });

  it('should not treat as error when stopReason is not error', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop', errorMessage: 'ignored' }],
    });
    expect(meta.finishReason).toBe('stop');
    expect(meta.errorMessage).toBeUndefined();
  });

  it('should not treat as error when errorMessage present but stopReason missing', () => {
    const meta = extractAgentEndMeta({
      type: 'agent_end',
      messages: [{ role: 'assistant', errorMessage: 'no stop reason' }],
    });
    expect(meta.finishReason).toBe('stop');
    expect(meta.errorMessage).toBeUndefined();
  });
});

describe('getProviderList', () => {
  beforeEach(() => {
    getProvidersMock.mockReset();
  });

  it('should return providers from pi getProviders', () => {
    getProvidersMock.mockReturnValue(['openai', 'anthropic', 'google']);
    expect(getProviderList()).toEqual(['openai', 'anthropic', 'google']);
  });

  it('should return empty array when getProviders returns empty', () => {
    getProvidersMock.mockReturnValue([]);
    expect(getProviderList()).toEqual([]);
  });
});

describe('createLlmProvider', () => {
  beforeEach(() => {
    getModelMock.mockReset();
    streamSimpleMock.mockReset();
  });

  it('should return ok with concatenated text deltas on success', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    streamSimpleMock.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: 'Hello' };
      yield { type: 'text_delta', delta: ' World' };
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Hello World');
  });

  it('should skip non-object chunks', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    streamSimpleMock.mockImplementation(async function* () {
      yield null;
      yield 'string chunk';
      yield { type: 'text_delta', delta: 'ok' };
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok');
  });

  it('should skip non-text_delta chunks', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    streamSimpleMock.mockImplementation(async function* () {
      yield { type: 'tool_call', delta: 'ignored' };
      yield { type: 'text_delta', delta: 'kept' };
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.text).toBe('kept');
  });

  it('should return error when streamSimple throws', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    streamSimpleMock.mockImplementation(() => {
      throw new Error('network failure');
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network failure');
    expect(result.text).toBeUndefined();
  });

  it('should return error string for non-Error throwables', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    streamSimpleMock.mockImplementation(() => {
      throw 'string error';
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('should prepend system message when provided', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    const captured: { messages: unknown[] }[] = [];
    streamSimpleMock.mockImplementation((_model, context) => {
      captured.push(context);
      return (async function* () {})();
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    await provider({ prompt: 'hi', system: 'you are helpful' });
    expect(captured[0].messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(captured[0].messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('should omit system message when not provided', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    const captured: { messages: unknown[] }[] = [];
    streamSimpleMock.mockImplementation((_model, context) => {
      captured.push(context);
      return (async function* () {})();
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    await provider({ prompt: 'hi' });
    expect(captured[0].messages).toHaveLength(1);
    expect(captured[0].messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('should truncate output text to 8000 chars', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'openai' });
    const longText = 'x'.repeat(10000);
    streamSimpleMock.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: longText };
    });
    const provider = createLlmProvider({ apiKey: 'k', providerId: 'openai', modelId: 'm' });
    const result = await provider({ prompt: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.text!.length).toBe(8000);
  });

  it('should normalize provider id before resolving model', async () => {
    getModelMock.mockReturnValue({ id: 'm', provider: 'azure' });
    streamSimpleMock.mockImplementation(async function* () {});
    const provider = createLlmProvider({
      apiKey: 'k',
      providerId: 'azure-openai-responses',
      modelId: 'm',
    });
    await provider({ prompt: 'hi' });
    expect(getModelMock).toHaveBeenCalledWith('azure', 'm');
  });
});
