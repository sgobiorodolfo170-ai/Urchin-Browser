/**
 * AI 对话窗口组件（urchin://ai 标签页内容）
 *
 * 阶段4 解耦决策：
 * 本组件从 apps/desktop 迁移至 @urchin/ai-extension 独立包。
 * 不再直接使用 window.urchin，而是通过注入的 host: BrowserHostApi 访问浏览器核心能力。
 * 这样 AI 模块可独立升级迭代，与浏览器核心解耦。
 *
 * 阶段3 三分区布局（保留）：
 * 左区 - 会话列表（可折叠）
 * 中区 - 对话工作区：header（摘要/清除）+ 消息列表 + 输入框
 * 右区 - 项目列表（可折叠）：v0.1 占位，阶段6 接入 workspace
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Square,
  Sparkles,
  AlertTriangle,
  RefreshCw,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  FolderKanban,
  MessageSquare,
  Settings as SettingsIcon,
  Camera,
  Paperclip,
  FolderOpen,
  X,
} from 'lucide-react';
import type {
  BrowserHostApi,
  ExtractedPageContext,
  MessagePortLike,
  ProviderEvent,
  ProviderInfo,
  StreamMessage,
} from '@urchin/browser-host';
import { Button } from './ui/button';
import { useAiConversationStore, type ChatMessage } from './stores/ai-conversation';
import { useProviderStatusStore } from './stores/provider-status';
import { ConversationList } from './conversation-list';
import { cn } from './lib/utils';

/** PC5 决策：XML 转义 */
function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c] ?? c,
  );
}

/** PC5 决策：把 ExtractedPageContext 拼成 XML 包裹字符串 */
function buildPageContextXml(ctx: ExtractedPageContext): string {
  const content = ctx.markdown.slice(0, 50_000);
  const warningsXml =
    ctx.warnings.length > 0
      ? `  <warnings>${ctx.warnings.map((w) => `<warning>${escapeXml(w)}</warning>`).join('')}</warnings>\n`
      : '';
  return `<page_context>
  <url>${escapeXml(ctx.url)}</url>
  <title>${escapeXml(ctx.title)}</title>
  <extracted_at>${escapeXml(ctx.extractedAt)}</extracted_at>${ctx.siteName ? `\n  <site_name>${escapeXml(ctx.siteName)}</site_name>` : ''}${ctx.byline ? `\n  <byline>${escapeXml(ctx.byline)}</byline>` : ''}${ctx.excerpt ? `\n  <excerpt>${escapeXml(ctx.excerpt)}</excerpt>` : ''}${ctx.language ? `\n  <language>${escapeXml(ctx.language)}</language>` : ''}
  <content>
${escapeXml(content)}
  </content>
${warningsXml}</page_context>`.trim();
}

const LEFT_WIDTH = 260;
const RIGHT_WIDTH = 240;
const COLLAPSED_WIDTH = 44;

/** 输入框底部模型选择框预设模型列表。
 *  pi 设置对话框中模型为自由文本输入（无后端模型清单 API），
 *  此处提供常用模型快捷选择；当前模型若不在列表中仍会在下拉中显示。 */
const MODEL_OPTIONS: readonly string[] = [
  'gpt-5',
  'gpt-4.1',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1-mini',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'deepseek-chat',
  'deepseek-reasoner',
];

/** 附件项：截图或上传的图片/文件 */
interface AttachmentItem {
  /** 唯一 ID（用于 React key） */
  readonly id: string;
  /** 文件名（截图自动生成，上传用原文件名） */
  readonly name: string;
  /** MIME 类型 */
  readonly mimeType: string;
  /** base64 数据（不含 data: 前缀） */
  readonly base64: string;
  /** data URI（可直接用于 <img src>） */
  readonly dataUri: string;
  /** 是否为图片 */
  readonly isImage: boolean;
  /** 文件大小（字节） */
  readonly size: number;
}

