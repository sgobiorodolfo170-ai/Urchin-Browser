# 契约 B · M17 IPC Protocol Layer

> 状态：Draft  · 日期：2026-07-27  · 关联决策：IP5-IP7 / IP9
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

为 Main / Renderer / AI Orchestrator / Provider Child 之间的所有跨进程通信提供：
- 类型化 RPC（请求-响应）
- 类型化流式通道（token 流、长任务进度）
- 类型化单向事件推送（状态变化广播）
- 入参出参双向 zod 校验（防止 AI 协作时 schema 漂移）

## 2. 双通道设计

```
┌──────────────┐                       ┌──────────────┐
│  Renderer    │◄────ipcMain.handle────│  Main        │
│              │     (请求-响应 RPC)    │              │
└──────┬───────┘                       └──────┬───────┘
       │                                      │
       │ MessagePort (.once transferred)      │ fork + MessagePort
       │ → 流式 token 经 Main 中转到 Side Panel │
       ▼                                      ▼
┌──────────────────────────────────────────────────────┐
│  AI Orchestrator (utility)                           │
│  ── fork + MessagePort ─► Provider Child             │
└──────────────────────────────────────────────────────┘
```

- **请求-响应 RPC** 走 `ipcMain.handle` / `ipcRenderer.invoke`：标签管理、Settings、Bookmarks、Provider 配置等离散调用。
- **流式通道** 走 MessagePort：Renderer ↔ Orchestrator 一对，Orchestrator ↔ Provider Child 一对。Main 在 Renderer MessagePort 上做一次中转（IP9 决策），v0.1 简单方案；v0.2+ 可优化为 Orchestrator 直连 Renderer 绕过 Main。

## 3. 类型化 RPC 协议

### 3.1 Schema 定义（单一真源）

```typescript
// packages/ipc-contract/src/protocol.ts
import { z } from 'zod';

const TabSnapshotSchema = z.object({
  id: z.string(),
  windowId: z.string(),
  url: z.string(),
  title: z.string(),
  favicon: z.string().nullable(),
  loadingState: z.enum(['idle', 'loading', 'crashed']),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

const BookmarkSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  url: z.string().nullable(),          // folder 无 url
  title: z.string(),
  type: z.enum(['folder', 'bookmark']),
  position: z.number(),
});

const HistoryItemSchema = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string().nullable(),
  visitedAt: z.number(),
  visitCount: z.number(),
});

const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  state: z.enum(['ready', 'initializing', 'unavailable', 'disabled']),
  capabilities: z.array(z.string()),
});

export const ipcSchema = {
  'tab.create':       { req: z.object({ url: z.string().optional(), windowId: z.string() }), res: z.object({ tabId: z.string() }) },
  'tab.close':        { req: z.object({ tabId: z.string() }),                                      res: z.object({ ok: z.boolean() }) },
  'tab.list':         { req: z.object({ windowId: z.string() }),                                   res: z.object({ tabs: z.array(TabSnapshotSchema) }) },
  'tab.setActive':    { req: z.object({ tabId: z.string() }),                                      res: z.object({ ok: z.boolean() }) },
  'tab.reload':       { req: z.object({ tabId: z.string(), ignoreCache: z.boolean().optional() }), res: z.object({ ok: z.boolean() }) },
  'tab.goBack':       { req: z.object({ tabId: z.string() }),                                      res: z.object({ ok: z.boolean() }) },
  'tab.goForward':    { req: z.object({ tabId: z.string() }),                                      res: z.object({ ok: z.boolean() }) },

  'bookmark.add':     { req: z.object({ url: z.string(), title: z.string(), parentId: z.string().optional() }), res: z.object({ id: z.string() }) },
  'bookmark.list':    { req: z.object({}),                                                          res: z.object({ bookmarks: z.array(BookmarkSchema) }) },
  'bookmark.remove':  { req: z.object({ id: z.string() }),                                          res: z.object({ ok: z.boolean() }) },

  'history.query':    { req: z.object({ startTime: z.number().optional(), maxResults: z.number().optional() }), res: z.object({ items: z.array(HistoryItemSchema) }) },

  'settings.get':     { req: z.object({ key: z.string() }),                                         res: z.object({ value: z.unknown() }) },
  'settings.set':     { req: z.object({ key: z.string(), value: z.unknown() }),                     res: z.object({ ok: z.boolean() }) },

  'ai.chat.start':    { req: z.object({
                          providerId: z.string(),
                          conversationId: z.string().optional(),
                          messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })),
                          stream: z.boolean().default(true),
                        }), res: z.object({ conversationId: z.string() }) },
  'ai.chat.abort':    { req: z.object({ conversationId: z.string() }),                              res: z.object({ ok: z.boolean() }) },

  'provider.list':    { req: z.object({}),                                                          res: z.object({ providers: z.array(ProviderInfoSchema) }) },
  'provider.install': { req: z.object({ source: z.string(), confirm: z.boolean() }),                res: z.object({ providerId: z.string() }) },
  'provider.remove':  { req: z.object({ providerId: z.string() }),                                  res: z.object({ ok: z.boolean() }) },

  // DevTools 增强 → Side Panel 上下文注入（契约 G §7 的第一跳；第二跳为事件推送 'sidepanel.context_injected'）
  'sidepanel.inject_context': { req: z.object({ content: z.string(), source: z.enum(['devtools', 'manual']) }), res: z.object({ ok: z.boolean() }) },
  // ...
} as const;

export type IpcChannel = keyof typeof ipcSchema;
export type IpcReq<C extends IpcChannel> = z.infer<typeof ipcSchema[C]['req']>;
export type IpcRes<C extends IpcChannel> = z.infer<typeof ipcSchema[C]['res']>;
```

