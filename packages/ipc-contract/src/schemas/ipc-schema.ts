/**
 * @urchin/ipc-contract · zod schema 单一真源
 *
 * 依据：契约 B §3 ipcSchema
 * 命名规则：`<域>.<动作>`，例如 `tab.create` / `tab.close`。
 * 每个调用含 req（入参）与 res（出参）双向 zod 校验，
 * 防 AI 协作 schema 漂移（agents.md §六 项目特化审查点）。
 */
import { z } from 'zod';

// ============================================================================
// 基础类型
// ============================================================================

/** TabId：单调递增正整数，主进程分配。 */
export const tabIdSchema = z.number().int().positive();
export type TabId = z.infer<typeof tabIdSchema>;

/** WindowId：主进程分配的窗口标识。 */
export const windowIdSchema = z.number().int().positive();
export type WindowId = z.infer<typeof windowIdSchema>;

/** URL 字符串：非空，长度上限 8192（防止异常输入）。 */
export const urlSchema = z.string().min(1).max(8192);
export type Url = z.infer<typeof urlSchema>;

/** 标题字符串：允许空字符串，长度上限 4096。 */
export const titleSchema = z.string().max(4096);
export type Title = z.infer<typeof titleSchema>;

// ============================================================================
// Tab 域
// ============================================================================

/** Tab 快照：渲染层 store 镜像的最小完整状态。 */
export const tabSnapshotSchema = z.object({
  id: tabIdSchema,
  windowId: windowIdSchema,
  url: urlSchema,
  title: titleSchema.default(''),
  favicon: z.string().optional(),
  active: z.boolean().default(false),
  loading: z.boolean().default(false),
  canGoBack: z.boolean().default(false),
  canGoForward: z.boolean().default(false),
  crashed: z.boolean().default(false),
  indexInWindow: z.number().int().nonnegative().default(0),
});
export type TabSnapshot = z.infer<typeof tabSnapshotSchema>;

export const tabCreateReqSchema = z.object({
  windowId: windowIdSchema,
  url: urlSchema.default('about:blank'),
  active: z.boolean().default(true),
  index: z.number().int().nonnegative().optional(),
});
export type TabCreateReq = z.infer<typeof tabCreateReqSchema>;

export const tabCreateResSchema = z.object({
  tab: tabSnapshotSchema,
});
export type TabCreateRes = z.infer<typeof tabCreateResSchema>;

export const tabCloseReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabCloseReq = z.infer<typeof tabCloseReqSchema>;

export const tabCloseResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
});
export type TabCloseRes = z.infer<typeof tabCloseResSchema>;

export const tabListReqSchema = z.object({
  windowId: windowIdSchema.optional(),
});
export type TabListReq = z.infer<typeof tabListReqSchema>;

export const tabListResSchema = z.object({
  tabs: z.array(tabSnapshotSchema),
});
export type TabListRes = z.infer<typeof tabListResSchema>;

export const tabSetActiveReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabSetActiveReq = z.infer<typeof tabSetActiveReqSchema>;

export const tabSetActiveResSchema = z.object({
  tab: tabSnapshotSchema,
});
export type TabSetActiveRes = z.infer<typeof tabSetActiveResSchema>;

export const tabReloadReqSchema = z.object({
  tabId: tabIdSchema,
  ignoreCache: z.boolean().default(false),
});
export type TabReloadReq = z.infer<typeof tabReloadReqSchema>;

export const tabReloadResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
});
export type TabReloadRes = z.infer<typeof tabReloadResSchema>;

export const tabGoBackReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabGoBackReq = z.infer<typeof tabGoBackReqSchema>;

export const tabGoBackResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
});
export type TabGoBackRes = z.infer<typeof tabGoBackResSchema>;

export const tabGoForwardReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabGoForwardReq = z.infer<typeof tabGoForwardReqSchema>;

export const tabGoForwardResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
});
export type TabGoForwardRes = z.infer<typeof tabGoForwardResSchema>;

export const tabLoadUrlReqSchema = z.object({
  tabId: tabIdSchema,
  url: urlSchema,
});
export type TabLoadUrlReq = z.infer<typeof tabLoadUrlReqSchema>;

export const tabLoadUrlResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
  url: urlSchema,
});
export type TabLoadUrlRes = z.infer<typeof tabLoadUrlResSchema>;

export const tabStopReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabStopReq = z.infer<typeof tabStopReqSchema>;

export const tabStopResSchema = z.object({
  ok: z.literal(true),
  tabId: tabIdSchema,
});
export type TabStopRes = z.infer<typeof tabStopResSchema>;

// ============================================================================
// Window 域
// ============================================================================

export const windowCreateReqSchema = z.object({
  url: urlSchema.optional(),
  incognito: z.boolean().default(false),
});
export type WindowCreateReq = z.infer<typeof windowCreateReqSchema>;

