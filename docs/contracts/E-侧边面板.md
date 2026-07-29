# 契约 E · M13 AI Side Panel

> 状态：Draft  · 日期：2026-07-27  · 关联决策：SP1-SP7
> 模块归属：renderer  · 关联模块：M2 / M11 / M12 / M17
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

Side Panel 是 Urchin AI 原生定位的对外脸面。它必须：
- 始终可见（可折叠但默认展开），与当前激活 tab 上下文绑定
- 流式 token 渲染不卡 UI（必须走 transient updates，详见 [contracts/B-ipc-protocol §6.4](./B-进程间通信协议.md)）
- Markdown + 代码高亮 + 代码块复制按钮
- 多对话窗口独立——每个 tab 可有独立 AI 对话历史
- 提供中止、重试、清空对话按钮

## 2. 数据结构

```typescript
// packages/ipc-contract/src/ai-conversation.ts
export type ConversationId = string;

export interface Conversation {
  id: ConversationId;
  tabId: string;                     // 绑定的 tab（Tab 切换时 active conversation 跟着切）
  providerId: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
  streamingState: 'idle' | 'streaming' | 'tool_calling' | 'error' | 'aborted';
}

export interface ConversationMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
  // 仅 assistant 消息：流式过程中累积的元数据
  metadata?: {
    finishReason?: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'aborted';
    usage?: { promptTokens: number; completionTokens: number };
    providerError?: { code: string; retryable: boolean; message: string };
  };
}

export interface ConversationPatch {
  // 用于事件推送——增量更新
  conversationId: ConversationId;
  appendMessage?: ConversationMessage;
  appendToken?: { messageId: string; delta: string };
  updateStreamingState?: Conversation['streamingState'];
  updateMessageMetadata?: { messageId: string; patch: Partial<ConversationMessage['metadata']> };
}
```

## 3. 与 MessagePort 流式协议的衔接

回顾 [B-ipc-protocol §6.4](./B-进程间通信协议.md#64-renderer-端接收走-zustand-transient-updates)：Renderer 收到 `StreamMessage` 后通过 `sidePanelRef.current?.appendToken(...)` 直接更新 DOM。本节定义 `SidePanelHandle` 的 API 契约。

```typescript
// apps/desktop/src/renderer/side-panel/side-panel-ref.ts
export interface SidePanelHandle {
  /** 流式 token append 到当前 streaming assistant message */
  appendToken(delta: string): void;
  /** 标记当前 streaming 消息完成 */
  markComplete(finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'aborted'): void;
  /** 错误降级 UI */
  showError(error: { code: string; message: string; retryable: boolean }): void;
  /** 用户中止后状态标记 */
  markAborted(): void;
  /** 滚动到底部（token 进入时自动滚） */
  scrollToBottom(): void;
}
```

**SP1 决策落地**：React 组件实现要点：
- `appendToken` 直接 mutate 一个 `ref` 持有的 DOM 节点 `textContent`（或 `innerHTML` 增量），**不**触发 setState。
- 每收到 N 个 token 或 200ms 间隔（节流），把累积内容 snapshot 进 Zustand store（持久化用）。
- streaming 结束（`markComplete`）时把完整内容一次性写回 store 触发正常 re-render。

这避免每 token 都触发 React re-render（性能救命），又保证最终持久化与跨 tab 切换时数据完整。

## 4. Markdown + 代码高亮渲染

```typescript
// apps/desktop/src/renderer/side-panel/markdown-renderer.tsx
import ReactMarkdown from 'react-markdown';
import { rehypeHighlight } from 'rehype-highlight';

// 流式过程中的「轻量渲染」——只处理代码块边界与换行，不做完整 markdown
// 完成后再切到完整 ReactMarkdown 渲染
export function StreamingContent({ rawText }: { rawText: string }) {
  // 用简单的正则识别 ``` 代码块边界，蓝色背景显示
  // 不做语法高亮，避免每 token 重新高亮的开销
  return <SimpleBlockRender rawText={rawText} />;
}

export function FinalContent({ rawText }: { rawText: string }) {
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeHighlight]}
      components={{
        code: ({ inline, className, children }) => /* 自定义代码块组件含复制按钮 */,
        a:    ({ href, children }) => /* 在新 tab 打开 */,
      }}
    >
      {rawText}
    </ReactMarkdown>
  );
}
```

**SP2 + SP3 决策落地 — 两阶段渲染的理由**：
- 流式过程中每 token 触发完整 markdown parse + 语法高亮（rehype-highlight 用 highlight.js，单次 ~5-20ms）会肉眼可见卡。
- 流式阶段用最简渲染（识别代码块边界 + 换行），用户体验仍可读。
- `markComplete` 后切到完整渲染，做语法高亮 + 复制按钮 + 链接处理。

## 5. 上下文关联当前激活 tab（SP4 决策）

```typescript
// apps/desktop/src/renderer/side-panel/hooks/use-active-tab-context.ts
import { useEffect } from 'react';
import { useTabs } from '../stores/tabs';
import { useAIConversation } from '../stores/ai-conversation';