**关键设计**：zod schema 是单一真源——同时定义请求/响应类型 + 运行时校验。AI 写 IPC 调用代码时类型自动推导，不会写错参数。

### 3.2 IP5：zod → .d.ts 编译

```bash
# 构建期用 zod-to-ts 把 schema 编译为独立 .d.ts
pnpm tsx scripts/gen-ipc-dts.ts
```

输出 `packages/ipc-contract/dist/ipc.d.ts`，扩展开发者引用此 .d.ts 即获得类型，**无需安装 zod 依赖**。这是 IP5 决策的落地。

### 3.3 命名规范

`<域>.<动作>` 点分形式：`tab.create` / `bookmark.add` / `ai.chat.start` / `provider.install`。

方便按命名空间做权限授予/审计/扩展白名单（v0.2+ M9 完整化时使用）。

## 4. Main 进程的 handle 包装器

```typescript
// apps/desktop/src/main/ipc/server.ts
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { ipcSchema, IpcChannel, IpcReq, IpcRes } from '@urchin/ipc-contract';

export interface IpcCallCtx {
  callerWebContentsId: number;
  callerTabId?: string;
  callerExtensionId?: string;
  permissions: string[];
}

export class IpcError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) { super(message); }
}

export type IpcErrorCode =
  | 'VALIDATION_FAILED'
  | 'RESPONSE_INVALID'
  | 'INTERNAL'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT';

export function registerHandler<C extends IpcChannel>(
  channel: C,
  handler: (req: IpcReq<C>, ctx: IpcCallCtx) => Promise<IpcRes<C>> | IpcRes<C>,
  opts: { timeoutMs?: number; requirePermission?: string } = {},
): void {
  const timeoutMs = opts.timeoutMs ?? 30_000;   // IP7 默认 30s

  ipcMain.handle(channel, async (evt: IpcMainInvokeEvent, raw: unknown) => {
    // 入参校验
    const parsed = ipcSchema[channel].req.safeParse(raw);
    if (!parsed.success) {
      throw new IpcError('VALIDATION_FAILED', parsed.error.format());
    }

    const ctx: IpcCallCtx = {
      callerWebContentsId: evt.sender.id,
      permissions: [],  // 从 webContents 关联的扩展/用户权限上下文取
    };

    // 权限校验
    if (opts.requirePermission && !ctx.permissions.includes(opts.requirePermission)) {
      throw new IpcError('PERMISSION_DENIED', `Missing: ${opts.requirePermission}`);
    }

    // 超时保护（IP7）
    const timeoutCtrl = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new IpcError('TIMEOUT', `${channel} exceeded ${timeoutMs}ms`)), timeoutMs),
    );

    try {
      const result = await Promise.race([
        handler(parsed.data, ctx),
        timeoutCtrl,
      ]);

      // 出参校验
      const out = ipcSchema[channel].res.safeParse(result);
      if (!out.success) throw new IpcError('RESPONSE_INVALID', out.error.format());
      return out.data;
    } catch (e) {
      if (e instanceof IpcError) throw e;
      throw new IpcError('INTERNAL', String(e), { cause: e });
    }
  });
}
```