export const windowCreateResSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowCreateRes = z.infer<typeof windowCreateResSchema>;

export const windowCloseReqSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowCloseReq = z.infer<typeof windowCloseReqSchema>;

export const windowCloseResSchema = z.object({
  ok: z.literal(true),
});
export type WindowCloseRes = z.infer<typeof windowCloseResSchema>;

// ============================================================================
// M6 History
// ============================================================================

export const historyEntrySchema = z.object({
  id: z.number().int().positive(),
  url: urlSchema,
  title: titleSchema,
  visitedAt: z.number().int().nonnegative(),
  visitCount: z.number().int().nonnegative(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyRecordReqSchema = z.object({
  url: urlSchema,
  title: titleSchema.optional(),
});
export type HistoryRecordReq = z.infer<typeof historyRecordReqSchema>;

export const historyRecordResSchema = z.object({
  ok: z.literal(true),
  entry: historyEntrySchema,
});
export type HistoryRecordRes = z.infer<typeof historyRecordResSchema>;

export const historySearchReqSchema = z.object({
  query: z.string().min(1).max(512),
  limit: z.number().int().positive().max(100).optional(),
});
export type HistorySearchReq = z.infer<typeof historySearchReqSchema>;

export const historySearchResSchema = z.object({
  entries: z.array(historyEntrySchema),
});
export type HistorySearchRes = z.infer<typeof historySearchResSchema>;

export const historyListReqSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type HistoryListReq = z.infer<typeof historyListReqSchema>;

export const historyListResSchema = z.object({
  entries: z.array(historyEntrySchema),
  total: z.number().int().nonnegative(),
});
export type HistoryListRes = z.infer<typeof historyListResSchema>;

export const historyDeleteReqSchema = z.object({
  id: z.number().int().positive(),
});
export type HistoryDeleteReq = z.infer<typeof historyDeleteReqSchema>;

export const historyDeleteResSchema = z.object({
  ok: z.literal(true),
  id: z.number().int().positive(),
});
export type HistoryDeleteRes = z.infer<typeof historyDeleteResSchema>;

export const historyClearReqSchema = z.object({});
export type HistoryClearReq = z.infer<typeof historyClearReqSchema>;

export const historyClearResSchema = z.object({
  ok: z.literal(true),
  deleted: z.number().int().nonnegative(),
});
export type HistoryClearRes = z.infer<typeof historyClearResSchema>;

// ============================================================================
// M5 Bookmarks
// ============================================================================

export const bookmarkTypeSchema = z.enum(['bookmark', 'folder']);
export type BookmarkType = z.infer<typeof bookmarkTypeSchema>;

export const bookmarkSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  url: urlSchema.optional(),
  title: titleSchema,
  type: bookmarkTypeSchema,
  position: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Bookmark = z.infer<typeof bookmarkSchema>;

export const bookmarkCreateReqSchema = z.object({
  url: urlSchema.optional(),
  title: titleSchema,
  parentId: z.string().nullable().optional(),
  type: bookmarkTypeSchema.optional(),
});
export type BookmarkCreateReq = z.infer<typeof bookmarkCreateReqSchema>;

export const bookmarkCreateResSchema = z.object({
  bookmark: bookmarkSchema,
});
export type BookmarkCreateRes = z.infer<typeof bookmarkCreateResSchema>;

export const bookmarkListReqSchema = z.object({
  parentId: z.string().nullable().optional(),
});
export type BookmarkListReq = z.infer<typeof bookmarkListReqSchema>;

export const bookmarkListResSchema = z.object({
  bookmarks: z.array(bookmarkSchema),
});
export type BookmarkListRes = z.infer<typeof bookmarkListResSchema>;

export const bookmarkSearchReqSchema = z.object({
  query: z.string().min(1).max(512),
  limit: z.number().int().positive().max(100).optional(),
});
export type BookmarkSearchReq = z.infer<typeof bookmarkSearchReqSchema>;

export const bookmarkSearchResSchema = z.object({
  bookmarks: z.array(bookmarkSchema),
});
export type BookmarkSearchRes = z.infer<typeof bookmarkSearchResSchema>;

export const bookmarkDeleteReqSchema = z.object({
  id: z.string().min(1),
});
export type BookmarkDeleteReq = z.infer<typeof bookmarkDeleteReqSchema>;

export const bookmarkDeleteResSchema = z.object({
  ok: z.literal(true),
  id: z.string().min(1),
});
export type BookmarkDeleteRes = z.infer<typeof bookmarkDeleteResSchema>;

// ============================================================================
// M7 Settings
// ============================================================================

export const settingKeySchema = z.string().min(1).max(256);
export type SettingKey = z.infer<typeof settingKeySchema>;

export const settingValueSchema = z.unknown();
export type SettingValue = z.infer<typeof settingValueSchema>;

export const settingEntrySchema = z.object({
  key: settingKeySchema,
  value: settingValueSchema,
});
export type SettingEntry = z.infer<typeof settingEntrySchema>;

export const settingsGetReqSchema = z.object({
  key: settingKeySchema,
});
export type SettingsGetReq = z.infer<typeof settingsGetReqSchema>;

export const settingsGetResSchema = z.object({
  value: settingValueSchema.nullable(),
});
export type SettingsGetRes = z.infer<typeof settingsGetResSchema>;

export const settingsSetReqSchema = z.object({
  key: settingKeySchema,
  value: settingValueSchema,
});
export type SettingsSetReq = z.infer<typeof settingsSetReqSchema>;

export const settingsSetResSchema = z.object({
  ok: z.literal(true),
});
export type SettingsSetRes = z.infer<typeof settingsSetResSchema>;

export const settingsGetAllReqSchema = z.object({});
export type SettingsGetAllReq = z.infer<typeof settingsGetAllReqSchema>;

export const settingsGetAllResSchema = z.object({
  entries: z.array(settingEntrySchema),
});
export type SettingsGetAllRes = z.infer<typeof settingsGetAllResSchema>;

// ============================================================================
// UI Layout (SidePanels state)
// ============================================================================

export const uiLayoutSetStateReqSchema = z.object({
  leftWidth: z.number().int().min(0).max(400).optional(),
  rightWidth: z.number().int().min(0).max(600).optional(),
  bottomHeight: z.number().int().min(0).max(200).optional(),
  /** 内容区 BrowserView 是否隐藏（AI 模式下为 true） */
  contentHidden: z.boolean().optional(),
  /** 临时隐藏 BrowserView（如收藏夹面板弹出时），避免 BrowserView 遮挡 React 渲染的弹出层。
   *  Electron BrowserView 始终渲染在主窗口 webContents 之上，不隐藏则弹出层被遮挡且不可点击。 */
  browserViewHidden: z.boolean().optional(),
});
export type UiLayoutSetStateReq = z.infer<typeof uiLayoutSetStateReqSchema>;

export const uiLayoutSetStateResSchema = z.object({
  leftWidth: z.number().int(),
  rightWidth: z.number().int(),
  bottomHeight: z.number().int(),
  contentHidden: z.boolean(),
  browserViewHidden: z.boolean(),
});
export type UiLayoutSetStateRes = z.infer<typeof uiLayoutSetStateResSchema>;

/**
 * ui.theme.set：主题切换通知主进程。
 *
 * 渲染层 ThemeProvider 切换主题时调用，主进程据此设置 nativeTheme.themeSource：
 * - 窗口标题栏（Windows 标题栏/边框）跟随主题
 * - 支持 prefers-color-scheme 的网页（BrowserView）跟随主题（Chrome 深色模式行为）
 */
export const uiThemeSetReqSchema = z.object({
  theme: z.enum(['light', 'dark']),
});
export type UiThemeSetReq = z.infer<typeof uiThemeSetReqSchema>;

export const uiThemeSetResSchema = z.object({
  ok: z.literal(true),
});
export type UiThemeSetRes = z.infer<typeof uiThemeSetResSchema>;

// ============================================================================
// 收藏夹悬浮面板（独立子窗口，悬浮于网页之上）
// ============================================================================

/**
 * ui.panel.toggle：开/关收藏夹悬浮面板。
 *
 * 2026-08-14 设计：收藏夹面板是 frameless 子窗口（悬浮层），由下往上弹出、
 * 悬浮在主窗口网页 BrowserView 之上，只覆盖右下角弹窗面积。
 * 子窗口天然层级置顶（BrowserWindow 始终在 BrowserView 之上），
 * 且复用主窗口 preload（urchin:// 协议下暴露 window.urchin.invoke）。
 */
export const uiPanelToggleReqSchema = z.object({}).default({});
export type UiPanelToggleReq = z.infer<typeof uiPanelToggleReqSchema>;

export const uiPanelToggleResSchema = z.object({
  /** 切换后的面板开合状态 */
  open: z.boolean(),
});
export type UiPanelToggleRes = z.infer<typeof uiPanelToggleResSchema>;

// ============================================================================
// M23 Download Manager
// ============================================================================

export const downloadIdSchema = z.string().min(1);
export type DownloadId = z.infer<typeof downloadIdSchema>;

export const downloadStateSchema = z.enum([
  'progressing',
  'completed',
  'cancelled',
  'interrupted',
  'paused',
]);
export type DownloadState = z.infer<typeof downloadStateSchema>;

export const downloadItemSchema = z.object({
  id: downloadIdSchema,
  filename: z.string().min(1),
  url: urlSchema,
  state: downloadStateSchema,
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  savePath: z.string(),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});
export type DownloadItem = z.infer<typeof downloadItemSchema>;

export const downloadListReqSchema = z.object({});
export type DownloadListReq = z.infer<typeof downloadListReqSchema>;

export const downloadListResSchema = z.object({
  downloads: z.array(downloadItemSchema),
});
export type DownloadListRes = z.infer<typeof downloadListResSchema>;

export const downloadCancelReqSchema = z.object({
  id: downloadIdSchema,
});
export type DownloadCancelReq = z.infer<typeof downloadCancelReqSchema>;

export const downloadCancelResSchema = z.object({
  ok: z.literal(true),
  id: downloadIdSchema,
});
export type DownloadCancelRes = z.infer<typeof downloadCancelResSchema>;

export const downloadPauseReqSchema = z.object({
  id: downloadIdSchema,
});
export type DownloadPauseReq = z.infer<typeof downloadPauseReqSchema>;

export const downloadPauseResSchema = z.object({
  ok: z.literal(true),
  id: downloadIdSchema,
});
export type DownloadPauseRes = z.infer<typeof downloadPauseResSchema>;

export const downloadResumeReqSchema = z.object({
  id: downloadIdSchema,
});
export type DownloadResumeReq = z.infer<typeof downloadResumeReqSchema>;

export const downloadResumeResSchema = z.object({
  ok: z.literal(true),
  id: downloadIdSchema,
});
export type DownloadResumeRes = z.infer<typeof downloadResumeResSchema>;

export const downloadClearReqSchema = z.object({
  id: downloadIdSchema.optional(),
});
export type DownloadClearReq = z.infer<typeof downloadClearReqSchema>;

export const downloadClearResSchema = z.object({
  ok: z.literal(true),
  deleted: z.number().int().nonnegative(),
});
export type DownloadClearRes = z.infer<typeof downloadClearResSchema>;

// ============================================================================
// Dialog 域（原生对话框：目录选择器）
// ============================================================================

export const dialogSelectDirectoryReqSchema = z.object({
  title: z.string().max(256).optional(),
});
export type DialogSelectDirectoryReq = z.infer<typeof dialogSelectDirectoryReqSchema>;

export const dialogSelectDirectoryResSchema = z.object({
  /** 选中的目录路径，用户取消时为 null */
  path: z.string().nullable(),
});
export type DialogSelectDirectoryRes = z.infer<typeof dialogSelectDirectoryResSchema>;

// ============================================================================
// AI 域（W4：M13 Side Panel + M11 Orchestrator UI 接线）
// ============================================================================

/** 对话消息角色 */
const messageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/** 对话消息 */
const chatMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.string().max(1_000_000),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** 会话 ID：非空字符串 */
const conversationIdSchema = z.string().min(1).max(256);
export type ConversationId = z.infer<typeof conversationIdSchema>;

/** Provider ID：非空字符串 */
const providerIdSchema = z.string().min(1).max(128);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** ai.chat.start：启动一次 AI 对话（流式） */
export const aiChatStartReqSchema = z.object({
  providerId: providerIdSchema,
  conversationId: conversationIdSchema.optional(),
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().min(1).max(128),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  stream: z.literal(true).default(true),
});
export type AiChatStartReq = z.infer<typeof aiChatStartReqSchema>;

export const aiChatStartResSchema = z.object({
  conversationId: conversationIdSchema,
});
export type AiChatStartRes = z.infer<typeof aiChatStartResSchema>;

/** ai.chat.abort：中止进行中的流式对话 */
export const aiChatAbortReqSchema = z.object({
  conversationId: conversationIdSchema,
});
export type AiChatAbortReq = z.infer<typeof aiChatAbortReqSchema>;

export const aiChatAbortResSchema = z.object({
  ok: z.literal(true),
  conversationId: conversationIdSchema,
});
export type AiChatAbortRes = z.infer<typeof aiChatAbortResSchema>;

/**
 * ai.agent.start：启动一次 Agent 模式对话（pi 适配层，带工具能力）。
 *
 * 与 ai.chat.start 的区别：
 * - 使用 pi 的 Agent 实例（createPiAgent），支持工具调用循环（bash/read/edit/write）
 * - 工具执行事件通过 stream.chunk 提示性输出
 * - 流式输出格式与 ai.chat.start 一致（StreamMessage），渲染层无需改动
 *
 * 设计依据：方案 A（直接 import coding-agent/tools）+ ADR-008 v0.1 范围
 */
export const aiAgentStartReqSchema = z.object({
  providerId: providerIdSchema,
  conversationId: conversationIdSchema.optional(),
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().min(1).max(128),
  /** 是否启用 coding 工具（bash/read/edit/write），默认 false */
  enableTools: z.boolean().default(false),
  /** 工作目录（启用工具时必填） */
  cwd: z.string().max(1024).optional(),
  /** 可选 Base URL（OpenAI 兼容端点覆盖） */
  baseUrl: z.string().max(2048).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  stream: z.literal(true).default(true),
});
export type AiAgentStartReq = z.infer<typeof aiAgentStartReqSchema>;

export const aiAgentStartResSchema = z.object({
  conversationId: conversationIdSchema,
});
export type AiAgentStartRes = z.infer<typeof aiAgentStartResSchema>;

/** ai.agent.abort：中止进行中的 Agent 对话（复用 ai.chat.abort 的 schema 结构） */
export const aiAgentAbortReqSchema = z.object({
  conversationId: conversationIdSchema,
});
export type AiAgentAbortReq = z.infer<typeof aiAgentAbortReqSchema>;

export const aiAgentAbortResSchema = z.object({
  ok: z.literal(true),
  conversationId: conversationIdSchema,
});
export type AiAgentAbortRes = z.infer<typeof aiAgentAbortResSchema>;

/**
 * pi.providers：列出 pi 内置 Provider 元信息（方案 A 适配层）
 *
 * 与 provider.list 不同，本通道返回 pi 仓库内置的 39 个 provider 的静态元信息
 * （id/name/baseUrl/apiKeyEnvVar），用于 pi 设置对话框的 provider 下拉选择。
 * 不涉及 Urchin 自身的 Provider 子进程注册表。
 */
export const piProvidersReqSchema = z.object({}).default({});
export type PiProvidersReq = z.infer<typeof piProvidersReqSchema>;

/** pi 内置 Provider 元信息 */
export const piProviderInfoSchema = z.object({
  /** Provider ID（如 'openai' / 'anthropic'） */
  id: z.string().min(1).max(64),
  /** 显示名（如 'OpenAI' / 'Anthropic'） */
  name: z.string().min(1).max(128),
  /** 默认 Base URL（如 'https://api.openai.com/v1'） */
  baseUrl: z.string().max(2048).optional(),
  /** 推荐 API Key 环境变量名（如 'OPENAI_API_KEY'），用于 UI 提示 */
  apiKeyEnvVar: z.string().max(64).optional(),
  /** 是否支持 OAuth（如 anthropic 支持 Claude Pro/Max 订阅） */
  supportsOAuth: z.boolean().default(false),
});
export type PiProviderInfo = z.infer<typeof piProviderInfoSchema>;

export const piProvidersResSchema = z.object({
  providers: z.array(piProviderInfoSchema),
  /** 数据生成时间戳（pi 内置目录的生成时间） */
  generatedAt: z.number().int().optional(),
});
export type PiProvidersRes = z.infer<typeof piProvidersResSchema>;

// ============================================================================
// ai.screenshot / ai.uploadFile / ai.setWorkdir —— pi 模块前端加号菜单三项
// ============================================================================

/** 截图请求：无参数，主进程调用 desktopCapturer 截取全屏 */
export const aiScreenshotReqSchema = z.object({}).default({});
export type AiScreenshotReq = z.infer<typeof aiScreenshotReqSchema>;

/** 截图响应：返回 base64 编码的 PNG 图片数据（含 MIME 前缀，可直接用于 data URI） */
export const aiScreenshotResSchema = z.object({
  /** data URI 格式：data:image/png;base64,xxxx */
  dataUri: z.string().min(1),
  /** 图片 MIME 类型，如 image/png */
  mimeType: z.string().min(1),
  /** 原始 base64 数据（不含 data: 前缀），便于构造 ImageContent */
  base64: z.string().min(1),
  /** 截图来源显示器名称 */
  displayId: z.string().optional(),
});
export type AiScreenshotRes = z.infer<typeof aiScreenshotResSchema>;

/** 上传文件请求：弹出原生文件选择器，返回所选文件内容 */
export const aiUploadFileReqSchema = z
  .object({
    /** 文件选择器标题 */
    title: z.string().max(256).optional(),
    /** 允许的扩展名（不含点，如 ['png','jpg','txt']）。空数组或不传表示不限制 */
    filters: z.array(z.string().max(32)).default([]),
    /** 是否允许多选 */
    multiple: z.boolean().default(false),
  })
  .default({});
export type AiUploadFileReq = z.infer<typeof aiUploadFileReqSchema>;

/** 单个文件信息 */
export const aiFileInfoSchema = z.object({
  /** 文件名（不含路径） */
  name: z.string().min(1).max(256),
  /** 文件绝对路径 */
  path: z.string().min(1).max(2048),
  /** 文件大小（字节） */
  size: z.number().int().nonnegative(),
  /** MIME 类型（通过 magic-byte 嗅探或扩展名推断） */
  mimeType: z.string().min(1).max(128),
  /** base64 编码的文件内容（图片类直接构造 ImageContent；文本类可选展示） */
  base64: z.string(),
  /** 是否为图片（image/*） */
  isImage: z.boolean(),
});
export type AiFileInfo = z.infer<typeof aiFileInfoSchema>;

/** 上传文件响应 */
export const aiUploadFileResSchema = z.object({
  files: z.array(aiFileInfoSchema),
});
export type AiUploadFileRes = z.infer<typeof aiUploadFileResSchema>;

/** 设置工作目录请求：弹出原生目录选择器 */
export const aiSetWorkdirReqSchema = z
  .object({
    /** 目录选择器标题 */
    title: z.string().max(256).optional(),
  })
  .default({});
export type AiSetWorkdirReq = z.infer<typeof aiSetWorkdirReqSchema>;

/** 设置工作目录响应 */
export const aiSetWorkdirResSchema = z.object({
  /** 选中的目录绝对路径，用户取消时为 null */
  path: z.string().max(2048).nullable(),
  /** 目录是否存在 */
  exists: z.boolean(),
  /** 目录下的条目数（用于提示用户） */
  entryCount: z.number().int().nonnegative().optional(),
});
export type AiSetWorkdirRes = z.infer<typeof aiSetWorkdirResSchema>;

/** Provider 鉴权方式（与 ai-provider-contract AuthMethod 对齐） */
const authMethodSchema = z.enum(['api_key', 'oauth', 'none', 'local']);
export type AuthMethod = z.infer<typeof authMethodSchema>;

/** Provider 信息（序列化给渲染层） */
const providerInfoSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  apiVersion: z.string().min(1).max(32),
  capabilities: z.array(z.string()).default([]),
  authMethod: authMethodSchema.default('api_key'),
  rateLimit: z
    .object({
      requestsPerMin: z.number().int().positive(),
      tokensPerMin: z.number().int().positive().optional(),
    })
    .optional(),
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

/** provider.list：列出所有已注册 Provider */
export const providerListReqSchema = z.object({}).default({});
export type ProviderListReq = z.infer<typeof providerListReqSchema>;

export const providerListResSchema = z.object({
  providers: z.array(providerInfoSchema),
});
export type ProviderListRes = z.infer<typeof providerListResSchema>;

/** provider.rescan：重新扫描 providers 目录，返回扫描结果 */
export const providerRescanReqSchema = z.object({}).default({});
export type ProviderRescanReq = z.infer<typeof providerRescanReqSchema>;

export const providerRescanResSchema = z.object({
  count: z.number().int(),
  providers: z.array(providerInfoSchema),
});
export type ProviderRescanRes = z.infer<typeof providerRescanResSchema>;

/**
 * provider.config.get：读取 Provider 用户配置（W5-D2）。
 *
 * 配置存储在 ai.db 的 settings 表，key = `provider_config:<id>`。
 * 返回 null 表示未配置。
 */
export const providerConfigGetReqSchema = z.object({
  providerId: providerIdSchema,
});
export type ProviderConfigGetReq = z.infer<typeof providerConfigGetReqSchema>;

export const providerConfigGetResSchema = z.object({
  providerId: providerIdSchema,
  config: z.unknown().nullable(),
});
export type ProviderConfigGetRes = z.infer<typeof providerConfigGetResSchema>;

/** provider.config.set：写入 Provider 用户配置 */
export const providerConfigSetReqSchema = z.object({
  providerId: providerIdSchema,
  config: z.unknown(),
});
export type ProviderConfigSetReq = z.infer<typeof providerConfigSetReqSchema>;

export const providerConfigSetResSchema = z.object({
  ok: z.literal(true),
  providerId: providerIdSchema,
});
export type ProviderConfigSetRes = z.infer<typeof providerConfigSetResSchema>;

/** ai.chat.port 事件 payload（MessagePort 下发，非 RPC） */
export const aiChatPortEventSchema = z.object({
  conversationId: conversationIdSchema,
  providerId: providerIdSchema,
});
export type AiChatPortEvent = z.infer<typeof aiChatPortEventSchema>;

// ============================================================================
// W5-D4：Provider 事件推送（单向事件，非 RPC）
// ============================================================================

/**
 * Provider 事件类型（W5-D4）。
 *
 * 通过 `webContents.send('provider:event', payload)` 推送给渲染进程，
 * 用于 UI 显示 Provider 状态变更 / crash warning banner。
 */
export const providerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state-changed'),
    providerId: providerIdSchema,
    /** Provider 运行时状态 */
    state: z.enum(['initializing', 'ready', 'crashed', 'disposed']),
  }),
  z.object({
    type: z.literal('crashed'),
    providerId: providerIdSchema,
    /** crash 原因（心跳超时 / 异常退出等） */
    reason: z.string(),
  }),
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;

/** provider:event 事件通道名 */
export const PROVIDER_EVENT_CHANNEL = 'provider:event';

// ============================================================================
// M14 Page Context Extractor（W4-D4 demo）
// ============================================================================

/** 抽取方法 */
export const extractionMethodSchema = z.enum(['readability', 'dom-simplified', 'raw-text']);
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;

/** 抽取出的页面上下文（契约 F §3 ExtractedPageContext） */
export const extractedPageContextSchema = z.object({
  url: urlSchema,
  title: titleSchema,
  extractedAt: z.string().min(1),
  byline: z.string().optional(),
  excerpt: z.string().optional(),
  textContent: z.string(),
  markdown: z.string(),
  length: z.number().int().nonnegative(),
  language: z.string().optional(),
  siteName: z.string().optional(),
  extraction_method: extractionMethodSchema,
  warnings: z.array(z.string()).default([]),
});
export type ExtractedPageContext = z.infer<typeof extractedPageContextSchema>;

/** page.extract：抽取当前激活 tab 的页面正文 */
export const pageExtractReqSchema = z.object({
  tabId: tabIdSchema,
  /** 最大字符数（PC3 默认 50_000） */
  maxLength: z.number().int().positive().max(200_000).optional(),
});
export type PageExtractReq = z.infer<typeof pageExtractReqSchema>;

export const pageExtractResSchema = z.object({
  context: extractedPageContextSchema,
});
export type PageExtractRes = z.infer<typeof pageExtractResSchema>;

// ============================================================================
// Summary 域（摘要 Agent · 与 pi 模块隔离的独立 AI 助手）
// ============================================================================

/** 目录树节点：目录或文件（递归类型，需显式标注 ZodType 以避免循环推断失败） */
export interface SummaryTreeNode {
  readonly type: 'directory' | 'file';
  readonly name: string;
  readonly relativePath: string;
  readonly children?: readonly SummaryTreeNode[];
  readonly absolutePath?: string;
  readonly size?: number;
  readonly modifiedAt?: number;
}

export const summaryTreeNodeSchema: z.ZodType<SummaryTreeNode> = z.object({
  type: z.enum(['directory', 'file']),
  name: z.string(),
  relativePath: z.string(),
  children: z
    .lazy(() => summaryTreeNodeSchema)
    .array()
    .readonly()
    .optional(),
  absolutePath: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().nonnegative().optional(),
});

/** summary.listTree：列出保存目录下的文档目录树 */
export const summaryListTreeReqSchema = z.object({});
export type SummaryListTreeReq = z.infer<typeof summaryListTreeReqSchema>;

export const summaryListTreeResSchema = z.object({
  tree: z.array(summaryTreeNodeSchema),
  /** 保存根目录绝对路径（用于 UI 显示） */
  rootPath: z.string(),
});
export type SummaryListTreeRes = z.infer<typeof summaryListTreeResSchema>;

/** summary.run：对指定 tab 执行摘要生成 */
export const summaryRunReqSchema = z.object({
  tabId: tabIdSchema,
});
export type SummaryRunReq = z.infer<typeof summaryRunReqSchema>;

export const summaryRunResSchema = z.object({
  /** 保存的文件绝对路径 */
  filePath: z.string(),
  /** 相对于保存根目录的路径 */
  relativePath: z.string(),
  /** 文档标题 */
  documentTitle: z.string(),
});
export type SummaryRunRes = z.infer<typeof summaryRunResSchema>;

/** summary.open：在浏览器中打开已保存的摘要文档 */
export const summaryOpenReqSchema = z.object({
  /** 文件绝对路径 */
  absolutePath: z.string().min(1),
});
export type SummaryOpenReq = z.infer<typeof summaryOpenReqSchema>;

export const summaryOpenResSchema = z.object({
  ok: z.literal(true),
  /** 打开的 tab ID */
  tabId: tabIdSchema,
});
export type SummaryOpenRes = z.infer<typeof summaryOpenResSchema>;

/** summary.delete：删除已保存的摘要文档 */
export const summaryDeleteReqSchema = z.object({
  absolutePath: z.string().min(1),
});
export type SummaryDeleteReq = z.infer<typeof summaryDeleteReqSchema>;

export const summaryDeleteResSchema = z.object({
  ok: z.literal(true),
  absolutePath: z.string(),
});
export type SummaryDeleteRes = z.infer<typeof summaryDeleteResSchema>;

// ============================================================================
// IPC Schema 总表
// ============================================================================

/**
 * ipcSchema：所有 RPC 通道的单一真源。
 * key = channel 名（`<域>.<动作>`），value = { req, res } zod schema。
 * 扩展新通道时在此追加，自动通过 TypeScript 推导获得类型化 invoke。
 */
export const ipcSchema = {
  'tab.create': { req: tabCreateReqSchema, res: tabCreateResSchema },
  'tab.close': { req: tabCloseReqSchema, res: tabCloseResSchema },
  'tab.list': { req: tabListReqSchema, res: tabListResSchema },
  'tab.setActive': { req: tabSetActiveReqSchema, res: tabSetActiveResSchema },
  'tab.reload': { req: tabReloadReqSchema, res: tabReloadResSchema },
  'tab.goBack': { req: tabGoBackReqSchema, res: tabGoBackResSchema },
  'tab.goForward': { req: tabGoForwardReqSchema, res: tabGoForwardResSchema },
  'tab.loadUrl': { req: tabLoadUrlReqSchema, res: tabLoadUrlResSchema },
  'tab.stop': { req: tabStopReqSchema, res: tabStopResSchema },
  'window.create': { req: windowCreateReqSchema, res: windowCreateResSchema },
  'window.close': { req: windowCloseReqSchema, res: windowCloseResSchema },
  'history.record': { req: historyRecordReqSchema, res: historyRecordResSchema },
  'history.search': { req: historySearchReqSchema, res: historySearchResSchema },
  'history.list': { req: historyListReqSchema, res: historyListResSchema },
  'history.delete': { req: historyDeleteReqSchema, res: historyDeleteResSchema },
  'history.clear': { req: historyClearReqSchema, res: historyClearResSchema },
  'bookmark.create': { req: bookmarkCreateReqSchema, res: bookmarkCreateResSchema },
  'bookmark.list': { req: bookmarkListReqSchema, res: bookmarkListResSchema },
  'bookmark.search': { req: bookmarkSearchReqSchema, res: bookmarkSearchResSchema },
  'bookmark.delete': { req: bookmarkDeleteReqSchema, res: bookmarkDeleteResSchema },
  'settings.get': { req: settingsGetReqSchema, res: settingsGetResSchema },
  'settings.set': { req: settingsSetReqSchema, res: settingsSetResSchema },
  'settings.getAll': { req: settingsGetAllReqSchema, res: settingsGetAllResSchema },
  'ui.layout.setState': { req: uiLayoutSetStateReqSchema, res: uiLayoutSetStateResSchema },
  'ui.panel.toggle': { req: uiPanelToggleReqSchema, res: uiPanelToggleResSchema },
  'ui.theme.set': { req: uiThemeSetReqSchema, res: uiThemeSetResSchema },
  'download.list': { req: downloadListReqSchema, res: downloadListResSchema },
  'download.cancel': { req: downloadCancelReqSchema, res: downloadCancelResSchema },
  'download.pause': { req: downloadPauseReqSchema, res: downloadPauseResSchema },
  'download.resume': { req: downloadResumeReqSchema, res: downloadResumeResSchema },
  'download.clear': { req: downloadClearReqSchema, res: downloadClearResSchema },
  'dialog.selectDirectory': {
    req: dialogSelectDirectoryReqSchema,
    res: dialogSelectDirectoryResSchema,
  },
  'ai.chat.start': { req: aiChatStartReqSchema, res: aiChatStartResSchema },
  'ai.chat.abort': { req: aiChatAbortReqSchema, res: aiChatAbortResSchema },
  'ai.agent.start': { req: aiAgentStartReqSchema, res: aiAgentStartResSchema },
  'ai.agent.abort': { req: aiAgentAbortReqSchema, res: aiAgentAbortResSchema },
  'pi.providers': { req: piProvidersReqSchema, res: piProvidersResSchema },
  'ai.screenshot': { req: aiScreenshotReqSchema, res: aiScreenshotResSchema },
  'ai.uploadFile': { req: aiUploadFileReqSchema, res: aiUploadFileResSchema },
  'ai.setWorkdir': { req: aiSetWorkdirReqSchema, res: aiSetWorkdirResSchema },
  'provider.list': { req: providerListReqSchema, res: providerListResSchema },
  'provider.rescan': { req: providerRescanReqSchema, res: providerRescanResSchema },
  'provider.config.get': { req: providerConfigGetReqSchema, res: providerConfigGetResSchema },
  'provider.config.set': { req: providerConfigSetReqSchema, res: providerConfigSetResSchema },
  'page.extract': { req: pageExtractReqSchema, res: pageExtractResSchema },
  // Summary 域（摘要 Agent · 与 pi 模块隔离）
  'summary.listTree': { req: summaryListTreeReqSchema, res: summaryListTreeResSchema },
  'summary.run': { req: summaryRunReqSchema, res: summaryRunResSchema },
  'summary.open': { req: summaryOpenReqSchema, res: summaryOpenResSchema },
  'summary.delete': { req: summaryDeleteReqSchema, res: summaryDeleteResSchema },
} as const;

/** IPC schema 的类型推导工具：取 channel 名联合。 */
export type IpcChannel = keyof typeof ipcSchema;

/**
 * IPC schema 的类型推导工具：取某 channel 的入参类型（output type）。
 *
 * 用于 Main 端 handler 接收的已 parse 结果——带 default 的字段已被填充为必填。
 */
export type IpcReq<C extends IpcChannel> = z.infer<(typeof ipcSchema)[C]['req']>;

/**
 * IPC schema 的类型推导工具：取某 channel 的入参类型（input type）。
 *
 * 用于客户端 typedInvoke 调用方传参——带 default 的字段可选，
 * 与 zod schema 的运行时 parse 行为一致。
 */
export type IpcReqInput<C extends IpcChannel> = z.input<(typeof ipcSchema)[C]['req']>;

/** IPC schema 的类型推导工具：取某 channel 的出参类型。 */
export type IpcRes<C extends IpcChannel> = z.infer<(typeof ipcSchema)[C]['res']>;
