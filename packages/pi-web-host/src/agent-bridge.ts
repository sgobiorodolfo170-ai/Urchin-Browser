/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- vendored pi 边界，typecheck 走 ambient shim（any），esbuild 打真实源码 */
/**
 * pi 阶段 2 托管服务 · Agent 桥接（M2B）
 *
 * 用 vendored pi 的 Agent（pi-agent-core）+ streamSimple（pi-ai/compat）构造一轮对话，
 * 将 AgentEvent 流映射为 WS stream.chunk / stream.end（与 apps/desktop 的 pi-event-bridge
 * 同构，但输出目标是 WebSocket 而非 MessagePort）。
 *
 * 设计：M2B-1 只做「单轮 prompt → 流式回传」最小链路；会话持久化/模型目录/工具能力
 * 在 M2B-3/4 接入。apiKey/provider/model 经 argv 从主进程注入（agentConfigProvider 合并），
 * 不经 WS 传输（安全）。
 *
 * 事件映射（对齐 pi-event-bridge.ts）：
 * - message_update(text_delta) → stream.chunk { content: delta }
 * - tool_execution_start → stream.chunk { content: '\n[执行工具: name]\n' }（提示性）
 * - agent_end → stream.end { finishReason, usage }
 * - stopReason='error' → error
 */
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  getModel,
  getProviders,
  type AssistantMessageEvent,
  type Model,
  type Context,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai/compat';
import {
  createBashTool,
  createReadTool,
  createEditTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent';
import type { HostServerMessage, HostUsage } from './types';

/** Agent 桥创建选项（经 argv 从主进程注入） */
export interface AgentBridgeOptions {
  readonly apiKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  readonly systemPrompt?: string;
  readonly sessionId?: string;
  /** M2B-4：启用 coding 工具（bash/read/edit/write）；仅 utility 进程内安全 */
  readonly enableTools?: boolean;
  /** M2B-4：工具工作目录（enableTools=true 时必填） */
  readonly toolsCwd?: string;
  /** 插件工具（从 plugin-manager getActivePluginTools 获取，注入 Agent tools） */
  readonly extraTools?: AgentTool[];
}

/** 桥接句柄 */
export interface AgentBridgeHandle {
  /** 发起一轮 prompt；事件经 onMessage 流式回传 */
  prompt(text: string): Promise<void>;
  /** 中止当前轮 */
  abort(): void;
  /** 销毁：解绑订阅（agent 无显式 dispose，仅 unsubscribe） */
  dispose(): void;
  /** M2C-2：解决工具审批（approve 放行 / deny 拒绝 / edit 暂等同 approve） */
  resolveApproval(id: string, decision: 'approve' | 'deny' | 'edit'): void;
}

/** 从 AssistantMessageEvent 提取文本增量（与 pi-event-bridge 同） */
function extractDelta(event: AssistantMessageEvent): string {
  return event.type === 'text_delta' ? (event.delta ?? '') : '';
}

/** pi 1.4.0 Azure provider id 重命名映射（与 pi-agent-factory 同） */
const PROVIDER_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ['azure-openai-responses', 'azure'],
]);

function normalizeProviderId(providerId: string): string {
  return PROVIDER_ID_ALIASES.get(providerId) ?? providerId;
}

/** 解析 Model：优先 pi 内置目录；缺失构造最小 OpenAI 兼容 Model */
function resolveModel(providerId: string, modelId: string, baseUrl?: string): Model {
  const normalizedId = normalizeProviderId(providerId);
  const builtin = getModel(normalizedId, modelId);
  const trimmedBaseUrl = baseUrl?.trim();
  if (builtin) {
    return trimmedBaseUrl ? { ...builtin, baseUrl: trimmedBaseUrl } : builtin;
  }
  return {
    id: modelId,
    name: modelId,
    provider: normalizedId,
    api: 'openai-completions',
    baseUrl: trimmedBaseUrl ?? undefined,
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    input: ['text'],
  };
}

/** 构建 streamFn：包装 pi-ai streamSimple，注入 apiKey */
function createStreamFn(apiKey: string): StreamFn {
  return (model: Model, context: Context, options?: SimpleStreamOptions) => {
    const merged: SimpleStreamOptions = { ...options, apiKey };
    return streamSimple(model, context, merged);
  };
}

/**
 * 从 agent_end 事件的 messages 中提取 usage + 错误信息（与 pi-event-bridge 同）。
 */
function extractAgentEndMeta(event: Extract<AgentEvent, { type: 'agent_end' }>): {
  finishReason: string;
  usage?: HostUsage;
  errorMessage?: string;
} {
  const messages = event.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  let usage: HostUsage | undefined;
  if (lastAssistant && typeof lastAssistant === 'object' && 'usage' in lastAssistant) {
    const raw = (
      lastAssistant as { usage?: { input?: number; output?: number; totalTokens?: number } }
    ).usage;
    if (raw && typeof raw === 'object') {
      usage = { promptTokens: raw.input ?? 0, completionTokens: raw.output ?? 0 };
    }
  }
  const failure = lastAssistant as { stopReason?: string; errorMessage?: string } | undefined;
  if (failure?.errorMessage && failure.stopReason === 'error') {
    return { finishReason: 'error', usage, errorMessage: failure.errorMessage };
  }
  return { finishReason: 'stop', usage };
}

/**
 * 创建 Agent 桥。
 *
 * @param options 凭据/模型选项
 * @param onMessage 流式消息回调（发往 WS）
 * @param onError 致命错误回调（发往 WS 后结束）
 */