**入参出参双向校验的理由**：AGENTS.md §六逻辑架构审查强调「禁止 magic number 与隐性约定」——AI 协作时常见的 schema 漂移（handler 实现返回了新字段但 schema 没更新，或反之）能被双向校验断言拦截。

## 5. Renderer 进程的 typedInvoker

```typescript
// apps/desktop/src/renderer/ipc/client.ts
import { ipcRenderer } from 'electron';
import { IpcChannel, IpcReq, IpcRes } from '@urchin/ipc-contract';

export async function invoke<C extends IpcChannel>(
  channel: C,
  req: IpcReq<C>,
): Promise<IpcRes<C>> {
  try {
    return await ipcRenderer.invoke(channel, req) as IpcRes<C>;
  } catch (e: any) {
    // Main 端抛的 IpcError 通过 Electron 序列化后到达 Renderer
    throw new IpcError(e.code ?? 'UNKNOWN', e.message ?? String(e));
  }
}
```

- 渲染层不再手写 channel 字符串，所有调用类型推导。
- AI 生成调用代码时不会拼错 channel 名（编译期检查）。

## 6. MessagePort 流式协议（IP6 决策）

### 6.1 二级 MessagePort chain 与移交握手

```
[Provider Child] ──postMessage(port1)──► [Orchestrator] ──postMessage(port2)──► [Main 中转] ──postMessage(port3)──► [Renderer]
```

- 三段 MessagePort，每段两端独立。
- Main 中转一份 port（IP9 决策），v0.1 简单；v0.2+ 可优化为 Orchestrator 直接 transfer port 给 Renderer，绕过 Main。

**Port 移交握手**（关键约束：`ipcRenderer.invoke` 的返回值**无法携带 MessagePort**，port 必须经 `webContents.postMessage` 单独下发）：

```
Renderer                    Main                        Orchestrator
   │  invoke('ai.chat.start', req)  │                       │
   │───────────────────────────────►│  创建 MessageChannelMain { portA, portB }
   │                                │  postMessage({kind:'chat.start', req, port: portB}, [portB])
   │                                │──────────────────────►│
   │  webContents.postMessage('ai.chat.port', { conversationId }, [portA])
   │◄───────────────────────────────│                       │
   │  invoke 应答 { conversationId } │                       │
   │◄───────────────────────────────│                       │
   │  preload 收到 port → 按 conversationId 交给 subscribeToStream
```

1. Renderer 调 `invoke('ai.chat.start', req)`。
2. Main 创建 `MessageChannelMain`，把 `portB` 转交 Orchestrator（utility process `postMessage` + transfer）。
3. Main 用 `webContents.postMessage('ai.chat.port', { conversationId }, [portA])` 把 `portA` 下发给发起调用的 Renderer。
4. Main 应答 invoke → `{ conversationId }`。
5. Renderer preload 监听 `ai.chat.port`，按 `conversationId` 将 port 注入 `subscribeToStream`。

时序保证：invoke 应答与 port 下发无先后依赖——Renderer 侧以 `conversationId` 为键缓存先到者，两者齐备才开始消费流。

下发消息 schema：

