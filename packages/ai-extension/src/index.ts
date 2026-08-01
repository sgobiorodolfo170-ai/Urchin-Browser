/**
 * @urchin/ai-extension · AI 模块独立扩展包入口
 *
 * 阶段4 解耦决策：
 * AI 模块作为独立 package，通过 @urchin/browser-host 定义的 Host API
 * 与浏览器核心交互。本包仅依赖 Host API 契约类型，不直接耦合浏览器核心实现。
 *
 * 导出：
 *   - AiChatView：AI 对话窗口组件（三分区布局）
 *   - bootstrap：扩展模块入口工厂，接收 host 返回挂载所需资源
 *
 * 用法（浏览器核心 App.tsx）：
 *   import { AiChatView } from '@urchin/ai-extension';
 *   <AiChatView host={host} activeTabId={tabId} />
 */
export { AiChatView } from './ai-chat-view';
export { ConversationList } from './conversation-list';
export { useAiConversationStore } from './stores/ai-conversation';
export { useProviderStatusStore } from './stores/provider-status';
