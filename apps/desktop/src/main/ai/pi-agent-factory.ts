/**
 * pi Agent 工厂 · 方案 A 适配层核心
 *
 * 职责：
 * 1. 将 Urchin 的 provider 配置（apiKey / model / baseUrl）注入 pi 的 Agent 实例
 * 2. 提供 streamFn：包装 pi-ai 的 streamSimple，注入 apiKey 与 baseUrl
 * 3. 提供 getApiKey：从 Urchin 设置读取密钥
 * 4. 解析 Model：优先从 pi 内置目录获取，缺失时构造 OpenAI 兼容最小模型
 * 5. 可选挂载 coding 工具（bash/read/edit/write）
 *
 * 设计依据：
 * - 契约 E §6（AI 编排）+ ADR-008 v0.1 范围
 * - 方案 A：直接 import coding-agent/tools，pi-tui 仅作依赖不调用渲染函数
 * - Urchin 的 providerId 对应 pi 内置 provider 名（如 'openai' / 'anthropic'）
 */
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple, getModel, getProviders } from '@earendil-works/pi-ai/compat';
import {
  createBashTool,
  createReadTool,
  createEditTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '@urchin/logger';

const log = createLogger('pi-agent-factory');

/**
 * 已知的 OpenAI 兼容 api 类型。
 *
 * 必须为 'openai-completions'（pi-ai 注册的 API id），而非 'openai'。
 * pi-ai 的 BUILTIN_APIS 注册表使用 'openai-completions' / 'openai-responses' 等，
 * 不存在 'openai' 这个 API id。若使用 'openai'，streamSimple 调用
 * resolveApiProvider('openai') 会抛 "No API provider registered for api: openai"。
 */
const OPENAI_COMPATIBLE_API = 'openai-completions';

/** 工厂创建选项 */
export interface CreatePiAgentOptions {
  /** Urchin Provider ID（对应 pi 内置 provider 名，如 'openai' / 'anthropic'） */
  readonly providerId: string;
  /** 模型 ID（如 'gpt-4o-mini' / 'claude-opus-4-5'） */
  readonly modelId: string;
  /** API Key（从 Urchin 设置读取） */
  readonly apiKey: string;
  /** 可选 Base URL（OpenAI 兼容端点覆盖） */
  readonly baseUrl?: string;
  /** 可选工作目录（启用工具时使用） */
  readonly cwd?: string;
  /** 是否启用 coding 工具（bash/read/edit/write） */
  readonly enableTools?: boolean;
  /** 可选系统提示词 */
  readonly systemPrompt?: string;
  /** 可选会话 ID（用于 provider 缓存） */
  readonly sessionId?: string;
}

/** 工厂创建结果 */
export interface PiAgentHandle {
  /** pi Agent 实例 */
  readonly agent: Agent;
  /** 解析出的 Model 对象 */
  readonly model: Model;
  /** 已挂载的工具列表（可能为空） */
  readonly tools: readonly AgentTool[];
}

/** 内置 provider 集合（懒加载缓存） */
let builtinProviderSet: ReadonlySet<string> | undefined;

function getBuiltinProviderSet(): ReadonlySet<string> {
  builtinProviderSet ??= new Set(getProviders());
  return builtinProviderSet;
}

/**
 * 解析 Model 对象。
 *
 * 优先从 pi 内置目录获取（含完整的 contextWindow / cost / api 等元信息）。
 * 若内置目录未命中（如自定义 OpenAI 兼容端点），构造最小 Model 对象，
 * api 类型设为 'openai' 以走 OpenAI 兼容 stream 路径。
 */
function resolveModel(providerId: string, modelId: string, baseUrl?: string): Model {
  const builtin = getModel(providerId, modelId);
  const trimmedBaseUrl = baseUrl?.trim();
  if (builtin) {
    // OpenAI 兼容端点覆盖：若用户指定了 baseUrl，覆盖内置 Model 的 baseUrl
    if (trimmedBaseUrl) {
      return { ...builtin, baseUrl: trimmedBaseUrl };
    }
    return builtin;
  }

  log.warn('model not in pi builtin catalog, constructing minimal model', {
    providerId,
    modelId,
    baseUrl,
  });

  // 构造最小 OpenAI 兼容 Model
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    api: OPENAI_COMPATIBLE_API,
    baseUrl: trimmedBaseUrl ?? undefined,
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    input: ['text'],
  };
}