```typescript
const PortDeliverySchema = z.object({
  conversationId: z.string(),
  providerId: z.string(),
});
```

### 6.2 流式消息 schema（IP6 每条 zod parse）

```typescript
const StreamMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chunk'),
    conversationId: z.string(),
    delta: z.object({
      content: z.string().optional(),
      role: z.string().optional(),
      // 兼容 OpenAI/Anthropic 等的 delta 结构
    }),
  }),
  z.object({
    kind: z.literal('done'),
    conversationId: z.string(),
    finishReason: z.enum(['stop', 'length', 'tool_call', 'content_filter', 'aborted']),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal('error'),
    conversationId: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
  z.object({
    kind: z.literal('abort'),
    conversationId: z.string(),
  }),
]);

type StreamMessage = z.infer<typeof StreamMessageSchema>;
```

**每条 message zod parse 的理由（IP6 决策）**：第三方 Provider 写入的流式数据格式可能不规范，每条校验能在源头拦截脏数据，避免下游 UI 渲染崩溃。性能损耗在 Prototypal 阶段可接受（每条 parse ~0.1ms），v0.5+ 若成瓶颈再优化为「握手期校验 + 后续裸传」。

### 6.3 Provider Child 端写入

```typescript
// apps/desktop/src/main/orchestrator/provider-host.ts（实际位于 apps/desktop/src/main/orchestrator/）
async function pipeProviderStreamToPort(
  provider: UrchinAIProvider,
  req: CompletionRequest,
  port: MessagePort,
  abortSignal: AbortSignal,
): Promise<void> {
  try {
    const stream = provider.stream(req);
    for await (const chunk of stream) {
      const msg: StreamMessage = { kind: 'chunk', conversationId: req.conversationId!, delta: chunk };
      const parsed = StreamMessageSchema.safeParse(msg);   // 出口校验
      if (!parsed.success) {
        port.postMessage({ kind: 'error', conversationId: req.conversationId!, error: { code: 'INVALID_RESPONSE', message: parsed.error.message, retryable: false } });
        return;
      }
      port.postMessage(parsed.data);

      if (abortSignal.aborted) {
        port.postMessage({ kind: 'abort', conversationId: req.conversationId! });
        return;
      }
    }
    port.postMessage({ kind: 'done', conversationId: req.conversationId!, finishReason: 'stop' });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('UNKNOWN', String(e));
    port.postMessage({ kind: 'error', conversationId: req.conversationId!, error: { code: err.code, message: err.message, retryable: err.retryable } });
  }
}
```

### 6.4 Renderer 端接收（走 Zustand transient updates）

```typescript
// apps/desktop/src/renderer/stores/ai-conversation.ts
import { create } from 'zustand';

interface AIConversationState {
  conversations: Record<string, Conversation>;
  // 内部 subscribe（不触发 React re-render）— 直接更新 DOM
  subscribeToStream: (conversationId: string, port: MessagePort) => void;
}

export const useAIConversation = create<AIConversationState>((set, get) => ({
  conversations: {},
  subscribeToStream: (conversationId, port) => {
    // 不用 React state，而是 transient updates 直接更新 DOM
    // Side Panel 组件本身用 subscribe（不 useStore）获取 token 流
    const appendChunk = (delta: any) => {
      // 直接调用 Side Panel ref 的 appendToken 方法
      sidePanelRef.current?.appendToken(delta.content ?? '');
    };

    // 渲染端 MessagePort 是 Web API——用 onmessage，而非 Node 风格 .on()
    port.onmessage = (evt) => {
      const raw = evt.data;
      const parsed = StreamMessageSchema.safeParse(raw);   // 入口校验
      if (!parsed.success) return;   // 脏数据丢弃，记日志

      const msg = parsed.data;
      switch (msg.kind) {
        case 'chunk':       appendChunk(msg.delta); break;
        case 'done':        sidePanelRef.current?.markComplete(msg.finishReason); break;
        case 'error':       sidePanelRef.current?.showError(msg.error); break;
        case 'abort':       sidePanelRef.current?.markAborted(); break;
      }
    };
    port.start();
  },
}));
```