export function useActiveTabContext() {
  const activeTabId = useTabs(s => s.activeTabId);
  const setActiveConversation = useAIConversation(s => s.setActiveConversation);

  useEffect(() => {
    if (!activeTabId) return;
    // 切换 tab 时，找到该 tab 关联的 conversation，或新建一个
    const existing = useAIConversation.getState().findConversationByTab(activeTabId);
    setActiveConversation(existing?.id ?? null);
  }, [activeTabId]);
}
```

- **SP4**：每个 tab 可有 0 或 1 个 active conversation（SP6 决策 v0.1 不支持多对话切换，v0.2+ 引入）。
- Tab 关闭时，关联 conversation 不立即删除，进入「孤儿」状态，5 分钟后清理（给用户撤销窗口）。
- Tab URL 变化（导航到新页面）触发"该 conversation 是否继续保持"对话框——v0.1 简化为「保持」，v0.2+ 给用户选择。

## 6. 用户操作 → IPC 调用

```typescript
// 用户点「发送」
async function onSend(text: string) {
  const conv = useAIConversation.getState().activeConversation;
  const conversationId = conv?.id ?? genId();
  const messages = [
    ...(conv?.messages ?? []),
    { id: genId(), role: 'user', content: text, createdAt: Date.now() },
  ];

  // 1. 创建/更新 conversation（乐观 UI：立即在本地 store 显示 user message）
  useAIConversation.getState().upsertConversation({
    id: conversationId, tabId: activeTabId, providerId, messages,
    streamingState: 'streaming',
  });

  // 2. 发起 AI 调用：invoke 返回 conversationId；流式 port 经 'ai.chat.port' 消息单独下发
  //    （握手时序详见 [contracts/B-ipc-protocol §6.1](./B-进程间通信协议.md)——invoke 返回值无法携带 port）
  await invoke('ai.chat.start', { providerId, conversationId, messages, stream: true });
  // preload 收到 'ai.chat.port' 后回调注入：
  onStreamPort(conversationId, (port) =>
    useAIConversation.getState().subscribeToStream(conversationId, port),
  );
}

// 用户点「中止」
async function onAbort() {
  const conversationId = useAIConversation.getState().activeConversation?.id;
  if (conversationId) await invoke('ai.chat.abort', { conversationId });
}
```

## 7. 持久化策略（SP5 决策）

- v0.1 内存为主，关闭浏览器时一次性落盘到 M8 SQLite。
- v0.2+ 引入实时落盘（防 crash 丢失对话历史）。

> 持久化的权威实现以 [contracts/H-storage §4](./H-存储层.md) 的 `conversations` / `conversation_messages` 关系表为准。下方代码为**逻辑示意**，实际读写走 M8 表结构而非 KV blob。

```typescript
// 应用退出时（逻辑示意——实际写入 M8 ai.db 的 conversations / conversation_messages 表）
async function persistConversations(): Promise<void> {
  const all = useAIConversation.getState().conversations;
  await storage.persistConversations(all);   // M8 facade，内部写 ai.db 关系表
}

// 启动时（逻辑示意——实际从 ai.db 两表 join 加载）
async function restoreConversations(): Promise<void> {
  const saved = await storage.loadConversations();
  if (saved) useAIConversation.setState({ conversations: saved });
}
```

## 8. 决策记录（SP1-SP7）

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| SP1 | 流式 UI 更新方式 | ref 直接 mutate DOM + 节流 snapshot 进 store | 每 token setState 卡顿；直接 setState + React.memo 仍卡 |
| SP2 | 流式过程 Markdown 渲染 | 两阶段（轻量流式 + 完整最终） | 流式阶段全量 markdown 卡死 |
| SP3 | 代码高亮 | rehype-highlight（基于 highlight.js） | prism-react-renderer 更现代但更重 |
| SP4 | Tab 切换时 conversation 状态 | 隔离：每个 tab 独立 conversation | 共用一个 conversation 不符合 AI 原生定位 |
| SP5 | Conversation 持久化 | v0.1 内存 + 关闭时落盘；v0.2 + 实时落盘 | 实时落盘写入频率高影响性能 |
| SP6 | 多 conversation per tab | v0.1 单；v0.2+ 引入 | v0.1 上多复杂度高 |
| SP7 | 历史 conversation 浏览 UI | v0.2+ 引入「history 抽屉」 | v0.1 不做（首版价值低） |

## 9. 未来演进

- v0.2: 多 conversation per tab + history 抽屉 + 实时落盘 + Tab URL 变化的对话切换对话框
- v0.3: 跨设备 conversation sync（如果接入了用户账号系统）
- v1.0: 与 Page Context Extractor 联动的智能追问建议（基于当前页面内容主动推荐问题）