interface AiChatViewProps {
  /** 浏览器核心注入的 Host API，AI 模块通过它访问能力 */
  readonly host: BrowserHostApi;
  /**
   * 当前 AI 标签页关联的活跃 tab ID（用于摘要页面抽取）。
   * 若没有可用的网页 tab，摘要按钮禁用。
   */
  readonly activeTabId?: number | null;
  /**
   * 摘要触发信号（递增计数器）。
   *
   * 父组件（App.tsx）通过递增此值触发摘要功能。
   * AiChatView 监听变化，值递增时调用 handleSummarize。
   * 摘要按钮已迁移至地址栏 omnibox.tsx，通过此 prop 解耦触发源。
   */
  readonly summarizeSignal?: number;
  /**
   * 打开 pi 设置对话框回调。
   *
   * 齿轮设置按钮位于中区 header 右上角，点击时调用此回调。
   * 实际的 PiSettingsDialog 由父组件（App.tsx）渲染，通过此 prop 解耦。
   */
  readonly onOpenPiSettings?: () => void;
}

export function AiChatView({
  host,
  activeTabId = null,
  summarizeSignal = 0,
  onOpenPiSettings,
}: AiChatViewProps) {
  const [providers, setProviders] = useState<readonly ProviderInfo[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [model, setModel] = useState<string>('gpt-4o-mini');
  const [input, setInput] = useState<string>('');

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // 加号按钮弹出菜单：截图、上传图片或附件、设置工作目录
  const [showAddMenu, setShowAddMenu] = useState(false);
  // 待发送的附件列表（图片以 base64 ImageContent 形式发送，文本作为消息内容补充）
  const [attachments, setAttachments] = useState<readonly AttachmentItem[]>([]);
  // 当前工作目录（设置后显示在输入框上方提示）
  const [workdir, setWorkdir] = useState<string | null>(null);

  const streamingContentRef = useRef<HTMLDivElement>(null);
  const streamingBufferRef = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const conversations = useAiConversationStore((s) => s.conversations);
  const activeConversationId = useAiConversationStore((s) => s.activeConversationId);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- zustand store 方法通过闭包访问
  const createConversation = useAiConversationStore((s) => s.createConversation);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const addUserMessage = useAiConversationStore((s) => s.addUserMessage);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const startStreaming = useAiConversationStore((s) => s.startStreaming);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const appendToken = useAiConversationStore((s) => s.appendToken);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const markComplete = useAiConversationStore((s) => s.markComplete);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const markError = useAiConversationStore((s) => s.markError);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const markAborted = useAiConversationStore((s) => s.markAborted);

  // eslint-disable-next-line @typescript-eslint/unbound-method -- zustand store 方法
  const handleProviderEvent = useProviderStatusStore((s) => s.handleEvent);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 同上
  const clearCrash = useProviderStatusStore((s) => s.clearCrash);
  const providerStatuses = useProviderStatusStore((s) => s.statuses);

  const activeConversation = activeConversationId
    ? conversations.get(activeConversationId)
    : undefined;
  const isStreaming = activeConversation?.streamingState === 'streaming';

  const selectedProviderCrashed = selectedProviderId
    ? providerStatuses.get(selectedProviderId)?.status === 'crashed'
    : false;
  const crashReason = selectedProviderId
    ? providerStatuses.get(selectedProviderId)?.crashReason
    : undefined;

  // 加载 Provider 列表 + 设置（通过 Host API）
  useEffect(() => {
    async function loadProvidersAndSettings() {
      try {
        const modelVal = (await host.settings.get<string>('ai.model')) ?? null;
        if (typeof modelVal === 'string' && modelVal) {
          setModel(modelVal);
        }
        const providerVal = (await host.settings.get<string>('ai.providerId')) ?? null;

        const list = await host.ai.listProviders();
        setProviders(list);

        const configuredId = typeof providerVal === 'string' ? providerVal : '';
        const fallbackId = list[0]?.id ?? '';
        setSelectedProviderId(configuredId || fallbackId);
      } catch (e) {
        console.error('Failed to load providers/settings:', e);
      }
    }
    void loadProvidersAndSettings();

    // 订阅设置变更（通过 Host API）
    const unsubscribeSettings = host.settings.onChanged((key, value) => {
      void value;
      if (key.startsWith('ai.')) {
        void loadProvidersAndSettings();
      }
    });

    return unsubscribeSettings;
  }, [host]);

  // 订阅 Provider 事件（通过 Host API）
  useEffect(() => {
    const unsubscribe = host.ai.onProviderEvent((event: ProviderEvent) => {
      handleProviderEvent(event);
    });
    return unsubscribe;
  }, [host, handleProviderEvent]);

  // 订阅流式 MessagePort（通过 Host API）
  useEffect(() => {
    const unsubscribe = host.ai.onStreamPort((conversationId: string, port: MessagePortLike) => {
      streamingBufferRef.current = '';

      port.onmessage = (e: { readonly data: unknown }) => {
        const msg = e.data as StreamMessage;
        if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
        if (msg.conversationId && msg.conversationId !== conversationId) return;

        switch (msg.kind) {
          case 'stream.chunk': {
            const delta = msg.chunk?.content ?? '';
            if (delta) {
              streamingBufferRef.current += delta;
              if (streamingContentRef.current) {
                streamingContentRef.current.textContent = streamingBufferRef.current;
              }
              appendToken(conversationId, delta);
            }
            break;
          }
          case 'stream.end': {
            markComplete(conversationId, msg.finishReason ?? 'stop', msg.usage);
            streamingBufferRef.current = '';
            break;
          }
          case 'error': {
            markError(conversationId, msg.error ?? { code: 'unknown', message: 'Unknown error' });
            streamingBufferRef.current = '';
            break;
          }
          case 'abort': {
            markAborted(conversationId);
            streamingBufferRef.current = '';
            break;
          }
          default:
            break;
        }
      };
      port.start();
    });
    return unsubscribe;
  }, [host, appendToken, markComplete, markError, markAborted]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages.length, activeConversation?.streamingBuffer]);

  const handleNewChat = useCallback(() => {
    useAiConversationStore.getState().setActiveConversation(null);
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    if (!selectedProviderId) {
      const conversationId =
        activeConversationId ??
        `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      if (!activeConversationId) {
        createConversation({ conversationId, tabId: activeTabId, providerId: '', model });
      }
      addUserMessage(conversationId, trimmed);
      markError(conversationId, {
        code: 'no_provider',
        message: '未配置 AI Provider。请在设置 → AI 助手中配置 Provider、API Key 和模型。',
      });
      setInput('');
      return;
    }

    if (selectedProviderCrashed) {
      clearCrash(selectedProviderId);
    }

    const conversationId =
      activeConversationId ??
      `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!activeConversationId) {
      createConversation({
        conversationId,
        tabId: activeTabId,
        providerId: selectedProviderId,
        model,
      });
    }

    // 构造消息内容：文本 + 附件信息（图片以 markdown 引用形式附加到文本末尾）
    const attachmentText =
      attachments.length > 0
        ? attachments
            .map((a) => (a.isImage ? `\n[图片: ${a.name}]` : `\n[附件: ${a.name}]`))
            .join('')
        : '';
    const messageContent = trimmed + attachmentText;

    addUserMessage(conversationId, messageContent);
    startStreaming(conversationId);
    setInput('');
    // 清空已发送的附件
    setAttachments([]);

    const conv = useAiConversationStore.getState().conversations.get(conversationId);
    const messages = (conv?.messages ?? []).map((m: ChatMessage) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      await host.ai.startChat({
        providerId: selectedProviderId,
        conversationId,
        messages,
        model,
      });
    } catch (e) {
      markError(conversationId, {
        code: 'ipc_error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [
    input,
    isStreaming,
    selectedProviderId,
    activeConversationId,
    activeTabId,
    model,
    selectedProviderCrashed,
    clearCrash,
    host,
    createConversation,
    addUserMessage,
    startStreaming,
    markError,
    attachments,
  ]);

  // ── 加号菜单：截图 ──
  const handleScreenshot = useCallback(async () => {
    setShowAddMenu(false);
    try {
      const result = await host.input.screenshot();
      const attachment: AttachmentItem = {
        id: `screenshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.png`,
        mimeType: result.mimeType,
        base64: result.base64,
        dataUri: result.dataUri,
        isImage: true,
        size: Math.ceil(result.base64.length * 0.75),
      };
      setAttachments((prev) => [...prev, attachment]);
    } catch (e) {
      console.error('Screenshot failed:', e);
      // TODO: 错误提示（可扩展为 toast）
    }
  }, [host]);

  // ── 加号菜单：上传图片或附件 ──
  const handleUploadFile = useCallback(async () => {
    setShowAddMenu(false);
    try {
      const files = await host.input.uploadFile({
        title: '选择要上传的图片或附件',
        multiple: true,
      });
      if (files.length === 0) return;
      const newAttachments: AttachmentItem[] = files.map((f) => ({
        id: `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${f.name}`,
        name: f.name,
        mimeType: f.mimeType,
        base64: f.base64,
        dataUri: `data:${f.mimeType};base64,${f.base64}`,
        isImage: f.isImage,
        size: f.size,
      }));
      setAttachments((prev) => [...prev, ...newAttachments]);
    } catch (e) {
      console.error('Upload failed:', e);
    }
  }, [host]);

  // ── 加号菜单：设置工作目录 ──
  const handleSetWorkdir = useCallback(async () => {
    setShowAddMenu(false);
    try {
      const result = await host.input.setWorkdir({ title: '选择 AI 工作目录' });
      if (result.path) {
        setWorkdir(result.path);
        // 持久化到设置，供后续 ai.agent.start 使用
        void host.settings.set('ai.workdir', result.path);
      }
    } catch (e) {
      console.error('Set workdir failed:', e);
    }
  }, [host]);

  // 移除附件
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // 点击外部关闭加号菜单
  const addMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent): void => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  const handleAbort = useCallback(async () => {
    if (!activeConversationId) return;
    try {
      await host.ai.abortChat(activeConversationId);
      markAborted(activeConversationId);
    } catch (e) {
      console.error('Failed to abort:', e);
    }
  }, [activeConversationId, host, markAborted]);

  const handleSummarize = useCallback(async () => {
    if (!activeTabId || !selectedProviderId) return;

    const conversationId =
      activeConversationId ??
      `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!activeConversationId) {
      createConversation({
        conversationId,
        tabId: activeTabId,
        providerId: selectedProviderId,
        model,
      });
    }

    const userPrompt = '请摘要当前页面的主要内容。';
    addUserMessage(conversationId, userPrompt);
    startStreaming(conversationId);

    let pageContext: ExtractedPageContext | null = null;
    try {
      pageContext = await host.page.extract(activeTabId);
    } catch (e) {
      markError(conversationId, {
        code: 'extract_failed',
        message: `页面抽取失败: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    if (!pageContext) {
      markError(conversationId, {
        code: 'extract_empty',
        message: '页面抽取返回空结果',
      });
      return;
    }

    const pageXml = buildPageContextXml(pageContext);
    const messages = [
      {
        role: 'system' as const,
        content:
          'You are a helpful assistant analyzing the current page the user is viewing. Use the provided page context to answer the user question accurately.',
      },
      {
        role: 'user' as const,
        content: `${pageXml}\n\nUser question: ${userPrompt}`,
      },
    ];

    try {
      await host.ai.startChat({
        providerId: selectedProviderId,
        conversationId,
        messages,
        model,
      });
    } catch (e) {
      markError(conversationId, {
        code: 'ipc_error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [
    activeTabId,
    selectedProviderId,
    activeConversationId,
    model,
    host,
    createConversation,
    addUserMessage,
    startStreaming,
    markError,
  ]);

  // 摘要触发信号监听：summarizeSignal 递增时调用 handleSummarize
  // 摘要按钮已迁移至地址栏 omnibox.tsx，通过此 effect 解耦触发
  const lastSummarizeSignalRef = useRef<number>(0);
  useEffect(() => {
    if (summarizeSignal <= 0 || summarizeSignal === lastSummarizeSignalRef.current) return;
    lastSummarizeSignalRef.current = summarizeSignal;
    void handleSummarize();
  }, [summarizeSignal, handleSummarize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full bg-surface">
      {/* === 左区：会话列表（可折叠） === */}
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-surface-secondary transition-[width] duration-150"
        style={{ width: leftCollapsed ? COLLAPSED_WIDTH : LEFT_WIDTH }}
      >
        {leftCollapsed ? (
          <button
            className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-secondary hover:bg-surface hover:text-text"
            onClick={() => setLeftCollapsed(false)}
            aria-label="展开会话列表"
            title="展开会话列表"
          >
            <PanelLeftOpen className="h-4 w-4" />
            <span className="text-[10px] [writing-mode:vertical-rl]">会话</span>
          </button>
        ) : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
              <MessageSquare className="h-3.5 w-3.5 text-text-secondary" />
              <span className="flex-1 text-xs font-medium text-text">会话列表</span>
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-surface hover:text-text"
                onClick={handleNewChat}
                aria-label="新建对话"
                title="新建对话"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-surface hover:text-text"
                onClick={() => setLeftCollapsed(true)}
                aria-label="折叠会话列表"
                title="折叠会话列表"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ConversationList onNewChat={handleNewChat} />
            </div>
          </>
        )}
      </aside>

      {/* === 中区：对话工作区 === */}
      <main className="flex flex-1 flex-col overflow-hidden bg-surface">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-sm font-medium text-text">pi</span>
          {providers.length === 0 && (
            <span className="text-xs text-text-secondary">未配置 Provider</span>
          )}
          <div className="flex-1" />
          {/* pi 设置按钮：齿轮图标，点击弹出 pi provider/model 配置对话框 */}
          {onOpenPiSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0"
              onClick={onOpenPiSettings}
              aria-label="AI 助手设置"
              title="AI 助手设置"
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
          )}
          {/* 摘要按钮已迁移至地址栏 omnibox.tsx（收藏夹按钮后面），见方案 A 适配层 */}
        </div>

        {selectedProviderCrashed && (
          <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-text">Provider 已崩溃</p>
              {crashReason && (
                <p className="mt-0.5 text-xs text-text-secondary truncate">{crashReason}</p>
              )}
              <p className="mt-0.5 text-xs text-text-secondary">下次发送消息时将自动恢复</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => {
                if (selectedProviderId) {
                  clearCrash(selectedProviderId);
                }
              }}
              aria-label="关闭警告"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {(!activeConversation || activeConversation.messages.length === 0) && !isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center text-text-secondary">
              <Sparkles className="mb-2 h-10 w-10 opacity-50" />
              <p className="text-sm">AI 助手已就绪</p>
              <p className="mt-1 text-xs">在下方输入消息，或点击"摘要当前页面"</p>
            </div>
          )}

          {activeConversation?.messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {isStreaming && (
            <div className="flex justify-start">
              <div
                ref={streamingContentRef}
                className={cn(
                  'max-w-[80%] rounded-lg px-3 py-2 text-sm',
                  'bg-surface-secondary text-text',
                )}
              >
                {streamingBufferRef.current || '思考中...'}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* 输入区：固定尺寸 textarea + 底部功能按钮行（加号 / 模型选择 / 发送）
         *  textarea 固定高度、禁止拖拽缩放；底部一行为功能按钮区域 */}
        <div className="shrink-0 border-t border-border p-3">
          {/* 附件预览区：截图或上传的图片/文件以缩略图形式展示，可移除 */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-2 py-1 text-xs"
                  title={a.name}
                >
                  {a.isImage ? (
                    <img src={a.dataUri} alt={a.name} className="h-8 w-8 rounded object-cover" />
                  ) : (
                    <Paperclip className="h-3.5 w-3.5 text-text-secondary" />
                  )}
                  <span className="max-w-[10rem] truncate text-text">{a.name}</span>
                  <button
                    type="button"
                    className="ml-0.5 rounded p-0.5 text-text-secondary hover:bg-surface hover:text-error"
                    onClick={() => handleRemoveAttachment(a.id)}
                    aria-label={`移除 ${a.name}`}
                    title="移除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 工作目录提示 */}
          {workdir && (
            <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-2 py-1 text-xs text-text-secondary">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate" title={workdir}>
                工作目录：{workdir}
              </span>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            rows={3}
            placeholder={
              isStreaming ? 'AI 正在回复...' : '输入消息给 AI… (Enter 发送，Shift+Enter 换行)'
            }
            aria-label="AI 对话输入"
            className={cn(
              'w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm',
              'h-24 overflow-y-auto',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1',
              'disabled:opacity-60 disabled:cursor-not-allowed',
              'placeholder:text-text-secondary',
            )}
          />
          {/* 底部功能按钮行：加号按钮（含弹出菜单） + 模型选择框 + 发送/停止 */}
          <div className="mt-2 flex items-center gap-2">
            {/* 加号按钮 + 弹出菜单 */}
            <div ref={addMenuRef} className="relative">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                aria-label="添加"
                title="添加（截图、上传文件、设置工作目录）"
                onClick={() => setShowAddMenu((v) => !v)}
                disabled={isStreaming}
              >
                <Plus className="h-4 w-4" />
              </Button>
              {showAddMenu && (
                <div className="absolute bottom-full left-0 z-50 mb-1 w-48 rounded-md border border-border bg-surface shadow-dropdown">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text hover:bg-surface-secondary"
                    onClick={() => void handleScreenshot()}
                  >
                    <Camera className="h-4 w-4 text-text-secondary" />
                    <span>截图</span>
                    <span className="ml-auto text-[10px] text-text-secondary">截取全屏</span>
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text hover:bg-surface-secondary"
                    onClick={() => void handleUploadFile()}
                  >
                    <Paperclip className="h-4 w-4 text-text-secondary" />
                    <span>上传图片或附件</span>
                  </button>
                  <div className="my-0.5 border-t border-border" />
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text hover:bg-surface-secondary"
                    onClick={() => void handleSetWorkdir()}
                  >
                    <FolderOpen className="h-4 w-4 text-text-secondary" />
                    <span>设置工作目录</span>
                    {workdir && (
                      <span
                        className="ml-auto h-1.5 w-1.5 rounded-full bg-success"
                        title="已设置"
                      />
                    )}
                  </button>
                </div>
              )}
            </div>
            <select
              className="h-8 max-w-[14rem] shrink-0 truncate rounded-md border border-border bg-surface px-2 text-xs text-text focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1"
              value={model}
              onChange={(e) => {
                const next = e.target.value;
                setModel(next);
                // 持久化到 settings，与 pi 设置对话框共用同一 key
                void host.settings.set('ai.model', next);
              }}
              aria-label="选择模型"
              title={`当前模型：${model}`}
            >
              {MODEL_OPTIONS.includes(model) ? null : <option value={model}>{model}</option>}
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            {isStreaming ? (
              <Button
                variant="danger"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() => void handleAbort()}
                aria-label="停止生成"
                title="停止生成"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() => void handleSend()}
                disabled={!input.trim()}
                aria-label="发送消息"
                title="发送消息"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </main>

      {/* === 右区：项目列表（可折叠） === */}
      <aside
        className="flex shrink-0 flex-col border-l border-border bg-surface-secondary transition-[width] duration-150"
        style={{ width: rightCollapsed ? COLLAPSED_WIDTH : RIGHT_WIDTH }}
      >
        {rightCollapsed ? (
          <button
            className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-secondary hover:bg-surface hover:text-text"
            onClick={() => setRightCollapsed(false)}
            aria-label="展开项目列表"
            title="展开项目列表"
          >
            <PanelRightOpen className="h-4 w-4" />
            <span className="text-[10px] [writing-mode:vertical-rl]">项目</span>
          </button>
        ) : (
          <>
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
              <FolderKanban className="h-3.5 w-3.5 text-text-secondary" />
              <span className="flex-1 text-xs font-medium text-text">项目列表</span>
              <button
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-surface hover:text-text"
                onClick={() => setRightCollapsed(true)}
                aria-label="折叠项目列表"
                title="折叠项目列表"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <div className="flex h-full flex-col items-center justify-center text-center text-text-secondary">
                <FolderKanban className="mb-2 h-8 w-8 opacity-40" />
                <p className="text-xs">暂无项目</p>
                <p className="mt-1 text-[11px] leading-relaxed">阶段6 将接入本地项目能力</p>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function MessageBubble({ message }: { readonly message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-surface-secondary text-text',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
