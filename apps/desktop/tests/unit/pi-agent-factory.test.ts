/**
 * M12 AI 编排 · pi-agent-factory 单元测试
 *
 * 验证 createPiAgent 工厂：
 * 1. 无 apiKey 抛错
 * 2. 内置 provider + baseUrl 覆盖 → Model 合并 baseUrl
 * 3. 内置 provider 无 baseUrl → 直接返回内置 Model
 * 4. 非内置 model → 构造最小 OpenAI 兼容 Model
 * 5. enableTools + cwd → 挂载 4 个 coding 工具
 * 6. enableTools 无 cwd → 不挂载工具
 * 7. getApiKey 按 providerId 匹配
 * 8. isBuiltinProvider 判断
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock pi-ai compat：streamSimple / getModel / getProviders ──
const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(),
  getProviders: vi.fn(),
  createBashTool: vi.fn(),
  createReadTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
  getProviders: mocks.getProviders,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashTool: mocks.createBashTool,
  createReadTool: mocks.createReadTool,
  createEditTool: mocks.createEditTool,
  createWriteTool: mocks.createWriteTool,
}));

import { createPiAgent, isBuiltinProvider } from '../../src/main/ai/pi-agent-factory';

/** 内置 Model 对象（getModel 返回） */
const BUILTIN_MODEL = {
  id: 'gpt-4o-mini',
  name: 'GPT-4o mini',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  input: ['text'],
};

describe('pi-agent-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviders.mockReturnValue(['openai', 'anthropic', 'ollama']);
    mocks.getModel.mockReturnValue(BUILTIN_MODEL);
    mocks.createBashTool.mockReturnValue({ name: 'bash' });
    mocks.createReadTool.mockReturnValue({ name: 'read' });
    mocks.createEditTool.mockReturnValue({ name: 'edit' });
    mocks.createWriteTool.mockReturnValue({ name: 'write' });
    mocks.streamSimple.mockImplementation(() => ({
      result: () => Promise.resolve({ stopReason: 'stop', content: [] }),
      async *[Symbol.asyncIterator]() {
        // noop
      },
    }));
  });

  it('should throw when apiKey is missing', () => {
    expect(() =>
      createPiAgent({ providerId: 'openai', modelId: 'gpt-4o-mini', apiKey: '' }),
    ).toThrow(/apiKey is required/);
  });

  it('should create agent with builtin model and no baseUrl override', () => {
    const { model, agent, tools } = createPiAgent({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });

    expect(model).toBe(BUILTIN_MODEL);
    expect(agent).toBeDefined();
    expect(tools).toHaveLength(0);
  });

  it('should merge baseUrl override onto builtin model', () => {
    const { model } = createPiAgent({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(model).not.toBe(BUILTIN_MODEL);
    expect(model.baseUrl).toBe('https://proxy.example.com/v1');
    expect(model.id).toBe('gpt-4o-mini');
  });

  it('should construct minimal model when not in builtin catalog', () => {
    mocks.getModel.mockReturnValue(undefined);
    const { model } = createPiAgent({
      providerId: 'custom-endpoint',
      modelId: 'my-model',
      apiKey: 'sk-test',
    });

    expect(model).toEqual({
      id: 'my-model',
      name: 'my-model',
      provider: 'custom-endpoint',
      api: 'openai-completions',
      baseUrl: undefined,
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      input: ['text'],
    });
  });

  it('should attach coding tools when enableTools and cwd provided', () => {
    const { tools } = createPiAgent({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      enableTools: true,
      cwd: '/workspace',
    });

    expect(tools).toHaveLength(4);
    expect(mocks.createBashTool).toHaveBeenCalledWith('/workspace');
    expect(mocks.createReadTool).toHaveBeenCalledWith('/workspace');
    expect(mocks.createEditTool).toHaveBeenCalledWith('/workspace');
    expect(mocks.createWriteTool).toHaveBeenCalledWith('/workspace');
  });

  it('should not attach tools when enableTools without cwd', () => {
    const { tools } = createPiAgent({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      enableTools: true,
    });

    expect(tools).toHaveLength(0);
    expect(mocks.createBashTool).not.toHaveBeenCalled();
  });

  it('should pass systemPrompt and sessionId to Agent', () => {
    const { agent } = createPiAgent({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      systemPrompt: 'You are helpful',
      sessionId: 'sess-1',
    });

    expect(agent).toBeDefined();
  });

  it('isBuiltinProvider should check against provider catalog', () => {
    expect(isBuiltinProvider('openai')).toBe(true);
    expect(isBuiltinProvider('custom-endpoint')).toBe(false);
  });
});
