/**
 * Host API 实现层（浏览器核心侧）
 *
 * 阶段5 解耦决策：
 * 将浏览器核心已有的 IPC 能力（window.urchin）适配为标准的 BrowserHostApi 接口，
 * 供 AI 模块（@urchin/ai-extension）通过 host 对象访问。
 *
 * 设计要点：
 * 1. 本文件位于浏览器核心侧（apps/desktop/renderer），桥接 window.urchin ↔ BrowserHostApi
 * 2. AI 模块只依赖 @urchin/browser-host 契约类型，不直接调用 window.urchin
 * 3. 未来可把适配逻辑移入 preload，直接暴露 host 对象（消除中间层）
 * 4. storage/workspace 命名空间在 v0.1 阶段6 前抛 NotSupported
 *
 * 安全边界：
 * - 所有调用仍经 IPC + zod 校验，主进程是 Single Source of Truth
 * - 本适配层不做任何权限放大，仅做接口形态转换
 */
import type {
  BrowserHostApi,
  ExtractedPageContext,
  MessagePortLike,
  ProviderEvent,
  ProviderInfo,
  TabEvent,
  TabSnapshot,
  UploadedFile,
} from '@urchin/browser-host';
import { getCurrentWindowId } from './lib/current-window';

/** preload 暴露的 MessagePort 代理（方法形式，见 preload/index.ts） */
interface RendererMessagePort {
  onMessage(handler: (data: unknown) => void): void;
  start(): void;
  close?(): void;
  postMessage(message: unknown): void;
}

/** window.urchin 的最小运行时形态（preload 注入） */
interface UrchinRuntime {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  onMessagePort(
    channel: string,
    callback: (payload: unknown, port: RendererMessagePort) => void,
  ): () => void;
  readonly platform: string;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
}

/** 获取 window.urchin 运行时 */
function getUrchin(): UrchinRuntime {
  const u = (window as unknown as { urchin?: UrchinRuntime }).urchin;
  if (!u) {
    throw new Error('window.urchin not available: preload did not inject API');
  }
  return u;
}

/** NotSupported 错误工厂 */
function notSupported(ns: string): never {
  throw new Error(
    `@urchin/browser-host: ${ns} namespace not supported in v0.1 (planned for 阶段6)`,
  );
}

/**
 * 从 window.urchin 构造 BrowserHostApi 实例。
 *
 * 在 App.tsx 挂载 AI 模块时调用一次，传入 AiChatView 的 host prop。
 */