/**
 * 构建 streamFn：包装 pi-ai 的 streamSimple，注入 Urchin 的 apiKey。
 *
 * streamSimple 会根据 model.provider 解析内置 Provider 并流式返回。
 * apiKey 通过 options.apiKey 注入，baseUrl 通过 model.baseUrl 传递。
 */
function createStreamFn(apiKey: string): StreamFn {
  return (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    log.info('streamFn invoked', {
      modelId: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      hasApiKey: !!apiKey,
      contextMessages: context.messages.length,
    });
    const mergedOptions: SimpleStreamOptions = {
      ...options,
      apiKey,
    };
    const stream = streamSimple(model, context, mergedOptions);
    // 监听流结束/错误，便于诊断"思考中"卡住问题
    const origResult = stream.result.bind(stream);
    stream.result = async () => {
      try {
        const result = await origResult();
        log.info('stream.result resolved', {
          modelId: model.id,
          stopReason: result.stopReason,
          errorMessage: result.errorMessage,
          contentBlocks: result.content.length,
        });
        return result;
      } catch (e) {
        log.error('stream.result rejected', {
          modelId: model.id,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    };
    return stream;
  };
}

/**
 * 创建 coding 工具集（bash/read/edit/write）。
 *
 * 工具的 execute() 核心逻辑不依赖 pi-tui，仅渲染函数依赖。
 * 方案 A：安装 pi-tui 作为依赖但不调用其渲染函数。
 */
function createCodingToolsList(cwd: string): readonly AgentTool[] {
  const bash = createBashTool(cwd);
  const read = createReadTool(cwd);
  const edit = createEditTool(cwd);
  const write = createWriteTool(cwd);
  return [bash, read, edit, write];
}

/**
 * 创建 pi Agent 实例（方案 A 适配层核心）。
 *
 * @example
 * ```typescript
 * const { agent, model, tools } = createPiAgent({
 *   providerId: 'openai',
 *   modelId: 'gpt-4o-mini',
 *   apiKey: settingsManager.get('ai.apiKey'),
 *   baseUrl: settingsManager.get('ai.baseUrl'),
 *   enableTools: true,
 *   cwd: process.cwd(),
 * });
 * agent.subscribe(event => { ... });
 * await agent.prompt('帮我读取 README.md');
 * ```
 */
export function createPiAgent(options: CreatePiAgentOptions): PiAgentHandle {
  const { providerId, modelId, apiKey, baseUrl, cwd, enableTools, systemPrompt, sessionId } =
    options;

  if (!apiKey) {
    throw new Error(`createPiAgent: apiKey is required for provider '${providerId}'`);
  }

  // 1. 解析 Model
  const model = resolveModel(providerId, modelId, baseUrl);

  // 2. 构建 streamFn（注入 apiKey）
  const streamFn = createStreamFn(apiKey);

  // 3. 构建 getApiKey（供 Agent 在需要时按 provider 取密钥）
  const getApiKey = (provider: string): string | undefined => {
    if (provider === providerId) return apiKey;
    return undefined;
  };

  // 4. 可选挂载 coding 工具
  const tools: AgentTool[] = [];
  if (enableTools && cwd) {
    tools.push(...createCodingToolsList(cwd));
    log.info('coding tools attached', { cwd, count: tools.length });
  }

  // 5. 构建 Agent
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: systemPrompt ?? '',
    },
    streamFn,
    getApiKey,
    sessionId,
  });

  log.info('pi agent created', {
    providerId,
    modelId,
    hasBaseUrl: !!baseUrl,
    toolsEnabled: tools.length > 0,
    inBuiltinCatalog: getBuiltinProviderSet().has(providerId),
  });

  return { agent, model, tools };
}

/**
 * 检查 providerId 是否为 pi 内置 provider。
 * 用于在 UI 层提示用户该 provider 的模型目录可用。
 */
export function isBuiltinProvider(providerId: string): boolean {
  return getBuiltinProviderSet().has(providerId);
}