export function createAgentBridge(
  options: AgentBridgeOptions,
  onMessage: (msg: HostServerMessage) => void,
  onError: (code: string, message: string) => void,
): AgentBridgeHandle {
  const normalizedProviderId = normalizeProviderId(options.providerId);
  const model = resolveModel(normalizedProviderId, options.modelId, options.baseUrl);
  const streamFn = createStreamFn(options.apiKey);
  const getApiKey = (provider: string): string | undefined =>
    provider === normalizedProviderId ? options.apiKey : undefined;

  // M2B-4：在 utility 进程内恢复 coding 工具（bash/read/edit/write）
  // 安全前提：agent 只跑在独立 utility 进程，不污染主进程（ADR-004 / PH7）
  const tools: AgentTool[] = [];
  if (options.enableTools && options.toolsCwd) {
    tools.push(
      createBashTool(options.toolsCwd),
      createReadTool(options.toolsCwd),
      createEditTool(options.toolsCwd),
      createWriteTool(options.toolsCwd),
    );
  }
  if (options.extraTools) {
    for (const t of options.extraTools) {
      tools.push(t);
    }
  }

  // M2C-2：工具审批——beforeToolCall 钩子在工具执行前暂停，发 tool_approval_pending，
  // 等待前端 tool_approval_response 后 resolve（approve 放行 / deny 阻断）。
  // pi Agent 的 beforeToolCall 是 async 且被 await（agent-loop.ts:739），真正暂停工具执行。
  const pendingApprovals = new Map<
    string,
    { resolve: (result: { block?: boolean; reason?: string } | undefined) => void }
  >();

  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: options.systemPrompt ?? '',
    },
    streamFn,
    getApiKey,
    sessionId: options.sessionId,
    beforeToolCall: async (
      context: { toolCall: { id?: string; name?: string }; args: unknown },
      signal?: AbortSignal,
    ) => {
      const toolCallId = context.toolCall.id ?? '';
      const toolName = context.toolCall.name ?? '';
      onMessage({
        type: 'tool_approval_pending',
        id: toolCallId,
        toolCallId,
        toolName,
        params: context.args,
      });
      return new Promise<{ block?: boolean; reason?: string } | undefined>((resolve) => {
        pendingApprovals.set(toolCallId, { resolve });
        if (signal) {
          signal.addEventListener('abort', () => {
            const pending = pendingApprovals.get(toolCallId);
            if (pending) {
              pendingApprovals.delete(toolCallId);
              pending.resolve({ block: true, reason: 'aborted' });
            }
          });
        }
      });
    },
  });

  let ended = false;

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (ended) return;
    switch (event.type) {
      case 'message_update': {
        const delta = extractDelta(event.assistantMessageEvent);
        if (delta) onMessage({ type: 'stream.chunk', content: delta });
        break;
      }
      case 'tool_execution_start': {
        onMessage({ type: 'stream.chunk', content: `\n[执行工具: ${event.toolName}]\n` });
        onMessage({
          type: 'tool_call',
          toolName: event.toolName ?? '',
          status: 'start',
        });
        break;
      }
      case 'tool_execution_end': {
        onMessage({
          type: 'tool_call',
          toolName: event.toolName ?? '',
          status: event.isError ? 'error' : 'end',
        });
        break;
      }
      case 'agent_end': {
        const meta = extractAgentEndMeta(event);
        ended = true;
        if (meta.errorMessage) {
          onError('agent_error', meta.errorMessage);
        } else {
          onMessage({ type: 'stream.end', finishReason: meta.finishReason, usage: meta.usage });
        }
        break;
      }
      default:
        // turn_start/end, message_start/end, tool_execution_end/update 等不产生 WS 消息
        break;
    }
  });

  return {
    async prompt(text: string): Promise<void> {
      ended = false;
      await agent.prompt(text);
    },
    abort(): void {
      agent.abort();
    },
    dispose(): void {
      unsubscribe();
    },
    resolveApproval(id: string, decision: 'approve' | 'deny' | 'edit'): void {
      const pending = pendingApprovals.get(id);
      if (!pending) return;
      pendingApprovals.delete(id);
      if (decision === 'deny') {
        pending.resolve({ block: true, reason: '用户拒绝执行' });
      } else {
        // approve 放行；edit 暂不支持参数修改，等同于 approve
        pending.resolve(undefined);
      }
    },
  };
}

export {
  normalizeProviderId,
  resolveModel,
  extractDeltaFromEvent as extractDeltaForTest,
  extractAgentEndMeta,
};

/** M2B-3：返回 pi 内置 provider id 列表（供前端模型目录展示） */
export function getProviderList(): readonly string[] {
  return getProviders();
}

/** 测试用导出：从 AssistantMessageEvent 提取 delta（与内部 extractDelta 同） */
function extractDeltaFromEvent(event: AssistantMessageEvent): string {
  return extractDelta(event);
}

/** 阶段 4：创建插件 LLM 提供回调（用 streamSimple 做一次性无工具补全） */
export function createLlmProvider(opts: {
  apiKey: string;
  providerId: string;
  modelId: string;
  baseUrl?: string;
}): (req: {
  prompt: string;
  system?: string;
}) => Promise<{ ok: boolean; text?: string; error?: string }> {
  const normalizedId = normalizeProviderId(opts.providerId);
  const model = resolveModel(normalizedId, opts.modelId, opts.baseUrl);
  const streamFn = createStreamFn(opts.apiKey);

  return async (req) => {
    try {
      const context = {
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.prompt },
        ],
      };
      let text = '';
      for await (const chunk of streamFn(model, context, { apiKey: opts.apiKey })) {
        const delta = chunk && typeof chunk === 'object' ? extractDelta(chunk) : '';
        if (delta) text += delta;
      }
      return { ok: true, text: text.slice(0, 8000) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
