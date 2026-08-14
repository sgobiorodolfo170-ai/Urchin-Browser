/**
 * M13 AI Side Panel · AI 域 IPC Handler 注册
 *
 * 依据：契约 B §3.1 ai.* / provider.* 通道 / 契约 E §6 / 契约 I §6 / 契约 A §6 IP8
 * 职责：
 * 1. provider.list：返回已注册 Provider 清单（含真实 capabilities/authMethod）
 * 2. provider.rescan：重新扫描 providers 目录
 * 3. provider.config.get/set：读写 per-provider 用户配置
 * 4. ai.chat.start：启动流式对话，创建 MessageChannel 并下发 port 给渲染进程
 * 5. ai.chat.abort：中止进行中的流式对话
 * 6. ai.agent.start/abort：Agent 模式对话（pi 适配层）
 *
 * 设计理由（契约 B §6 + SP1）：
 * - ipcRenderer.invoke 的返回值无法携带 MessagePort
 * - Main 创建 MessageChannelMain，port1 通过 webContents.postMessage 转交 Renderer
 * - port2 传给 Orchestrator 的 startStream 作为 rendererPort
 * - 渲染进程通过 port 接收 stream.chunk / stream.end / error 消息
 */
import type { IpcMain, WebContents } from 'electron';
import { MessageChannelMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { ProviderRegistry } from '../orchestrator/provider-registry';
import { startStream } from '../orchestrator/stream';
import { getPiBuiltinProvidersInfo } from './pi-providers-info';
import type { CompletionRequest } from '@urchin/ai-provider-contract';
import { bridgeAgentToPort } from './pi-event-bridge';

/**
 * pi-agent-factory 及其依赖（@earendil-works/pi-agent-core / pi-ai / pi-coding-agent）
 * 体积庞大（含完整模型目录 + 39 个 provider 适配器 + coding 工具集），
 * 在主进程启动时静态加载会严重拖慢首屏。
 *
 * 采用动态 import() 延迟到 ai.agent.start 首次调用时才加载，
 * 使启动不再被 AI 重模块阻塞；常规对话（ai.chat.start）走 utility process，
 * 完全不触碰 pi 模块。
 */
const loadPiAgentFactory = (): Promise<typeof import('./pi-agent-factory')> =>
  import('./pi-agent-factory');

const log = createLogger('ai-ipc');

/** ai.chat.port 事件通道名（单向推送，携带 MessagePort） */
const AI_CHAT_PORT_CHANNEL = 'ai.chat.port';

/**
 * Provider ID 规范化：将 UI 层的虚拟 providerId 映射到 ProviderRegistry 中实际注册的 id。
 *
 * pi-settings-dialog 使用 'custom-openai-compatible' 作为自定义 OpenAI 兼容端点的 UI 标识，
 * 但 ProviderRegistry 中内置部署的 provider id 为 'openai-compatible'。
 * ai.chat.start 走 Orchestrator 子进程路径，需要实际注册的 id 才能命中。
 * ai.agent.start 走 pi 适配层路径，不经过 ProviderRegistry，无需映射。
 */
function normalizeProviderIdForOrchestrator(providerId: string): string {
  if (providerId === 'custom-openai-compatible') return 'openai-compatible';
  return providerId;
}

/** 活跃流式对话句柄（conversationId → StreamHandle） */
interface ActiveStream {
  readonly conversationId: string;
  abort(): void;
}

/**
 * Agent 模式配置提供器（方案 A 适配层）。
 *
 * 返回指定 providerId 的合并配置（apiKey / baseUrl）。
 * 实现侧在 index.ts 中复用 mergedConfigProvider，合并全局 ai.* 设置与 per-provider 配置。
 */
export interface AgentConfigProvider {
  get(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }>;
}

/**
 * Provider 配置存储接口（W5-D2）。
 *
 * 用于读写 per-provider 用户配置（API key 等）。
 * 实现通常基于 StorageLayer.aiStore，key = `provider_config:<id>`。
 *
 * 注意：get 返回 Promise，因为底层 aiStore.get 是 async（better-sqlite3 同步实现，
 * 但接口声明为 async 以兼容 IPC 契约）。调用方必须 await，
 * 否则 Promise 对象被展开/序列化会导致 "An object could not be cloned" 错误。
 */
export interface ProviderConfigStore {
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- 运行时可能返回 Promise（aiStore.get 是 async）或同步值，调用方统一 await
  get(providerId: string): Promise<unknown> | unknown;
  set(providerId: string, config: unknown): void;
}

/**
 * 注册 AI 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param orchestrator AI Orchestrator 实例
 * @param registry Provider 注册表
 * @param configStore 可选的 Provider 配置存储（W5-D2，用于 provider.config.get/set）
 * @param agentConfigProvider 可选的 Agent 模式配置提供器（方案 A，用于 ai.agent.start）
 *
 * @returns dispose 函数：abort 所有活跃流（chat + agent），用于进程退出清理。
 *   在 performCleanup 中、orchestrator.disposeAll 之前调用，确保：
 *   1. 进行中的 chat 流通过 streamHandle.abort() 触发 Provider abort + stream cleanup
 *   2. 进行中的 agent 流通过 bridgeHandle.abort() 触发 agent.abort() + bridge cleanup
 *      → 间接触发 pi-event-bridge.cleanup()，解绑 agent.subscribe listener、关闭 port2
 *      → 触发 pi Agent 的 HTTP 流中断（若正在进行），避免孤儿 HTTP 连接
 */
export function registerAiHandlers(
  ipcMain: IpcMain,
  orchestrator: Orchestrator,
  registry: ProviderRegistry,
  configStore?: ProviderConfigStore,
  agentConfigProvider?: AgentConfigProvider,
): { dispose(): void } {
  // 活跃流映射：conversationId → ActiveStream（chat 模式 + agent 模式共用）
  const activeStreams = new Map<string, ActiveStream>();

  // ── pi.providers：列出 pi 内置 Provider 元信息（方案 A 适配层，用于 pi 设置对话框） ──
  // 与 provider.list 不同：返回 pi 仓库内置 39 个 provider 的静态元信息（id/name/baseUrl/apiKeyEnvVar），
  // 不涉及 Urchin 子进程 Provider 注册表。对话框根据本列表展示可选 provider。
  registerHandler(ipcMain, 'pi.providers', () => {
    log.info('pi.providers');
    const { providers, generatedAt } = getPiBuiltinProvidersInfo();
    // zod schema 期望可变数组，展开 readonly 数组以满足类型契约
    return { providers: [...providers], generatedAt };
  });

  // ── provider.list：列出所有已注册 Provider（返回真实 capabilities/authMethod） ──
  registerHandler(ipcMain, 'provider.list', () => {
    log.info('provider.list');
    const registrations = registry.list();
    const providers = registrations.map((reg) => ({
      id: reg.id,
      name: reg.name,
      version: reg.version,
      apiVersion: reg.apiVersion,
      capabilities: [...reg.capabilities],
      authMethod: reg.authMethod as 'api_key' | 'oauth' | 'none' | 'local',
      rateLimit: reg.rateLimit
        ? {
            requestsPerMin: reg.rateLimit.requestsPerMin,
            tokensPerMin: reg.rateLimit.tokensPerMin,
          }
        : undefined,
    }));
    return { providers };
  });

  // ── provider.rescan：重新扫描 providers 目录（SettingsPage 打开时调用，确保内置 Provider 已注册） ──
  registerHandler(ipcMain, 'provider.rescan', () => {
    log.info('provider.rescan');
    const count = registry.reload();
    return {
      count,
      providers: registry.list().map((reg) => ({
        id: reg.id,
        name: reg.name,
        version: reg.version,
        apiVersion: reg.apiVersion,
        capabilities: [...reg.capabilities],
        authMethod: reg.authMethod as 'api_key' | 'oauth' | 'none' | 'local',
      })),
    };
  });

  // ── provider.remove / install：已移除（v0.2 恢复） ──
  // v0.1.0 第三方 Provider 安装 warning UI（provider-warning-dialog）未装配到 App，
  // provider.install / provider.remove 无生产调用方，属未交付死链路，已随组件一并删除。
  // v0.2 交付第三方 Provider 安装流程时按新交互重建（IP8 决策保留）。

  // ── provider.config.get：读取 Provider 用户配置（W5-D2） ──
  registerHandler(ipcMain, 'provider.config.get', async (req) => {
    log.info('provider.config.get', { providerId: req.providerId });
    if (!configStore) {
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        'provider.config.get: config store not available',
        { channel: 'provider.config.get' },
      );
    }
    // configStore.get 可能返回 Promise（aiStore.get 是 async），必须 await
    // 否则 Promise 对象经 IPC 结构化克隆会抛 "An object could not be cloned"
    const config = await configStore.get(req.providerId);
    return { providerId: req.providerId, config: config ?? null };
  });

  // ── provider.config.set：写入 Provider 用户配置（W5-D2） ──
  registerHandler(ipcMain, 'provider.config.set', (req) => {
    log.info('provider.config.set', { providerId: req.providerId });
    if (!configStore) {
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        'provider.config.set: config store not available',
        { channel: 'provider.config.set' },
      );
    }
    configStore.set(req.providerId, req.config);
    return { ok: true as const, providerId: req.providerId };
  });

  // ── ai.chat.start：启动流式对话 ──
  registerHandler(ipcMain, 'ai.chat.start', async (req, ctx) => {
    log.info('ai.chat.start', { providerId: req.providerId, model: req.model });

    // 1. 确保 Provider 已加载（规范化 UI 层的虚拟 providerId 到注册表实际 id）
    const orchestratorProviderId = normalizeProviderIdForOrchestrator(req.providerId);
    const host = await orchestrator.ensureProviderLoaded(orchestratorProviderId);

    // 2. 生成或复用 conversationId
    const conversationId =
      req.conversationId ??
      `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // 3. 构建 CompletionRequest
    const completionReq: CompletionRequest = {
      conversationId,
      messages: req.messages,
      model: req.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    };

    // 4. 获取 sender（渲染进程 webContents）用于下发 port
    const sender = ctx.event.sender as WebContents | null;
    if (!sender || typeof sender.send !== 'function') {
      throw new Error('ai.chat.start: invalid sender (webContents not available)');
    }

    // 5. 创建 MessageChannel：port1 → Renderer, port2 → Orchestrator
    const channel = new MessageChannelMain();
    const { port1, port2 } = channel;

    // 6. 通过 webContents.postMessage 下发 port1 给渲染进程
    sender.postMessage(AI_CHAT_PORT_CHANNEL, { conversationId, providerId: req.providerId }, [
      port1,
    ]);

    // 7. 启动流式调用（port2 作为 rendererPort 传给 Orchestrator）
    const streamHandle = startStream(host, completionReq, port2, {
      onEnd: (finishReason, usage) => {
        log.info('stream ended', { conversationId, finishReason, usage });
        activeStreams.delete(conversationId);
      },
    });

    // 8. 记录活跃流
    activeStreams.set(conversationId, {
      conversationId,
      abort: () => streamHandle.abort(),
    });

    return { conversationId };
  });

  // ── ai.chat.abort：中止流式对话 ──
  registerHandler(ipcMain, 'ai.chat.abort', (req) => {
    log.info('ai.chat.abort', { conversationId: req.conversationId });

    const stream = activeStreams.get(req.conversationId);
    if (stream) {
      stream.abort();
      activeStreams.delete(req.conversationId);
    } else {
      log.warn('ai.chat.abort: stream not found', { conversationId: req.conversationId });
    }

    return { ok: true as const, conversationId: req.conversationId };
  });

  // ── ai.agent.start：启动 Agent 模式对话（pi 适配层，方案 A） ──
  // 与 ai.chat.start 并存，使用 pi 的 Agent 实例，支持工具调用循环。
  // 流式输出格式与 ai.chat.start 一致（StreamMessage），渲染层无需改动。
  registerHandler(ipcMain, 'ai.agent.start', async (req, ctx) => {
    log.info('ai.agent.start', {
      providerId: req.providerId,
      model: req.model,
      // enableTools 已强制禁用（v0.1 止血），此处仅记录渲染层是否尝试开启
      enableToolsRequested: req.enableTools,
    });

    if (!agentConfigProvider) {
      throw new IpcError(
        IpcErrorCode.UNAVAILABLE,
        'ai.agent.start: agent config provider not available',
        { channel: 'ai.agent.start' },
      );
    }

    // 1. 读取 provider 配置（apiKey / baseUrl）
    const config = await agentConfigProvider.get(req.providerId);
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new IpcError(
        IpcErrorCode.PERMISSION,
        `ai.agent.start: no API key configured for provider '${req.providerId}'`,
        { channel: 'ai.agent.start' },
      );
    }

    // 2. 生成或复用 conversationId
    const conversationId =
      req.conversationId ??
      `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // 3. 创建 pi Agent 实例（动态加载 pi-agent-factory，首次调用时加载重模块）
    // 提取 system 消息作为 systemPrompt 传给 pi Agent
    // 安全（v0.1 止血，SEC-2026-08-14）：coding 工具（bash/read/edit/write）若挂载到主进程
    // Agent 上，可在浏览器主进程执行任意 shell 命令。v0.1 对话路径在主进程内运行（orchestrator
    // 子进程路径 ai.chat.start 未接线），故此处强制禁用 enableTools，杜绝工具经 IPC 被开启；
    // 恢复条件：生产对话迁移到 utility 子进程（ai.chat.start）后，工具随 Agent 在子进程内运行。
    const systemMessage = req.messages.find((m) => m.role === 'system');
    let agentHandle;
    try {
      const { createPiAgent } = await loadPiAgentFactory();
      agentHandle = createPiAgent({
        providerId: req.providerId,
        modelId: req.model,
        apiKey,
        baseUrl: req.baseUrl ?? config.baseUrl,
        enableTools: false, // v0.1 强制禁用（见上安全说明）；req.enableTools 值被忽略
        systemPrompt: systemMessage?.content,
        sessionId: conversationId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error('ai.agent.start: failed to create pi agent', { conversationId, error: message });
      throw new IpcError(IpcErrorCode.INTERNAL, `ai.agent.start: ${message}`, {
        channel: 'ai.agent.start',
      });
    }

    // 4. 获取 sender（渲染进程 webContents）用于下发 port
    const sender = ctx.event.sender as WebContents | null;
    if (!sender || typeof sender.send !== 'function') {
      throw new Error('ai.agent.start: invalid sender (webContents not available)');
    }

    // 5. 创建 MessageChannel：port1 → Renderer, port2 → Agent 桥接
    const channel = new MessageChannelMain();
    const { port1, port2 } = channel;

    sender.postMessage(AI_CHAT_PORT_CHANNEL, { conversationId, providerId: req.providerId }, [
      port1,
    ]);

    // 6. 桥接 Agent 事件 → StreamMessage → Renderer port2
    const bridgeHandle = bridgeAgentToPort(agentHandle.agent, conversationId, port2, {
      onEnd: (finishReason) => {
        log.info('agent stream ended', { conversationId, finishReason });
        activeStreams.delete(conversationId);
      },
      onError: (error) => {
        log.error('agent stream error', { conversationId, error: error.message });
        activeStreams.delete(conversationId);
      },
    });

    activeStreams.set(conversationId, {
      conversationId,
      abort: () => bridgeHandle.abort(),
    });

    // 7. 发送最后一条 user 消息作为 prompt（异步执行，不阻塞 IPC 响应）
    const lastUserMessage = [...req.messages].reverse().find((m) => m.role === 'user');
    const promptText =
      lastUserMessage?.content ?? req.messages[req.messages.length - 1]?.content ?? '';

    // 若有 system 消息，作为 systemPrompt 已在 createPiAgent 中设置；
    // 此处仅发送 user prompt 给 Agent
    void (async () => {
      try {
        log.info('agent.prompt start', { conversationId, promptLength: promptText.length });
        await agentHandle.agent.prompt(promptText);
        log.info('agent.prompt completed', { conversationId, bridgeEnded: bridgeHandle.ended });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error('agent.prompt failed', { conversationId, error: message });
        if (!bridgeHandle.ended) {
          bridgeHandle.abort();
        }
        activeStreams.delete(conversationId);
      }
    })();

    return { conversationId };
  });

  // ── ai.agent.abort：中止 Agent 模式对话 ──
  registerHandler(ipcMain, 'ai.agent.abort', (req) => {
    log.info('ai.agent.abort', { conversationId: req.conversationId });

    const stream = activeStreams.get(req.conversationId);
    if (stream) {
      stream.abort();
      activeStreams.delete(req.conversationId);
    } else {
      log.warn('ai.agent.abort: stream not found', { conversationId: req.conversationId });
    }

    return { ok: true as const, conversationId: req.conversationId };
  });

  log.info('ai ipc handlers registered');

  /**
   * dispose：abort 所有活跃流并清空 activeStreams。
   *
   * 在主进程 performCleanup 中、orchestrator.disposeAll 之前调用，
   * 确保进行中的 chat / agent 流被显式 abort，间接触发 stream.ts / pi-event-bridge.ts
   * 的 cleanup()，释放 listener、MessagePort 和 HTTP 连接。
   */
  return {
    dispose(): void {
      if (activeStreams.size === 0) return;
      log.info('disposing active AI streams', { count: activeStreams.size });
      for (const stream of activeStreams.values()) {
        try {
          stream.abort();
        } catch (e) {
          log.error('failed to abort stream during dispose', {
            conversationId: stream.conversationId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      activeStreams.clear();
    },
  };
}