export function createHostFromUrchin(): BrowserHostApi {
  return {
    // ── Page 命名空间 ──
    page: {
      async extract(tabId, maxLength?) {
        const u = getUrchin();
        void maxLength; // v0.1 抽取长度上限由 extractor 内建 50k 字符控制
        const res = (await u.invoke('page.extract', { tabId })) as {
          context: ExtractedPageContext;
        };
        return res.context;
      },
      async getActive() {
        const u = getUrchin();
        const res = (await u.invoke('tab.list', { windowId: await getCurrentWindowId() })) as {
          tabs: readonly TabSnapshot[];
        };
        const active = res.tabs.find((t) => t.active);
        if (!active) return null;
        return { id: active.id, url: active.url, title: active.title, loading: active.loading };
      },
    },

    // ── Tabs 命名空间 ──
    tabs: {
      async create(url, active = true) {
        const u = getUrchin();
        const res = (await u.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url,
          active,
        })) as { tab: TabSnapshot };
        return res.tab;
      },
      async close(tabId) {
        const u = getUrchin();
        await u.invoke('tab.close', { tabId });
        return { ok: true } as const;
      },
      async setActive(tabId) {
        const u = getUrchin();
        const res = (await u.invoke('tab.setActive', { tabId })) as { tab: TabSnapshot };
        return res.tab;
      },
      async list() {
        const u = getUrchin();
        const res = (await u.invoke('tab.list', { windowId: await getCurrentWindowId() })) as {
          tabs: readonly TabSnapshot[];
        };
        return res.tabs;
      },
      async loadUrl(tabId, url) {
        const u = getUrchin();
        await u.invoke('tab.loadUrl', { tabId, url });
        return { ok: true } as const;
      },
      onEvent(handler) {
        const u = getUrchin();
        return u.on('tab:event', (payload) => {
          handler(payload as TabEvent);
        });
      },
    },

    // ── Settings 命名空间 ──
    settings: {
      async get<T = unknown>(key: string) {
        const u = getUrchin();
        const res = (await u.invoke('settings.get', { key })) as { value: T | null };
        return res.value;
      },
      async set(key, value) {
        const u = getUrchin();
        await u.invoke('settings.set', { key, value });
        return { ok: true } as const;
      },
      async getAll() {
        const u = getUrchin();
        const res = (await u.invoke('settings.getAll', {})) as {
          settings: readonly { key: string; value: unknown }[];
        };
        return res.settings;
      },
      onChanged(handler) {
        // 浏览器核心通过 DOM CustomEvent 'urchin:settings-changed' 广播设置变更
        const listener = (e: Event): void => {
          const detail = (e as CustomEvent<{ keys: string[]; key: string; value: unknown }>).detail;
          if (detail?.key) {
            handler(detail.key, detail.value);
          } else if (detail?.keys) {
            // 批量变更时，对每个 key 触发一次
            for (const k of detail.keys) {
              handler(k, undefined);
            }
          }
        };
        window.addEventListener('urchin:settings-changed', listener);
        return () => {
          window.removeEventListener('urchin:settings-changed', listener);
        };
      },
    },

    // ── Storage 命名空间（v0.1 阶段6 前不支持） ──
    storage: {
      get() {
        notSupported('storage');
      },
      set() {
        notSupported('storage');
      },
      delete() {
        notSupported('storage');
      },
      keys() {
        notSupported('storage');
      },
    },

    // ── AI 命名空间 ──
    ai: {
      async listProviders() {
        const u = getUrchin();
        const res = (await u.invoke('provider.list', {})) as { providers: readonly ProviderInfo[] };
        return res.providers;
      },
      async rescanProviders() {
        const u = getUrchin();
        const res = (await u.invoke('provider.rescan', {})) as {
          providers: readonly ProviderInfo[];
        };
        return res.providers;
      },
      async startChat(params) {
        const u = getUrchin();
        // 走 ai.agent.start（pi 适配层）而非 ai.chat.start（orchestrator + provider child）。
        // 原因：ai.chat.start 依赖 ProviderRegistry，仅注册了 'openai-compatible' 一个 provider；
        // 当用户在 pi 设置对话框中选择 pi 内置 provider（如 'openai'/'anthropic' 等 39 个）时，
        // ai.chat.start 会报 "Provider not registered"。
        // ai.agent.start 走 pi-agent-factory + pi-ai streamSimple 路径，支持所有 pi 内置 provider，
        // 且 StreamMessage 格式与 port 下发机制与 ai.chat.start 完全一致，渲染层无需改动。
        const res = (await u.invoke('ai.agent.start', {
          providerId: params.providerId,
          conversationId: params.conversationId,
          messages: params.messages,
          model: params.model,
          temperature: params.temperature,
          maxTokens: params.maxTokens,
          stream: true,
        })) as { conversationId: string };
        return { conversationId: res.conversationId };
      },
      async abortChat(conversationId) {
        const u = getUrchin();
        // 与 startChat 配对，走 ai.agent.abort
        await u.invoke('ai.agent.abort', { conversationId });
        return { ok: true } as const;
      },
      onStreamPort(handler) {
        const u = getUrchin();
        return u.onMessagePort('ai.chat.port', (payload, port) => {
          const event = payload as { conversationId: string };
          // 将 preload 的方法形式 port 适配为 MessagePortLike（属性形式），
          // 供 ai-chat-view.tsx 使用 port.onmessage = ... 和 port.start()
          const adapter: MessagePortLike = {
            onmessage: null,
            start: () => port.start(),
            close: () => port.close?.(),
          };
          // 注册消息处理器：preload 收到 port 消息后调用此 handler，
          // handler 转发到 adapter.onmessage（渲染进程赋值的处理器）
          port.onMessage((data: unknown) => {
            if (adapter.onmessage) {
              adapter.onmessage({ data });
            }
          });
          handler(event.conversationId, adapter);
        });
      },
      onProviderEvent(handler) {
        const u = getUrchin();
        return u.on('provider:event', (payload) => {
          handler(payload as ProviderEvent);
        });
      },
    },

    // ── Lifecycle 命名空间 ──
    lifecycle: {
      ready() {
        // v0.1 简化实现：AI 模块挂载即就绪，无需主进程确认
        return Promise.resolve({ ok: true } as const);
      },
      onEvent(handler) {
        // v0.1 简化实现：通过 tab 事件推导生命周期
        // 真实生命周期事件可在阶段6 由主进程显式下发
        const u = getUrchin();
        const unsubscribe = u.on('tab:event', (payload) => {
          const evt = payload as TabEvent;
          if (evt.type === 'activated' && evt.snapshot.url.startsWith('urchin://ai')) {
            handler('activate');
          } else if (evt.type === 'updated' && evt.snapshot.url.startsWith('urchin://ai')) {
            handler('mount');
          }
        });
        return unsubscribe;
      },
    },

    // ── Input 命名空间：截图、上传文件、设置工作目录 ──
    input: {
      async screenshot() {
        const u = getUrchin();
        const res = (await u.invoke('ai.screenshot', {})) as {
          dataUri: string;
          mimeType: string;
          base64: string;
          displayId?: string;
        };
        return res;
      },
      async uploadFile(options) {
        const u = getUrchin();
        const res = (await u.invoke('ai.uploadFile', {
          title: options?.title,
          filters: options?.filters ?? [],
          multiple: options?.multiple ?? false,
        })) as { files: readonly UploadedFile[] };
        return res.files;
      },
      async setWorkdir(options) {
        const u = getUrchin();
        const res = (await u.invoke('ai.setWorkdir', {
          title: options?.title,
        })) as { path: string | null; exists: boolean; entryCount?: number };
        return res;
      },
    },

    // workspace 命名空间：v0.1 阶段6 前不实现
    // get workspace() { throw ... } — 通过可选属性缺失表达

    // ── 平台信息 ──
    platform: {
      get os() {
        const u = getUrchin();
        return u.platform as 'win32' | 'darwin' | 'linux';
      },
      get electron() {
        return getUrchin().versions.electron;
      },
      get chrome() {
        return getUrchin().versions.chrome;
      },
      get node() {
        return getUrchin().versions.node;
      },
    },
  };
}