**transient updates 的理由（T3 Zustand 决策）**：LLM token 流每秒可能几十次更新，若直接 dispatch 进 React 树会触发连锁 re-render，Side Panel 卡顿。用 `subscribe` 绕开 React 直接更新 DOM 是性能救命。

## 7. 单向事件推送协议

```typescript
// packages/ipc-contract/src/events.ts
export const tabEventsSchema = {
  'tab.created':   z.object({ tab: TabSnapshotSchema }),
  'tab.updated':   z.object({ tabId: z.string(), patch: TabPatchSchema }),
  'tab.removed':   z.object({ tabId: z.string() }),
  'tab.activated': z.object({ tabId: z.string(), windowId: z.string() }),
  'tab.crashed':   z.object({ tabId: z.string(), details: z.object({ reason: z.string() }) }),
} as const;

export type TabEvent = keyof typeof tabEventsSchema;

export const sidepanelEventsSchema = {
  // DevTools 增强 → Side Panel 上下文注入的第二跳（契约 G §7）
  'sidepanel.context_injected': z.object({ content: z.string(), source: z.enum(['devtools', 'manual']) }),
} as const;

export type SidePanelEvent = keyof typeof sidepanelEventsSchema;
```

- Main 进程单向推送：`webContents.send(event, payload)`。
- Renderer 进程单向接收：`ipcRenderer.on(event, cb)`。
- 推送前 Main 端做一次 zod parse 校验（IP6 一致性），未通过的不推。
- Renderer 收到后不再 mutate 本地状态，而是 setState 镜像）。

## 8. utility ↔ Main 反向调用协议

Provider Child 访问凭据/私有存储的请求（[contracts/I-orchestrator §7](./I-编排器.md)）同样走 zod schema 校验。传输层是 utility process 的 MessagePort RPC 封装（非 `ipcMain.handle`），但 schema 复用同一份定义：

```typescript
export const providerHostSchema = {
  'provider.secrets.get':    { req: z.object({ providerId: z.string(), name: z.string() }),                    res: z.object({ value: z.string().nullable() }) },
  'provider.secrets.set':    { req: z.object({ providerId: z.string(), name: z.string(), value: z.string() }), res: z.object({ ok: z.boolean() }) },
  'provider.secrets.delete': { req: z.object({ providerId: z.string(), name: z.string() }),                    res: z.object({ ok: z.boolean() }) },

  'provider.storage.get':    { req: z.object({ providerId: z.string(), key: z.string() }),                     res: z.object({ value: z.unknown().nullable() }) },
  'provider.storage.set':    { req: z.object({ providerId: z.string(), key: z.string(), value: z.unknown() }), res: z.object({ ok: z.boolean() }) },
  'provider.storage.delete': { req: z.object({ providerId: z.string(), key: z.string() }),                     res: z.object({ ok: z.boolean() }) },
  'provider.storage.query':  { req: z.object({ providerId: z.string(), prefix: z.string() }),                  res: z.object({ items: z.array(z.object({ key: z.string(), value: z.unknown() })) }) },
} as const;
```

**安全约束**：Main 端 handler 必须校验 `req.providerId` 与调用方 Provider Child 身份一致，不一致抛 `IpcError('PERMISSION_DENIED')`（契约 I §7）。

## 9. 错误协议

详见 §4 中 `IpcError` 定义。Renderer 调用 `invoke` 失败时拿到 `IpcError` 实例，可按 `code` 走分支处理：

| code | UI 处理建议 |
|---|---|
| `VALIDATION_FAILED` | dev 模式 toast，prod 静默上报 |
| `RESPONSE_INVALID` | 提示浏览器内部错误，建议重启 |
| `INTERNAL` | 错误 toast + 请求用户反馈 |
| `PERMISSION_DENIED` | 提示用户去 Settings 授予权限 |
| `NOT_FOUND` | 通常是 channel 拼错，dev 模式硬报错 |
| `TIMEOUT` | 提示操作超时，建议重试 |
