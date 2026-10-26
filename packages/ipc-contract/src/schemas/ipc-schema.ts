/**
 * @urchin/ipc-contract · zod schema 单一真源
 *
 * 依据：契约 B §3 ipcSchema
 * 命名规则：`<域>.<动作>`，例如 `tab.create` / `tab.close`。
 * 每个调用含 req（入参）与 res（出参）双向 zod 校验，
 * 防 AI 协作 schema 漂移（AGENTS.md §六 项目特化审查点）。
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
// Workspace 域（工作区 = 持久化 session 分区，TP7）
// ============================================================================

/**
 * 工作区 ID：'default'（默认工作区，使用默认 session）或随机 uuid（自定义工作区）。
 * 只允许小写字母/数字/连字符，渲染层只传 id，partition 由主进程解析。
 */
export const workspaceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

/** 默认工作区 ID：对应 session.defaultSession，不可删除（可改名/换色）。 */
export const DEFAULT_WORKSPACE_ID = 'default';

/** 工作区主题色（首字头像/选项卡高亮用，渲染层映射为 Tailwind 色板）。 */
export const workspaceColorSchema = z.enum(['blue', 'green', 'amber', 'rose', 'violet', 'cyan']);
export type WorkspaceColor = z.infer<typeof workspaceColorSchema>;

/** 工作区元数据（非敏感，存 Settings；Cookie/存储由 Chromium 分区自动落盘）。 */
export const workspaceSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().trim().min(1).max(32),
  color: workspaceColorSchema,
  isDefault: z.boolean().default(false),
  createdAt: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

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
  /** 所属工作区（TP7）：决定标签使用的 session 分区（默认 default = 默认 session）。 */
  workspaceId: workspaceIdSchema.default(DEFAULT_WORKSPACE_ID),
  active: z.boolean().default(false),
  loading: z.boolean().default(false),
  canGoBack: z.boolean().default(false),
  canGoForward: z.boolean().default(false),
  crashed: z.boolean().default(false),
  indexInWindow: z.number().int().nonnegative().default(0),
  /** 视图类型（阶段 2 GenOffice 融合）：browser = 网页 BrowserView；
   *  genoffice = GenOffice 编辑器 WebContentsView（地址栏隐藏、脏标记生效）。 */
  viewKind: z.enum(['browser', 'genoffice']).default('browser'),
  /** 编辑器未保存修改标记（仅 genoffice 标签有意义）。 */
  dirty: z.boolean().default(false),
});
export type TabSnapshot = z.infer<typeof tabSnapshotSchema>;

export const tabCreateReqSchema = z.object({
  windowId: windowIdSchema,
  url: urlSchema.default('about:blank'),
  active: z.boolean().default(true),
  index: z.number().int().nonnegative().optional(),
  /** 目标工作区（可选；未传时主进程继承窗口活动标签的工作区，无活动则默认工作区）。 */
  workspaceId: workspaceIdSchema.optional(),
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
  /** 阶段 2：关闭守卫取消时为 false（标签保留）；缺省 true 保持旧契约兼容。 */
  closed: z.boolean().default(true),
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

// 标签页网页快照（工作区总览页缩略图）。dataUrl 为 PNG data URL；抓取失败/空白时返回 null
//（渲染层降级显示 favicon+标题）。缩略图为“display-only hint”，失败不影响功能。
export const tabCaptureThumbnailReqSchema = z.object({
  tabId: tabIdSchema,
});
export type TabCaptureThumbnailReq = z.infer<typeof tabCaptureThumbnailReqSchema>;

export const tabCaptureThumbnailResSchema = z.object({
  tabId: tabIdSchema,
  dataUrl: z.string().nullable(),
});
export type TabCaptureThumbnailRes = z.infer<typeof tabCaptureThumbnailResSchema>;

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

/** 新浏览器窗口打开 URL（侧边栏标签/书签拖出窗口触发）。URL 须为 http/https。
 *  x/y：拖出瞬间的屏幕坐标（窗口左上角定位用，跟随拖拽位置，避免重叠在原窗口）。 */
export const windowCreateWithUrlReqSchema = z.object({
  url: urlSchema,
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  /** 拖出窗口时携带来源标签的工作区（可选；未传则新窗口默认工作区）。 */
  workspaceId: workspaceIdSchema.optional(),
});
export type WindowCreateWithUrlReq = z.infer<typeof windowCreateWithUrlReqSchema>;

export const windowCreateWithUrlResSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowCreateWithUrlRes = z.infer<typeof windowCreateWithUrlResSchema>;

// ============================================================================
// Workspace 域 IPC（工作区 CRUD / 清空数据）
// ============================================================================

export const workspaceListReqSchema = z.object({}).default({});
export type WorkspaceListReq = z.infer<typeof workspaceListReqSchema>;

export const workspaceListResSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceListRes = z.infer<typeof workspaceListResSchema>;

export const workspaceCreateReqSchema = z.object({
  name: workspaceSchema.shape.name,
  color: workspaceColorSchema,
});
export type WorkspaceCreateReq = z.infer<typeof workspaceCreateReqSchema>;

export const workspaceCreateResSchema = z.object({
  workspace: workspaceSchema,
});
export type WorkspaceCreateRes = z.infer<typeof workspaceCreateResSchema>;

export const workspaceUpdateReqSchema = z.object({
  id: workspaceIdSchema,
  name: workspaceSchema.shape.name.optional(),
  color: workspaceColorSchema.optional(),
});
export type WorkspaceUpdateReq = z.infer<typeof workspaceUpdateReqSchema>;

export const workspaceUpdateResSchema = z.object({
  workspace: workspaceSchema,
});
export type WorkspaceUpdateRes = z.infer<typeof workspaceUpdateResSchema>;

export const workspaceRemoveReqSchema = z.object({
  id: workspaceIdSchema,
});
export type WorkspaceRemoveReq = z.infer<typeof workspaceRemoveReqSchema>;

export const workspaceRemoveResSchema = z.object({
  ok: z.literal(true),
});
export type WorkspaceRemoveRes = z.infer<typeof workspaceRemoveResSchema>;

export const workspaceClearDataReqSchema = z.object({
  id: workspaceIdSchema,
});
export type WorkspaceClearDataReq = z.infer<typeof workspaceClearDataReqSchema>;

export const workspaceClearDataResSchema = z.object({
  ok: z.literal(true),
});
export type WorkspaceClearDataRes = z.infer<typeof workspaceClearDataResSchema>;

/** 查询当前渲染进程所属窗口 id（多窗口下渲染层不再硬编码 windowId=1）。 */
export const windowGetCurrentReqSchema = z.object({}).default({});
export type WindowGetCurrentReq = z.infer<typeof windowGetCurrentReqSchema>;

export const windowGetCurrentResSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowGetCurrentRes = z.infer<typeof windowGetCurrentResSchema>;

/** 抓取窗口渲染层（React UI：左右侧栏 + 底部地址栏）截图（PNG data URL）。
 *  工作区总览页把本截图与激活标签网页截图合成为「整个浏览器窗口」快照。
 *  抓取失败/空白时返回 null（调用方降级为占位图，不影响功能）。 */
export const windowCaptureUiReqSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowCaptureUiReq = z.infer<typeof windowCaptureUiReqSchema>;

export const windowCaptureUiResSchema = z.object({
  dataUrl: z.string().nullable(),
});
export type WindowCaptureUiRes = z.infer<typeof windowCaptureUiResSchema>;

export const windowCloseReqSchema = z.object({
  windowId: windowIdSchema,
});
export type WindowCloseReq = z.infer<typeof windowCloseReqSchema>;

export const windowCloseResSchema = z.object({
  ok: z.literal(true),
});
export type WindowCloseRes = z.infer<typeof windowCloseResSchema>;

/** 自绘标题栏窗口控制（frameless 窗口）：最小化当前窗口。
 *  以 IPC sender 反查窗口，渲染层无需传 windowId。 */
export const windowMinimizeReqSchema = z.object({}).default({});
export type WindowMinimizeReq = z.infer<typeof windowMinimizeReqSchema>;

export const windowMinimizeResSchema = z.object({
  ok: z.literal(true),
});
export type WindowMinimizeRes = z.infer<typeof windowMinimizeResSchema>;

/** 切换当前窗口最大化/还原，返回切换后的最大化状态用于同步按钮图标。 */
export const windowToggleMaximizeReqSchema = z.object({}).default({});
export type WindowToggleMaximizeReq = z.infer<typeof windowToggleMaximizeReqSchema>;

export const windowToggleMaximizeResSchema = z.object({
  maximized: z.boolean(),
});
export type WindowToggleMaximizeRes = z.infer<typeof windowToggleMaximizeResSchema>;

/** 查询当前窗口最大化状态（标题栏挂载/resize 时同步图标）。 */
export const windowGetStateReqSchema = z.object({}).default({});
export type WindowGetStateReq = z.infer<typeof windowGetStateReqSchema>;

export const windowGetStateResSchema = z.object({
  maximized: z.boolean(),
});
export type WindowGetStateRes = z.infer<typeof windowGetStateResSchema>;

// ============================================================================
// M6 History
// ============================================================================

export const historyEntrySchema = z.object({
  id: z.number().int().positive(),
  url: urlSchema,
  title: titleSchema,
  /** 主进程缓存的网站图标（urchin://favicon/<hash>）。 */
  favicon: z.string().optional(),
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
  /** 主进程缓存的网站图标（urchin://favicon/<hash>）。 */
  favicon: z.string().optional(),
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

// bookmark.update：重命名书签 / 文件夹（或修改书签 URL；文件夹不可携带 url）。
// title 与 url 至少提供一项（空 patch 无意义且易掩盖调用方 bug）。
export const bookmarkUpdateReqSchema = z
  .object({
    id: z.string().min(1),
    title: titleSchema.optional(),
    url: urlSchema.optional(),
  })
  .refine((req) => req.title !== undefined || req.url !== undefined, {
    message: 'title 与 url 至少提供一项',
  });
export type BookmarkUpdateReq = z.infer<typeof bookmarkUpdateReqSchema>;

export const bookmarkUpdateResSchema = z.object({
  bookmark: bookmarkSchema,
});
export type BookmarkUpdateRes = z.infer<typeof bookmarkUpdateResSchema>;

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
  /** M15 DevTools 检视列宽度（0 = 折叠/未打开）。主进程据此扣减 BrowserView bounds 的水平区域。
   *  v0.2 一期新增（向後兼容的加法字段）。 */
  devtoolsWidth: z.number().int().min(0).max(900).optional(),
});
export type UiLayoutSetStateReq = z.infer<typeof uiLayoutSetStateReqSchema>;

export const uiLayoutSetStateResSchema = z.object({
  leftWidth: z.number().int(),
  rightWidth: z.number().int(),
  bottomHeight: z.number().int(),
  contentHidden: z.boolean(),
  browserViewHidden: z.boolean(),
  devtoolsWidth: z.number().int(),
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

/**
 * ui.window.dragBy：按住侧边栏空白处拖动窗口（相对位移）。
 *
 * 渲染层在拖拽过程中持续发送屏幕坐标增量，主进程移动窗口位置。
 * 手动实现（非 -webkit-app-region）以兼容双击展开/折叠与悬停自动展开（drag region
 * 会吞掉鼠标事件）。
 */
export const uiWindowDragByReqSchema = z.object({
  /** 屏幕坐标 X 增量（px） */
  dx: z.number().int(),
  /** 屏幕坐标 Y 增量（px） */
  dy: z.number().int(),
});
export type UiWindowDragByReq = z.infer<typeof uiWindowDragByReqSchema>;

export const uiWindowDragByResSchema = z.object({
  ok: z.literal(true),
});
export type UiWindowDragByRes = z.infer<typeof uiWindowDragByResSchema>;

// ============================================================================
// 底部悬浮状态栏（独立透明子窗口，悬浮于网页 BrowserView 之上）
// ============================================================================

/**
 * ui.statusbar.*：状态栏悬浮层与主渲染进程之间的状态同步 / 动作转发。
 *
 * 设计：状态栏为独立透明 frameless 子 BrowserWindow（悬浮于网页之上），
 * 状态由主渲染进程持有，经主进程中转：
 * - 主渲染 → 主进程：ui.statusbar.sync 推送状态快照
 * - 悬浮层 → 主进程：ui.statusbar.getState 取缓存状态、ui.statusbar.setExpanded
 *   上报建议/提示展开高度、ui.statusbar.action 转发用户动作
 * - 主进程 → 主渲染：ui.statusbar.action 事件
 * - 主进程 → 悬浮层：ui.statusbar.state 事件
 */
export const statusBarSuggestionSchema = z.object({
  type: z.enum(['history', 'bookmark', 'search-engine']),
  title: z.string(),
  url: z.string(),
  favicon: z.string().optional(),
  matchType: z.enum(['url', 'title', 'exact']),
  score: z.number(),
});
export type StatusBarSuggestion = z.infer<typeof statusBarSuggestionSchema>;

export const statusBarToastSchema = z.object({
  text: z.string().max(2048),
  spinning: z.boolean().optional(),
});
export type StatusBarToast = z.infer<typeof statusBarToastSchema>;

export const statusBarStateSchema = z.object({
  visible: z.boolean(),
  url: z.string().max(16384),
  loading: z.boolean(),
  securityState: z.enum(['secure', 'insecure', 'mixed']),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  reloadDisabled: z.boolean(),
  bookmarkSaved: z.boolean(),
  bookmarkable: z.boolean(),
  summarizeDisabled: z.boolean(),
  screenshotDisabled: z.boolean(),
  translateActive: z.boolean(),
  translateDisabled: z.boolean(),
  searchEngine: z.string(),
  suggestions: z.array(statusBarSuggestionSchema).max(20),
  toast: statusBarToastSchema.nullable(),
  theme: z.enum(['light', 'dark']),
  /** 地址栏是否折叠为悬浮球（由主进程管理，同步给悬浮层） */
  collapsed: z.boolean(),
});
export type StatusBarState = z.infer<typeof statusBarStateSchema>;

export const uiStatusBarSyncReqSchema = statusBarStateSchema;
export type UiStatusBarSyncReq = z.infer<typeof uiStatusBarSyncReqSchema>;
export const uiStatusBarSyncResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarSyncRes = z.infer<typeof uiStatusBarSyncResSchema>;

export const uiStatusBarGetStateReqSchema = z.object({}).default({});
export type UiStatusBarGetStateReq = z.infer<typeof uiStatusBarGetStateReqSchema>;
export const uiStatusBarGetStateResSchema = statusBarStateSchema;
export type UiStatusBarGetStateRes = z.infer<typeof uiStatusBarGetStateResSchema>;

export const uiStatusBarActionReqSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().max(16384) }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('bookmark-toggle') }),
  z.object({ type: z.literal('summarize') }),
  z.object({ type: z.literal('screenshot') }),
  z.object({ type: z.literal('translate') }),
  z.object({ type: z.literal('suggestion-query'), query: z.string().max(2048) }),
  z.object({ type: z.literal('focus-page') }),
]);
export type UiStatusBarActionReq = z.infer<typeof uiStatusBarActionReqSchema>;
/** 悬浮层用户动作（便于导入的别名） */
export type StatusBarAction = UiStatusBarActionReq;
export const uiStatusBarActionResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarActionRes = z.infer<typeof uiStatusBarActionResSchema>;

export const uiStatusBarSetExpandedReqSchema = z.object({
  /** 悬浮层内容在卡片之上额外需要的高度（建议/提示），0 表示仅基础卡片区 */
  panelHeight: z.number().min(0).max(640),
  /** 地址栏是否折叠为悬浮球：折叠时窗口缩为球大小，展开时恢复整条地址栏 */
  collapsed: z.boolean().default(false),
});
export type UiStatusBarSetExpandedReq = z.infer<typeof uiStatusBarSetExpandedReqSchema>;
export const uiStatusBarSetExpandedResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarSetExpandedRes = z.infer<typeof uiStatusBarSetExpandedResSchema>;

/**
 * ui.statusbar.collapse：折叠/展开地址栏（折叠按钮或悬浮球点击调用）。
 * 主进程据此切换地址栏窗口可见性与悬浮球状态，并同步给悬浮层。
 */
export const uiStatusBarCollapseReqSchema = z.object({
  collapsed: z.boolean(),
});
export type UiStatusBarCollapseReq = z.infer<typeof uiStatusBarCollapseReqSchema>;
export const uiStatusBarCollapseResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarCollapseRes = z.infer<typeof uiStatusBarCollapseResSchema>;

/**
 * ui.statusbar.ball.scroll：悬浮球拖动滚动网页（悬浮球 → 主进程 → 活跃 tab webContents）。
 */
export const uiStatusBarBallScrollReqSchema = z.object({
  /** X 位移（px，正值向右） */
  dx: z.number(),
  /** Y 位移（px，正值向下） */
  dy: z.number(),
});
export type UiStatusBarBallScrollReq = z.infer<typeof uiStatusBarBallScrollReqSchema>;
export const uiStatusBarBallScrollResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarBallScrollRes = z.infer<typeof uiStatusBarBallScrollResSchema>;

/**
 * ui.statusbar.ball.move：悬浮球右键拖动改变位置（悬浮球 → 主进程移动窗口）。
 */
export const uiStatusBarBallMoveReqSchema = z.object({
  /** X 位移（px，正值向右） */
  dx: z.number(),
  /** Y 位移（px，正值向下） */
  dy: z.number(),
});
export type UiStatusBarBallMoveReq = z.infer<typeof uiStatusBarBallMoveReqSchema>;
export const uiStatusBarBallMoveResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarBallMoveRes = z.infer<typeof uiStatusBarBallMoveResSchema>;

/**
 * ui.statusbar.ball.click：悬浮球点击（切换折叠/展开）。主进程根据当前折叠态切换。
 */
export const uiStatusBarBallClickReqSchema = z.object({}).default({});
export type UiStatusBarBallClickReq = z.infer<typeof uiStatusBarBallClickReqSchema>;
export const uiStatusBarBallClickResSchema = z.object({ ok: z.literal(true) });
export type UiStatusBarBallClickRes = z.infer<typeof uiStatusBarBallClickResSchema>;

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

/**
 * ui.panel.saveBookmarkPicker：以「保存书签到所选文件夹」模式打开收藏夹面板。
 *
 * dev.120：星标按钮（未收藏时）不再直接 bookmark.create，改为打开面板让用户选文件夹。
 * 主进程解析活动标签 url/title 存为 pickerContext，面板加载 ?mode=picker 后经
 * ui.panel.getPickerContext 拉取上下文渲染选择器。
 */
export const uiPanelSaveBookmarkPickerReqSchema = z.object({}).default({});
export type UiPanelSaveBookmarkPickerReq = z.infer<typeof uiPanelSaveBookmarkPickerReqSchema>;

export const uiPanelSaveBookmarkPickerResSchema = z.object({
  ok: z.literal(true),
  /** 未在 http/https 页面调用时为 'not-bookmarkable'（星标本就禁用，防御式校验） */
  reason: z.enum(['not-bookmarkable']).optional(),
});
export type UiPanelSaveBookmarkPickerRes = z.infer<typeof uiPanelSaveBookmarkPickerResSchema>;

/** ui.panel.getPickerContext：面板 picker 模式加载时拉取待存页面 url/title。 */
export const uiPanelGetPickerContextReqSchema = z.object({}).default({});
export type UiPanelGetPickerContextReq = z.infer<typeof uiPanelGetPickerContextReqSchema>;

export const uiPanelGetPickerContextResSchema = z.object({
  /** 非 picker 模式或无活动网页时为 null */
  url: z.string().nullable(),
  title: z.string().nullable(),
});
export type UiPanelGetPickerContextRes = z.infer<typeof uiPanelGetPickerContextResSchema>;

/** ui.panel.close：picker 保存成功后面板主动关闭（面板窗口无法直接关 BrowserWindow）。 */
export const uiPanelCloseReqSchema = z.object({}).default({});
export type UiPanelCloseReq = z.infer<typeof uiPanelCloseReqSchema>;

export const uiPanelCloseResSchema = z.object({
  ok: z.literal(true),
});
export type UiPanelCloseRes = z.infer<typeof uiPanelCloseResSchema>;

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

/** download.showInFolder：在系统文件管理器中定位该下载文件（等效「在文件夹中显示」）。
 *  仅 completed 状态提供按钮（面板侧控制），主进程按 id 查 savePath 调用 shell。 */
export const downloadShowInFolderReqSchema = z.object({
  id: downloadIdSchema,
});
export type DownloadShowInFolderReq = z.infer<typeof downloadShowInFolderReqSchema>;

export const downloadShowInFolderResSchema = z.object({
  ok: z.literal(true),
  id: downloadIdSchema,
});
export type DownloadShowInFolderRes = z.infer<typeof downloadShowInFolderResSchema>;

// ============================================================================
// Dialog 域（原生对话框：目录选择器）
// ============================================================================

// ============================================================================
// Import 域（D：从其他浏览器导入收藏夹 / dev.119）
// ============================================================================

/** 可检测的浏览器种类（HTML 文件导入不走 ImportedBrowser，单独走 bookmarksFromFile）。 */
export const browserKindSchema = z.enum(['chrome', 'edge', 'firefox']);
export type BrowserKind = z.infer<typeof browserKindSchema>;

/** 已检测到的浏览器 profile（供设置页「检测本机浏览器」列表展示与按 id 导入）。 */
export const importedBrowserSchema = z.object({
  /** 稳定 id：`<kind>:<profileDir>`（profileDir 绝对路径唯一） */
  id: z.string().min(1),
  kind: browserKindSchema,
  /** 显示名（Google Chrome / Microsoft Edge / Mozilla Firefox） */
  displayName: z.string().min(1),
  /** profile 名（Default / Profile 1 / profiles.ini Name） */
  profileName: z.string().min(1),
  /** profile 绝对路径 */
  profileDir: z.string().min(1),
  /** 收藏夹数据来源格式（决定解析路径） */
  bookmarksSource: z.enum(['chromium-json', 'firefox-places']),
});
export type ImportedBrowser = z.infer<typeof importedBrowserSchema>;

/** 导入结果摘要（成功导入时返回；canceled=true 时 summary=null）。 */
export const importSummarySchema = z.object({
  /** 新建文件夹数（含根文件夹） */
  folders: z.number().int().nonnegative(),
  /** 新建书签数 */
  bookmarks: z.number().int().nonnegative(),
  /** 跳过条目数（空标题/非法 url） */
  skipped: z.number().int().nonnegative(),
  /** 在 Urchin 内创建的根文件夹 id（便于面板跳转定位） */
  rootFolderId: z.string().min(1),
  /** 根文件夹标题（如「导入自 Chrome (2026-10-25)」） */
  rootFolderTitle: z.string().min(1),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;

// import.detectBrowsers：扫描本机 Chrome/Edge/Firefox 用户目录，返回可导入 profile 列表
export const importDetectBrowsersReqSchema = z.object({}).default({});
export type ImportDetectBrowsersReq = z.infer<typeof importDetectBrowsersReqSchema>;

export const importDetectBrowsersResSchema = z.object({
  browsers: z.array(importedBrowserSchema),
});
export type ImportDetectBrowsersRes = z.infer<typeof importDetectBrowsersResSchema>;

// import.bookmarksFromFile：弹出文件选择器（html/htm）→ 解析 → 导入
export const importBookmarksFromFileReqSchema = z.object({}).default({});
export type ImportBookmarksFromFileReq = z.infer<typeof importBookmarksFromFileReqSchema>;

export const importBookmarksFromFileResSchema = z.object({
  /** 用户在对话框取消时为 true */
  canceled: z.boolean().default(false),
  summary: importSummarySchema.nullable(),
});
export type ImportBookmarksFromFileRes = z.infer<typeof importBookmarksFromFileResSchema>;

// import.bookmarksFromBrowser：按 detect 返回的 id 导入指定浏览器 profile 的收藏夹
export const importBookmarksFromBrowserReqSchema = z.object({
  id: z.string().min(1),
});
export type ImportBookmarksFromBrowserReq = z.infer<typeof importBookmarksFromBrowserReqSchema>;

export const importBookmarksFromBrowserResSchema = z.object({
  canceled: z.boolean().default(false),
  summary: importSummarySchema.nullable(),
});
export type ImportBookmarksFromBrowserRes = z.infer<typeof importBookmarksFromBrowserResSchema>;

// ============================================================================
// Dialog 域（原生对话框：目录选择器）—— 原位置
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
// File 域（本地文件网页化打开）
// ============================================================================

/** 文件类型分类：决定打开方式（原生 Chromium 渲染 or 文本查看器渲染）。 */
export const fileKindSchema = z.enum([
  'audio',
  'video',
  'pdf',
  'image',
  'html',
  'markdown',
  'json',
  'text',
  'binary',
  /** 阶段 4：Word 文档（GenOffice docs 编辑器接管） */
  'docx',
  /** 阶段 5：PowerPoint 演示文档（GenOffice slides 编辑器接管） */
  'pptx',
  /** 阶段 5：Excel 表格（GenOffice sheets 编辑器接管） */
  'xlsx',
]);
export type FileKind = z.infer<typeof fileKindSchema>;

/** 本地文件绝对路径：非空，长度上限 4096（Windows 路径上限）。 */
export const filePathSchema = z.string().min(1).max(4096);

export const fileStatReqSchema = z.object({
  path: filePathSchema,
});
export type FileStatReq = z.infer<typeof fileStatReqSchema>;

export const fileStatResSchema = z.object({
  /** 文件名（含扩展名）。 */
  name: z.string(),
  /** 文件大小（字节）；目录为 0。 */
  size: z.number().nonnegative(),
  /** 小写扩展名（不含点），无扩展名为空字符串；目录为空字符串。 */
  ext: z.string(),
  /** MIME 类型（按扩展名推断，未知为 application/octet-stream）。 */
  mimeType: z.string(),
  /** 类型分类：决定打开方式。 */
  kind: fileKindSchema,
  /** 是否为目录（true → 渲染层打开目录浏览页，kind 为 binary 占位）。 */
  isDir: z.boolean().default(false),
});
export type FileStatRes = z.infer<typeof fileStatResSchema>;

export const fileReadReqSchema = z.object({
  path: filePathSchema,
  /** 读取上限（字节），默认 5MB；超过时只读前 maxBytes 字节并在 truncated 标记（不再抛 FILE_TOO_LARGE）。 */
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024)
    .optional(),
});
export type FileReadReq = z.infer<typeof fileReadReqSchema>;

export const fileReadResSchema = z.object({
  /** 文件文本内容（UTF-8；截断时为前 readBytes 字节解码的内容）。 */
  content: z.string(),
  /** 是否因超过 maxBytes 被截断（渲染层据此显示「已显示前 X / 共 Y」横幅）。 */
  truncated: z.boolean(),
  /** 文件完整大小（字节）。 */
  totalSize: z.number().int().nonnegative(),
  /** 实际读取的字节数（≤ min(maxBytes, totalSize)）。 */
  readBytes: z.number().int().nonnegative(),
});
export type FileReadRes = z.infer<typeof fileReadResSchema>;

export const fileOpenReqSchema = z.object({
  /** 文件选择器标题，可选。 */
  title: z.string().max(256).optional(),
});
export type FileOpenReq = z.infer<typeof fileOpenReqSchema>;

// ── 本地文件写入（编辑器保存）──

export const fileWriteReqSchema = z.object({
  /** 覆盖写入目标（编辑会话的原文件，或另存对话框已选定的路径）。 */
  path: filePathSchema,
  /** 写入内容（UTF-8 文本）。8M 字符上限：可编辑文件源 ≤5MB 字节，余量覆盖多字节展开。 */
  content: z.string().max(8 * 1024 * 1024),
});
export type FileWriteReq = z.infer<typeof fileWriteReqSchema>;

export const fileWriteResSchema = z.object({
  bytesWritten: z.number().int().nonnegative(),
});
export type FileWriteRes = z.infer<typeof fileWriteResSchema>;

export const fileSaveAsReqSchema = z.object({
  content: z.string().max(8 * 1024 * 1024),
  /** 另存对话框默认文件名（主进程做非法字符净化）。 */
  defaultName: z.string().min(1).max(256),
  /** 另存对话框默认目录（通常为原文件所在目录），可选。 */
  defaultDir: filePathSchema.optional(),
});
export type FileSaveAsReq = z.infer<typeof fileSaveAsReqSchema>;

export const fileSaveAsResSchema = z.object({
  /** 用户选定并写入成功的绝对路径；取消为 null。 */
  path: z.string().min(1).nullable(),
});
export type FileSaveAsRes = z.infer<typeof fileSaveAsResSchema>;

// ── 编辑器草稿（会话内自动临时保存）──

export const draftKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,80}$/, 'draft key 只允许字母/数字/连字符');

export const editorSaveDraftReqSchema = z.object({
  /** 草稿键：渲染层由原文件绝对路径哈希生成——原路径不出本机，主进程写入
   * editor-drafts 目录时以 key 拼接、无路径入参，天然杜绝目录遍历。 */
  key: draftKeySchema,
  content: z.string().max(8 * 1024 * 1024),
});
export type EditorSaveDraftReq = z.infer<typeof editorSaveDraftReqSchema>;

export const editorSaveDraftResSchema = z.object({
  draftPath: z.string().min(1),
});
export type EditorSaveDraftRes = z.infer<typeof editorSaveDraftResSchema>;

export const editorCleanupDraftReqSchema = z.object({
  key: draftKeySchema,
});
export type EditorCleanupDraftReq = z.infer<typeof editorCleanupDraftReqSchema>;

export const editorCleanupDraftResSchema = z.object({
  removed: z.boolean(),
});
export type EditorCleanupDraftRes = z.infer<typeof editorCleanupDraftResSchema>;

export const fileOpenResSchema = z.object({
  /** 选中的文件路径，用户取消时为 null。 */
  path: z.string().nullable(),
});
export type FileOpenRes = z.infer<typeof fileOpenResSchema>;

/** 目录条目：目录恒为 kind='binary'（占位，UI 以 isDir 分支渲染文件夹）。 */
export const fileDirEntrySchema = z.object({
  name: z.string(),
  path: filePathSchema,
  kind: fileKindSchema,
  isDir: z.boolean(),
  size: z.number().nonnegative(),
});
export type FileDirEntry = z.infer<typeof fileDirEntrySchema>;

export const fileDirReqSchema = z.object({
  path: filePathSchema,
});
export type FileDirReq = z.infer<typeof fileDirReqSchema>;

export const fileDirResSchema = z.object({
  /** 目录条目：子目录在前（字母序），其后文件按名排序（字母序）。 */
  entries: z.array(fileDirEntrySchema),
});
export type FileDirRes = z.infer<typeof fileDirResSchema>;

// ============================================================================
// File Association 域（Windows 默认应用 · 文件关联注册）
// ============================================================================

/** 文件关联分组标识（设置页「默认应用」三组）。 */
export const associationGroupIdSchema = z.enum(['media', 'documents', 'images']);
export type AssociationGroupId = z.infer<typeof associationGroupIdSchema>;

/** 单组关联状态（已注册扩展名数 / 总数 / 扩展名清单）。 */
export const associationGroupStatusSchema = z.object({
  registered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  extensions: z.array(z.string()),
});
export type AssociationGroupStatus = z.infer<typeof associationGroupStatusSchema>;

export const fileAssociationRegisterReqSchema = z.object({
  group: associationGroupIdSchema,
});
export type FileAssociationRegisterReq = z.infer<typeof fileAssociationRegisterReqSchema>;

export const fileAssociationRegisterResSchema = z.object({
  ok: z.literal(true),
  count: z.number().int().nonnegative(),
});
export type FileAssociationRegisterRes = z.infer<typeof fileAssociationRegisterResSchema>;

export const fileAssociationGetStatusReqSchema = z.object({});
export type FileAssociationGetStatusReq = z.infer<typeof fileAssociationGetStatusReqSchema>;

export const fileAssociationGetStatusResSchema = z.object({
  /** key = 分组 id（media / documents / images）。 */
  groups: z.record(associationGroupIdSchema, associationGroupStatusSchema),
});
export type FileAssociationGetStatusRes = z.infer<typeof fileAssociationGetStatusResSchema>;

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

// ============================================================================
// piWeb.* —— pi 网页版启动器（阶段 1：系统 Node 子进程运行社区包 pi-web-ui）
// ============================================================================

/**
 * piWeb.launch：启动（或复用已运行的）pi 网页服务并返回入口 URL。
 *
 * 架构（docs/pi-web-评估.md）：pi 及其 Web UI 全部运行在独立的系统 Node 子进程中
 * （`npx -y pi-web-ui@0.28.2`），仅绑定 127.0.0.1 随机端口；Electron 主进程零 pi 依赖。
 */
export const piWebLaunchReqSchema = z.object({}).default({});
export type PiWebLaunchReq = z.infer<typeof piWebLaunchReqSchema>;

export const piWebLaunchResSchema = z.object({
  ok: z.literal(true),
  /** 入口 URL（http://127.0.0.1:<port>），渲染层新开标签页加载 */
  url: z.string().url(),
  /** 本次服务监听端口 */
  port: z.number().int().min(1).max(65_535),
});
export type PiWebLaunchRes = z.infer<typeof piWebLaunchResSchema>;

/** piWeb.status：查询 pi 网页服务状态（不产生副作用） */
export const piWebStatusReqSchema = z.object({}).default({});
export type PiWebStatusReq = z.infer<typeof piWebStatusReqSchema>;

/** pi 网页服务运行状态（有限状态机：stopped → starting → running / error） */
export const piWebStateSchema = z.enum(['stopped', 'starting', 'running', 'error']);
export type PiWebState = z.infer<typeof piWebStateSchema>;

export const piWebStatusResSchema = z.object({
  state: piWebStateSchema,
  /** running 时返回入口 URL */
  url: z.string().url().optional(),
  /** 本次服务监听端口（starting/running 时返回） */
  port: z.number().int().min(1).max(65_535).optional(),
  /** 子进程 PID（starting/running 时返回） */
  pid: z.number().int().optional(),
  /** error 状态时的最后错误信息 */
  lastError: z.string().optional(),
});
export type PiWebStatusRes = z.infer<typeof piWebStatusResSchema>;

/** piWeb.stop：停止 pi 网页服务（终止子进程树；已停时幂等成功） */
export const piWebStopReqSchema = z.object({}).default({});
export type PiWebStopReq = z.infer<typeof piWebStopReqSchema>;

export const piWebStopResSchema = z.object({
  ok: z.literal(true),
});
export type PiWebStopRes = z.infer<typeof piWebStopResSchema>;

// ============================================================================
// deepseekHarness.* —— DeepSeek Harness 启动器（vendor 子进程运行 dsh web）
// ============================================================================

/**
 * deepseekHarness.launch：启动（或复用已运行的）DeepSeek Harness Web 服务并返回入口 URL。
 *
 * 架构：dsh web 全部运行在独立的系统 Node 子进程中（vendor/deepseek-harness，
 * tsx ESM loader 直启 apps/cli/src/bin.ts），仅绑定 127.0.0.1 随机端口；
 * Electron 主进程零 dsh 依赖。标签关闭后自动停止后端（与 piWeb 不同）。
 */
export const deepseekHarnessLaunchReqSchema = z.object({}).default({});
export type DeepseekHarnessLaunchReq = z.infer<typeof deepseekHarnessLaunchReqSchema>;

export const deepseekHarnessLaunchResSchema = z.object({
  ok: z.literal(true),
  /** 入口 URL（http://127.0.0.1:<port>），渲染层新开标签页加载 */
  url: z.string().url(),
  /** 本次服务监听端口 */
  port: z.number().int().min(1).max(65_535),
});
export type DeepseekHarnessLaunchRes = z.infer<typeof deepseekHarnessLaunchResSchema>;

/** deepseekHarness.status：查询服务状态（不产生副作用） */
export const deepseekHarnessStatusReqSchema = z.object({}).default({});
export type DeepseekHarnessStatusReq = z.infer<typeof deepseekHarnessStatusReqSchema>;

/** dsh 服务运行状态（有限状态机：stopped → starting → running / error） */
export const deepseekHarnessStateSchema = z.enum(['stopped', 'starting', 'running', 'error']);
export type DeepseekHarnessState = z.infer<typeof deepseekHarnessStateSchema>;

export const deepseekHarnessStatusResSchema = z.object({
  state: deepseekHarnessStateSchema,
  /** running 时返回入口 URL */
  url: z.string().url().optional(),
  /** 本次服务监听端口（starting/running 时返回） */
  port: z.number().int().min(1).max(65_535).optional(),
  /** 子进程 PID（starting/running 时返回） */
  pid: z.number().int().optional(),
  /** error 状态时的最后错误信息 */
  lastError: z.string().optional(),
});
export type DeepseekHarnessStatusRes = z.infer<typeof deepseekHarnessStatusResSchema>;

/** deepseekHarness.stop：停止服务（终止子进程树；已停时幂等成功） */
export const deepseekHarnessStopReqSchema = z.object({}).default({});
export type DeepseekHarnessStopReq = z.infer<typeof deepseekHarnessStopReqSchema>;

export const deepseekHarnessStopResSchema = z.object({
  ok: z.literal(true),
});
export type DeepseekHarnessStopRes = z.infer<typeof deepseekHarnessStopResSchema>;

// ============================================================================
// screenshot.* —— 地址栏截图按钮（整屏框选截图，存用户数据目录）
// ============================================================================

/** 截图请求：无参数，主进程弹出全屏框选覆盖窗口 */
export const screenshotCaptureReqSchema = z.object({}).default({});
export type ScreenshotCaptureReq = z.infer<typeof screenshotCaptureReqSchema>;

/** 截图响应：是否成功弹出框选窗口 */
export const screenshotCaptureResSchema = z.object({
  /** 是否已打开覆盖窗口（true = 本次弹出；false = 已有一个在进行中） */
  started: z.boolean(),
});
export type ScreenshotCaptureRes = z.infer<typeof screenshotCaptureResSchema>;

/** 背景截图请求：覆盖窗口拉取整屏截图 data URI */
export const screenshotGetImageDataReqSchema = z.object({}).default({});
export type ScreenshotGetImageDataReq = z.infer<typeof screenshotGetImageDataReqSchema>;

/** 背景截图响应 */
export const screenshotGetImageDataResSchema = z.object({
  /** data URI 格式：data:image/png;base64,xxxx（物理像素整屏） */
  dataUri: z.string().min(1),
});
export type ScreenshotGetImageDataRes = z.infer<typeof screenshotGetImageDataResSchema>;

/** 确认框选请求：选区物理像素矩形（覆盖窗口已按 devicePixelRatio 换算） */
export const screenshotConfirmReqSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type ScreenshotConfirmReq = z.infer<typeof screenshotConfirmReqSchema>;

/** 确认框选响应 */
export const screenshotConfirmResSchema = z.object({
  /** 裁剪后的 PNG 文件绝对路径（<数据目录>/screenshots/<时间戳>.png） */
  path: z.string().min(1),
});
export type ScreenshotConfirmRes = z.infer<typeof screenshotConfirmResSchema>;

/** 取消框选请求：无参数，关闭覆盖窗口 */
export const screenshotCancelReqSchema = z.object({}).default({});
export type ScreenshotCancelReq = z.infer<typeof screenshotCancelReqSchema>;

/** 取消框选响应：空 */
export const screenshotCancelResSchema = z.object({}).default({});
export type ScreenshotCancelRes = z.infer<typeof screenshotCancelResSchema>;

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
// Translate 域（M24 网页翻译 · 免费接口引擎，与 AI Provider / pi 模块完全隔离）
// ============================================================================

/**
 * v1 支持的目标语言（2026-08-30 评审确认：zh-CN 必含且为默认）。
 * 各引擎内部做自身代码映射（微软 zh-Hans/zh-Hant，谷歌原样），对外统一用本表代码。
 */
export const TRANSLATE_TARGET_LANGS = [
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'ru',
  'es',
] as const;
export type TranslateTargetLang = (typeof TRANSLATE_TARGET_LANGS)[number];
export const translateTargetLangSchema = z.enum(TRANSLATE_TARGET_LANGS);

/**
 * 引擎选择：auto = 按网络环境自动（直连微软优先 / 走系统代理谷歌优先，双引擎互为兜底，
 * 判定规则见 main/translate/translate-manager.ts §7.5 设计），或手动锁定某一引擎。
 */
export const translateEngineSettingSchema = z.enum(['auto', 'microsoft', 'google', 'mymemory']);
export type TranslateEngineSetting = z.infer<typeof translateEngineSettingSchema>;

/** translate.start：对指定 tab 启动整页翻译（已激活时先恢复原文再重新采集）；返回后经 translate:progress 事件推送进度 */
export const translateStartReqSchema = z.object({
  tabId: tabIdSchema,
  targetLang: translateTargetLangSchema.optional(),
  engine: translateEngineSettingSchema.optional(),
});
export type TranslateStartReq = z.infer<typeof translateStartReqSchema>;

export const translateStartResSchema = z.object({
  status: z.enum(['started', 'skipped']),
  /** 源语言（页面 lang 属性或引擎检测） */
  detectedLang: z.string().optional(),
  segmentCount: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type TranslateStartRes = z.infer<typeof translateStartResSchema>;

/** translate.stop：停止翻译并恢复原文 */
export const translateStopReqSchema = z.object({ tabId: tabIdSchema });
export type TranslateStopReq = z.infer<typeof translateStopReqSchema>;

export const translateStopResSchema = z.object({
  /** restored = 曾激活且已恢复；idle = 本就未在翻译 */
  status: z.enum(['restored', 'idle']),
});
export type TranslateStopRes = z.infer<typeof translateStopResSchema>;

/** translate.getStatus：地址栏翻译按钮态查询 */
export const translateGetStatusReqSchema = z.object({ tabId: tabIdSchema });
export type TranslateGetStatusReq = z.infer<typeof translateGetStatusReqSchema>;

export const translateGetStatusResSchema = z.object({
  active: z.boolean(),
  /** 设置中的引擎选择（auto/microsoft/google） */
  engine: translateEngineSettingSchema.optional(),
  /** auto 解析 / 手动锁定后实际生效的引擎（failover 切换后随之更新） */
  resolvedEngine: z.enum(['microsoft', 'google', 'mymemory']).optional(),
  targetLang: z.string().optional(),
  segmentCount: z.number().int().nonnegative().optional(),
});
export type TranslateGetStatusRes = z.infer<typeof translateGetStatusResSchema>;

/** translate.translateSelection：划词翻译（右键菜单 selectionText，不走页面注入） */
export const translateSelectionReqSchema = z.object({
  tabId: tabIdSchema,
  text: z.string().min(1).max(5000),
  targetLang: translateTargetLangSchema.optional(),
});
export type TranslateSelectionReq = z.infer<typeof translateSelectionReqSchema>;

export const translateSelectionResSchema = z.object({
  result: z.string(),
  detectedLang: z.string().optional(),
});
export type TranslateSelectionRes = z.infer<typeof translateSelectionResSchema>;

// ============================================================================
// Mail 域（M25 邮箱模块 · imapflow + nodemailer + postal-mime）
// ============================================================================

/** 邮箱账户 ID：UUID v4 */
export const mailAccountIdSchema = z.string().uuid();
export type MailAccountId = z.infer<typeof mailAccountIdSchema>;

/** IMAP UID：正整数，服务器分配的唯一标识 */
export const mailUidSchema = z.number().int().positive();
export type MailUid = z.infer<typeof mailUidSchema>;

/** 邮箱账户（返回渲染层时不含密码——密码仅存 safeStorage） */
export const mailAccountSchema = z.object({
  id: mailAccountIdSchema,
  name: z.string(),
  email: z.string().email(),
  imapHost: z.string(),
  imapPort: z.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpSecure: z.boolean().optional(),
  createdAt: z.number().int(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

// --- mail.account.list ---

export const mailAccountListReqSchema = z.object({});
export type MailAccountListReq = z.infer<typeof mailAccountListReqSchema>;

export const mailAccountListResSchema = z.object({
  accounts: z.array(mailAccountSchema),
});
export type MailAccountListRes = z.infer<typeof mailAccountListResSchema>;

// --- mail.account.add ---

export const mailAccountAddReqSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  imapHost: z.string(),
  imapPort: z.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  password: z.string().min(1),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpSecure: z.boolean().optional(),
});
export type MailAccountAddReq = z.infer<typeof mailAccountAddReqSchema>;

export const mailAccountAddResSchema = z.object({
  account: mailAccountSchema,
});
export type MailAccountAddRes = z.infer<typeof mailAccountAddResSchema>;

// --- mail.account.delete ---

export const mailAccountDeleteReqSchema = z.object({
  accountId: mailAccountIdSchema,
});
export type MailAccountDeleteReq = z.infer<typeof mailAccountDeleteReqSchema>;

export const mailAccountDeleteResSchema = z.object({
  ok: z.literal(true),
});
export type MailAccountDeleteRes = z.infer<typeof mailAccountDeleteResSchema>;

// --- mail.account.test ---

export const mailAccountTestReqSchema = z.object({
  imapHost: z.string(),
  imapPort: z.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  email: z.string().email(),
  password: z.string().min(1),
});
export type MailAccountTestReq = z.infer<typeof mailAccountTestReqSchema>;

export const mailAccountTestResSchema = z.object({
  ok: z.literal(true),
  folders: z.array(z.string()).optional(),
});
export type MailAccountTestRes = z.infer<typeof mailAccountTestResSchema>;

// --- 文件夹 ---

export const mailFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  delimiter: z.string().default('/'),
  flags: z.array(z.string()).default([]),
  exists: z.number().int(),
  unseen: z.number().int(),
});
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailFolderListReqSchema = z.object({
  accountId: mailAccountIdSchema,
});
export type MailFolderListReq = z.infer<typeof mailFolderListReqSchema>;

export const mailFolderListResSchema = z.object({
  folders: z.array(mailFolderSchema),
  /** Phase 1 缓存：true = 从 SQLite 即时返回（后台 IMAP 刷新中） */
  fromCache: z.boolean().default(false),
});
export type MailFolderListRes = z.infer<typeof mailFolderListResSchema>;

// --- 邮件信封与摘要 ---

export const mailMessageEnvelopeSchema = z.object({
  subject: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  date: z.string(),
  size: z.number().int(),
});
export type MailMessageEnvelope = z.infer<typeof mailMessageEnvelopeSchema>;

export const mailMessageSummarySchema = z.object({
  uid: mailUidSchema,
  envelope: mailMessageEnvelopeSchema,
  flags: z.array(z.string()).default([]),
  folder: z.string(),
});
export type MailMessageSummary = z.infer<typeof mailMessageSummarySchema>;

// --- mail.message.list ---

export const mailMessageListReqSchema = z.object({
  accountId: mailAccountIdSchema,
  folder: z.string().default('INBOX'),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type MailMessageListReq = z.infer<typeof mailMessageListReqSchema>;

export const mailMessageListResSchema = z.object({
  messages: z.array(mailMessageSummarySchema),
  total: z.number().int(),
  /** Phase 1 缓存：true = 从 SQLite 即时返回（后台 IMAP 增量同步中） */
  fromCache: z.boolean().default(false),
});
export type MailMessageListRes = z.infer<typeof mailMessageListResSchema>;

// --- mail.message.fetch ---

export const mailMessageFetchReqSchema = z.object({
  accountId: mailAccountIdSchema,
  folder: z.string(),
  uid: mailUidSchema,
});
export type MailMessageFetchReq = z.infer<typeof mailMessageFetchReqSchema>;

export const mailMessageFetchResSchema = z.object({
  uid: mailUidSchema,
  html: z.string().optional(),
  text: z.string().optional(),
  /** 邮件正文渲染 URL（urchin://mail-content/<token>）——HTML 经 sanitize + cid 重写
   *  后存入主进程内容库，经协议路由以独立 CSP 下发（图片/样式不受主窗口 CSP 限制） */
  contentUrl: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string(),
        size: z.number().int(),
      }),
    )
    .default([]),
});
export type MailMessageFetchRes = z.infer<typeof mailMessageFetchResSchema>;

// --- mail.message.markRead ---

export const mailMessageMarkReadReqSchema = z.object({
  accountId: mailAccountIdSchema,
  folder: z.string(),
  uid: mailUidSchema,
  seen: z.boolean(),
});
export type MailMessageMarkReadReq = z.infer<typeof mailMessageMarkReadReqSchema>;

export const mailMessageMarkReadResSchema = z.object({
  ok: z.literal(true),
});
export type MailMessageMarkReadRes = z.infer<typeof mailMessageMarkReadResSchema>;

// --- mail.message.translate（M25 邮件翻译，复用 M24 引擎层） ---

export const mailMessageTranslateReqSchema = z.object({
  accountId: mailAccountIdSchema,
  folder: z.string(),
  uid: mailUidSchema,
  /** 目标语言显式指定（缺省走中英自动判定：含 CJK → en，否则 zh-CN） */
  targetLang: z.enum(['zh-CN', 'en']).optional(),
});
export type MailMessageTranslateReq = z.infer<typeof mailMessageTranslateReqSchema>;

export const mailMessageTranslateResSchema = z.object({
  /** 译文渲染 URL（urchin://mail-content/<token>，原邮件有 HTML 时返回） */
  contentUrl: z.string().optional(),
  /** 译文纯文本（原邮件仅纯文本时返回） */
  text: z.string().optional(),
  /** 引擎检测的源语言 */
  detectedLang: z.string().optional(),
  /** 实际生效引擎（failover 后为备用引擎） */
  engine: z.enum(['microsoft', 'google', 'mymemory']),
  /** 实际目标语言 */
  targetLang: z.string(),
});
export type MailMessageTranslateRes = z.infer<typeof mailMessageTranslateResSchema>;

// --- mail.message.send（W2 SMTP 发信） ---

export const mailMessageSendReqSchema = z.object({
  accountId: mailAccountIdSchema,
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  /** 回复的原始邮件 UID（可选：回复时自动引用原文） */
  inReplyToUid: mailUidSchema.optional(),
  /** 附件列表（base64 编码内容，经 IPC 传输） */
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        contentType: z.string().optional(),
        /** base64 编码的文件内容 */
        contentBase64: z.string(),
        size: z.number().int(),
      }),
    )
    .optional(),
});
export type MailMessageSendReq = z.infer<typeof mailMessageSendReqSchema>;

export const mailMessageSendResSchema = z.object({
  ok: z.literal(true),
  /** 已发送的 messageId（SMTP 返回） */
  messageId: z.string().optional(),
});
export type MailMessageSendRes = z.infer<typeof mailMessageSendResSchema>;

// --- mail.attachment.select（附件文件选择器） ---

export const mailAttachmentSelectReqSchema = z.object({});
export type MailAttachmentSelectReq = z.infer<typeof mailAttachmentSelectReqSchema>;

export const mailAttachmentSelectResSchema = z.object({
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      /** base64 编码的文件内容 */
      contentBase64: z.string(),
      size: z.number().int(),
    }),
  ),
});
export type MailAttachmentSelectRes = z.infer<typeof mailAttachmentSelectResSchema>;

// --- 新邮件事件（单向推送，mail.event.newMessage） ---

export const mailEventNewMessageSchema = z.object({
  accountId: mailAccountIdSchema,
  folder: z.string(),
  uid: mailUidSchema,
  envelope: mailMessageEnvelopeSchema,
});
export type MailEventNewMessage = z.infer<typeof mailEventNewMessageSchema>;

// ============================================================================
// update.* —— 应用自动更新（dev.114 提前落地 · GitHub Releases dev 预发布通道）
// ============================================================================

/**
 * 更新状态机（跨进程唯一真源在主进程 update-service）：
 * disabled=开发态/未启用（!app.isPackaged）；idle=就绪未检查；checking=检查中；
 * up-to-date=已最新；available=发现新版本（可下载）；downloading=下载中（带进度）；
 * downloaded=已下载（可安装；退出应用时自动安装）；installing=正在退出安装；
 * error=失败（error 字段给原因）。
 */
export const updateStatusSchema = z.enum([
  'disabled',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** 下载进度快照（来源 electron-updater download-progress 事件）。 */
export const updateProgressSchema = z.object({
  /** 0-100 */
  percent: z.number().min(0).max(100),
  /** 已传输字节数 */
  transferred: z.number().nonnegative(),
  /** 总字节数（服务端未给 Content-Length 时为 0） */
  total: z.number().nonnegative(),
  /** 实时速率（字节/秒） */
  bytesPerSecond: z.number().nonnegative(),
});
export type UpdateProgress = z.infer<typeof updateProgressSchema>;

/**
 * 更新状态快照：update.getState / check / download 的返回值与
 * `update:event` 推送（主进程状态变化时广播）共用同一结构。
 */
export const updateStateSchema = z.object({
  status: updateStatusSchema,
  /** 当前安装版本（app.getVersion()，如 0.1.0-dev.113） */
  currentVersion: z.string().min(1),
  /** 新版本号（available / downloading / downloaded 时存在） */
  latestVersion: z.string().min(1).optional(),
  /** release 标题（electron-updater releaseName；通常为 GitHub release 名） */
  releaseName: z.string().optional(),
  /** 更新说明（release notes 纯文本；非字符串格式时不返回） */
  releaseNotes: z.string().optional(),
  /** 下载进度（downloading 时存在） */
  progress: updateProgressSchema.optional(),
  /** 失败原因（error 时存在，人类可读） */
  error: z.string().optional(),
  /** 最近一次检查完成时间（ISO 8601；从未检查时缺失） */
  checkedAt: z.string().optional(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

// --- update.getState（读取当前状态快照，打开设置页时调用） ---

export const updateGetStateReqSchema = z.object({}).default({});
export type UpdateGetStateReq = z.infer<typeof updateGetStateReqSchema>;
export const updateGetStateResSchema = updateStateSchema;

// --- update.check（手动检查更新；GitHub 抓取慢，handler 侧放宽 IPC 超时） ---

export const updateCheckReqSchema = z.object({}).default({});
export type UpdateCheckReq = z.infer<typeof updateCheckReqSchema>;
export const updateCheckResSchema = updateStateSchema;

// --- update.download（开始下载；立即返回，进度经 update:event 推送） ---

export const updateDownloadReqSchema = z.object({}).default({});
export type UpdateDownloadReq = z.infer<typeof updateDownloadReqSchema>;
export const updateDownloadResSchema = updateStateSchema;

// --- update.install（退出应用并安装已下载的新版本） ---

export const updateInstallReqSchema = z.object({}).default({});
export type UpdateInstallReq = z.infer<typeof updateInstallReqSchema>;
export const updateInstallResSchema = z.object({ ok: z.literal(true) });
export type UpdateInstallRes = z.infer<typeof updateInstallResSchema>;

// ============================================================================
// DevTools 域（M15 一期 · CDP 采集检视面板）
// ============================================================================
// 依据：docs/开发者工具增强一期实施规划.md §5、契约 G。
// 8 个 RPC 通道 + 2 个单向事件通道（devtools:event / devtools:toggle，
// 事件常量见 events.ts）。本期不开放原始 cdp.send 透传，能力集限定
// Network/Console 采集 + Runtime.evaluate（DT10）。

/** M15 检视会话状态：attached=正在采集；detached=已停止；unavailable=不可检视 */
export const devtoolsStateSchema = z.enum(['detached', 'attached', 'unavailable']);
export type DevtoolsState = z.infer<typeof devtoolsStateSchema>;

/** unavailable 原因：internal-page=urchin://内部页；genoffice-tab=编辑器视图；
 *  already-attached=Electron debugger 已被占用；target-closed=webContents 已销毁 */
export const devtoolsUnavailableReasonSchema = z.enum([
  'internal-page',
  'genoffice-tab',
  'already-attached',
  'target-closed',
]);
export type DevtoolsUnavailableReason = z.infer<typeof devtoolsUnavailableReasonSchema>;

/** 检视目标标识（DT12：会话绑定 tabId，面板头部显示标题） */
export const devtoolsTargetSchema = z.object({
  tabId: tabIdSchema,
  title: z.string(),
});
export type DevtoolsTarget = z.infer<typeof devtoolsTargetSchema>;

// --- devtools.attach（开始检视；幂等——已 attached 直接返回当前状态） ---

export const devtoolsAttachReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsAttachReq = z.infer<typeof devtoolsAttachReqSchema>;

export const devtoolsAttachResSchema = z.object({
  state: devtoolsStateSchema,
  reason: devtoolsUnavailableReasonSchema.optional(),
  target: devtoolsTargetSchema.optional(),
});
export type DevtoolsAttachRes = z.infer<typeof devtoolsAttachResSchema>;

// --- devtools.detach（停止检视；flush 尾批后 detach） ---

export const devtoolsDetachReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsDetachReq = z.infer<typeof devtoolsDetachReqSchema>;

export const devtoolsDetachResSchema = z.object({ ok: z.literal(true) });
export type DevtoolsDetachRes = z.infer<typeof devtoolsDetachResSchema>;

// --- devtools.status（状态查询） ---

export const devtoolsStatusReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsStatusReq = z.infer<typeof devtoolsStatusReqSchema>;

export const devtoolsStatusResSchema = z.object({
  state: devtoolsStateSchema,
  reason: devtoolsUnavailableReasonSchema.optional(),
  target: devtoolsTargetSchema.optional(),
});
export type DevtoolsStatusRes = z.infer<typeof devtoolsStatusResSchema>;

/** 网络请求条目（CDP Network 域聚合后的最终态；同一 requestId 的多次状态演进合并） */
export const networkEntrySchema = z.object({
  /** 会话内单调递增序号（条目创建时分配；用于渲染层排序与批内去重） */
  seq: z.number().int().nonnegative(),
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  status: z.number().int().optional(),
  mimeType: z.string().optional(),
  resourceType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  errorText: z.string().optional(),
  /** 响应头（已剔除 Set-Cookie，累计 ≤16KB 截断后置 headersTruncated） */
  responseHeaders: z.record(z.string(), z.string()).optional(),
  headersTruncated: z.boolean().optional(),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;

/** 控制台条目（console-api / exception / network 等多来源） */
export const consoleEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  level: z.enum(['error', 'warning', 'info', 'log', 'debug']),
  text: z.string(),
  source: z.enum(['console-api', 'exception', 'network', 'other']),
  url: z.string().optional(),
  lineNumber: z.number().int().nonnegative().optional(),
  timestamp: z.number().int().nonnegative(),
  stackTrace: z
    .array(
      z.object({
        functionName: z.string().optional(),
        url: z.string().optional(),
        lineNumber: z.number().int().nonnegative().optional(),
        columnNumber: z.number().int().nonnegative().optional(),
      }),
    )
    .max(10)
    .optional(),
});
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

// --- devtools.network.list（全量快照；无会话返回空数组，不报错） ---

export const devtoolsNetworkListReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsNetworkListReq = z.infer<typeof devtoolsNetworkListReqSchema>;

export const devtoolsNetworkListResSchema = z.object({
  entries: z.array(networkEntrySchema),
  /** 会话内累计被环形缓冲淘汰的条目数 */
  dropped: z.number().int().nonnegative(),
});
export type DevtoolsNetworkListRes = z.infer<typeof devtoolsNetworkListResSchema>;

// --- devtools.network.clear ---

export const devtoolsNetworkClearReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsNetworkClearReq = z.infer<typeof devtoolsNetworkClearReqSchema>;

export const devtoolsNetworkClearResSchema = z.object({ ok: z.literal(true) });
export type DevtoolsNetworkClearRes = z.infer<typeof devtoolsNetworkClearResSchema>;

// --- devtools.console.list ---

export const devtoolsConsoleListReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsConsoleListReq = z.infer<typeof devtoolsConsoleListReqSchema>;

export const devtoolsConsoleListResSchema = z.object({
  entries: z.array(consoleEntrySchema),
  dropped: z.number().int().nonnegative(),
});
export type DevtoolsConsoleListRes = z.infer<typeof devtoolsConsoleListResSchema>;

// --- devtools.console.clear ---

export const devtoolsConsoleClearReqSchema = z.object({ tabId: tabIdSchema });
export type DevtoolsConsoleClearReq = z.infer<typeof devtoolsConsoleClearReqSchema>;

export const devtoolsConsoleClearResSchema = z.object({ ok: z.literal(true) });
export type DevtoolsConsoleClearRes = z.infer<typeof devtoolsConsoleClearResSchema>;

// --- devtools.evaluate（Runtime.evaluate，returnByValue） ---

/** 表达式上限 8KB（防 IPC 滥用） */
export const DEVTOOLS_EVALUATE_MAX_BYTES = 8192;
/** 返回值序列化截断上限 256KB（防巨型对象阻塞 IPC） */
export const DEVTOOLS_EVALUATE_RESULT_MAX_BYTES = 256 * 1024;

export const devtoolsEvaluateReqSchema = z.object({
  tabId: tabIdSchema,
  expression: z.string().min(1).max(DEVTOOLS_EVALUATE_MAX_BYTES),
  awaitPromise: z.boolean().optional(),
});
export type DevtoolsEvaluateReq = z.infer<typeof devtoolsEvaluateReqSchema>;

export const devtoolsEvaluateResSchema = z.object({
  ok: z.boolean(),
  /** 成功时 returnByValue 的结果（已 JSON 序列化截断） */
  result: z.unknown().optional(),
  /** 失败时异常描述 */
  exception: z.string().optional(),
  /** 基础设施错误（attach 丢失、tab 不存在等） */
  error: z.string().optional(),
  /** 结果被截断 */
  truncated: z.boolean().optional(),
});
export type DevtoolsEvaluateRes = z.infer<typeof devtoolsEvaluateResSchema>;

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
  'tab.captureThumbnail': {
    req: tabCaptureThumbnailReqSchema,
    res: tabCaptureThumbnailResSchema,
  },
  'window.create': { req: windowCreateReqSchema, res: windowCreateResSchema },
  'window.close': { req: windowCloseReqSchema, res: windowCloseResSchema },
  'window.minimize': { req: windowMinimizeReqSchema, res: windowMinimizeResSchema },
  'window.toggleMaximize': {
    req: windowToggleMaximizeReqSchema,
    res: windowToggleMaximizeResSchema,
  },
  'window.getState': { req: windowGetStateReqSchema, res: windowGetStateResSchema },
  'window.createWithUrl': {
    req: windowCreateWithUrlReqSchema,
    res: windowCreateWithUrlResSchema,
  },
  'window.getCurrent': { req: windowGetCurrentReqSchema, res: windowGetCurrentResSchema },
  'window.captureUi': { req: windowCaptureUiReqSchema, res: windowCaptureUiResSchema },
  // Workspace 域（TP7 工作区）：CRUD + 清空数据；变更经 'workspace:changed' 事件广播。
  'workspace.list': { req: workspaceListReqSchema, res: workspaceListResSchema },
  'workspace.create': { req: workspaceCreateReqSchema, res: workspaceCreateResSchema },
  'workspace.update': { req: workspaceUpdateReqSchema, res: workspaceUpdateResSchema },
  'workspace.remove': { req: workspaceRemoveReqSchema, res: workspaceRemoveResSchema },
  'workspace.clearData': { req: workspaceClearDataReqSchema, res: workspaceClearDataResSchema },
  'history.record': { req: historyRecordReqSchema, res: historyRecordResSchema },
  'history.search': { req: historySearchReqSchema, res: historySearchResSchema },
  'history.list': { req: historyListReqSchema, res: historyListResSchema },
  'history.delete': { req: historyDeleteReqSchema, res: historyDeleteResSchema },
  'history.clear': { req: historyClearReqSchema, res: historyClearResSchema },
  'bookmark.create': { req: bookmarkCreateReqSchema, res: bookmarkCreateResSchema },
  'bookmark.list': { req: bookmarkListReqSchema, res: bookmarkListResSchema },
  'bookmark.search': { req: bookmarkSearchReqSchema, res: bookmarkSearchResSchema },
  'bookmark.update': { req: bookmarkUpdateReqSchema, res: bookmarkUpdateResSchema },
  'bookmark.delete': { req: bookmarkDeleteReqSchema, res: bookmarkDeleteResSchema },
  'settings.get': { req: settingsGetReqSchema, res: settingsGetResSchema },
  'settings.set': { req: settingsSetReqSchema, res: settingsSetResSchema },
  'settings.getAll': { req: settingsGetAllReqSchema, res: settingsGetAllResSchema },
  'ui.layout.setState': { req: uiLayoutSetStateReqSchema, res: uiLayoutSetStateResSchema },
  'ui.panel.toggle': { req: uiPanelToggleReqSchema, res: uiPanelToggleResSchema },
  'ui.panel.saveBookmarkPicker': {
    req: uiPanelSaveBookmarkPickerReqSchema,
    res: uiPanelSaveBookmarkPickerResSchema,
  },
  'ui.panel.getPickerContext': {
    req: uiPanelGetPickerContextReqSchema,
    res: uiPanelGetPickerContextResSchema,
  },
  'ui.panel.close': { req: uiPanelCloseReqSchema, res: uiPanelCloseResSchema },
  'ui.theme.set': { req: uiThemeSetReqSchema, res: uiThemeSetResSchema },
  'ui.window.dragBy': { req: uiWindowDragByReqSchema, res: uiWindowDragByResSchema },
  'ui.statusbar.sync': { req: uiStatusBarSyncReqSchema, res: uiStatusBarSyncResSchema },
  'ui.statusbar.getState': {
    req: uiStatusBarGetStateReqSchema,
    res: uiStatusBarGetStateResSchema,
  },
  'ui.statusbar.action': { req: uiStatusBarActionReqSchema, res: uiStatusBarActionResSchema },
  'ui.statusbar.setExpanded': {
    req: uiStatusBarSetExpandedReqSchema,
    res: uiStatusBarSetExpandedResSchema,
  },
  'ui.statusbar.collapse': { req: uiStatusBarCollapseReqSchema, res: uiStatusBarCollapseResSchema },
  'ui.statusbar.ball.scroll': {
    req: uiStatusBarBallScrollReqSchema,
    res: uiStatusBarBallScrollResSchema,
  },
  'ui.statusbar.ball.click': {
    req: uiStatusBarBallClickReqSchema,
    res: uiStatusBarBallClickResSchema,
  },
  'ui.statusbar.ball.move': {
    req: uiStatusBarBallMoveReqSchema,
    res: uiStatusBarBallMoveResSchema,
  },
  'download.list': { req: downloadListReqSchema, res: downloadListResSchema },
  'download.cancel': { req: downloadCancelReqSchema, res: downloadCancelResSchema },
  'download.pause': { req: downloadPauseReqSchema, res: downloadPauseResSchema },
  'download.resume': { req: downloadResumeReqSchema, res: downloadResumeResSchema },
  'download.clear': { req: downloadClearReqSchema, res: downloadClearResSchema },
  'download.showInFolder': {
    req: downloadShowInFolderReqSchema,
    res: downloadShowInFolderResSchema,
  },
  // Import 域（dev.119）：从其他浏览器导入收藏夹
  'import.detectBrowsers': {
    req: importDetectBrowsersReqSchema,
    res: importDetectBrowsersResSchema,
  },
  'import.bookmarksFromFile': {
    req: importBookmarksFromFileReqSchema,
    res: importBookmarksFromFileResSchema,
  },
  'import.bookmarksFromBrowser': {
    req: importBookmarksFromBrowserReqSchema,
    res: importBookmarksFromBrowserResSchema,
  },
  'dialog.selectDirectory': {
    req: dialogSelectDirectoryReqSchema,
    res: dialogSelectDirectoryResSchema,
  },
  'file.stat': { req: fileStatReqSchema, res: fileStatResSchema },
  'file.read': { req: fileReadReqSchema, res: fileReadResSchema },
  'file.write': { req: fileWriteReqSchema, res: fileWriteResSchema },
  'file.saveAs': { req: fileSaveAsReqSchema, res: fileSaveAsResSchema },
  'file.open': { req: fileOpenReqSchema, res: fileOpenResSchema },
  'file.dir': { req: fileDirReqSchema, res: fileDirResSchema },
  'editor.saveDraft': { req: editorSaveDraftReqSchema, res: editorSaveDraftResSchema },
  'editor.cleanupDraft': { req: editorCleanupDraftReqSchema, res: editorCleanupDraftResSchema },
  'file-association.register': {
    req: fileAssociationRegisterReqSchema,
    res: fileAssociationRegisterResSchema,
  },
  'file-association.getStatus': {
    req: fileAssociationGetStatusReqSchema,
    res: fileAssociationGetStatusResSchema,
  },
  'ai.chat.start': { req: aiChatStartReqSchema, res: aiChatStartResSchema },
  'ai.chat.abort': { req: aiChatAbortReqSchema, res: aiChatAbortResSchema },
  'ai.agent.start': { req: aiAgentStartReqSchema, res: aiAgentStartResSchema },
  'ai.agent.abort': { req: aiAgentAbortReqSchema, res: aiAgentAbortResSchema },
  'pi.providers': { req: piProvidersReqSchema, res: piProvidersResSchema },
  'ai.screenshot': { req: aiScreenshotReqSchema, res: aiScreenshotResSchema },
  'ai.uploadFile': { req: aiUploadFileReqSchema, res: aiUploadFileResSchema },
  'ai.setWorkdir': { req: aiSetWorkdirReqSchema, res: aiSetWorkdirResSchema },
  // pi 网页版启动器（阶段 1）：launch / status / stop
  'piWeb.launch': { req: piWebLaunchReqSchema, res: piWebLaunchResSchema },
  'piWeb.status': { req: piWebStatusReqSchema, res: piWebStatusResSchema },
  'piWeb.stop': { req: piWebStopReqSchema, res: piWebStopResSchema },
  // DeepSeek Harness 启动器：launch / status / stop（标签关闭后自动停止）
  'deepseekHarness.launch': {
    req: deepseekHarnessLaunchReqSchema,
    res: deepseekHarnessLaunchResSchema,
  },
  'deepseekHarness.status': {
    req: deepseekHarnessStatusReqSchema,
    res: deepseekHarnessStatusResSchema,
  },
  'deepseekHarness.stop': { req: deepseekHarnessStopReqSchema, res: deepseekHarnessStopResSchema },
  // 整屏框选截图（地址栏按钮）：与 ai.screenshot（pi 全屏回传）不同，框选裁剪存数据目录
  'screenshot.capture': { req: screenshotCaptureReqSchema, res: screenshotCaptureResSchema },
  'screenshot.getImageData': {
    req: screenshotGetImageDataReqSchema,
    res: screenshotGetImageDataResSchema,
  },
  'screenshot.confirm': { req: screenshotConfirmReqSchema, res: screenshotConfirmResSchema },
  'screenshot.cancel': { req: screenshotCancelReqSchema, res: screenshotCancelResSchema },
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
  // Translate 域（M24 网页翻译 · 免费双引擎，进度经 translate:progress 事件推送）
  'translate.start': { req: translateStartReqSchema, res: translateStartResSchema },
  'translate.stop': { req: translateStopReqSchema, res: translateStopResSchema },
  'translate.getStatus': { req: translateGetStatusReqSchema, res: translateGetStatusResSchema },
  'translate.translateSelection': {
    req: translateSelectionReqSchema,
    res: translateSelectionResSchema,
  },
  // Mail 域（M25 邮箱模块）
  'mail.account.list': { req: mailAccountListReqSchema, res: mailAccountListResSchema },
  'mail.account.add': { req: mailAccountAddReqSchema, res: mailAccountAddResSchema },
  'mail.account.delete': { req: mailAccountDeleteReqSchema, res: mailAccountDeleteResSchema },
  'mail.account.test': { req: mailAccountTestReqSchema, res: mailAccountTestResSchema },
  'mail.folder.list': { req: mailFolderListReqSchema, res: mailFolderListResSchema },
  'mail.message.list': { req: mailMessageListReqSchema, res: mailMessageListResSchema },
  'mail.message.fetch': { req: mailMessageFetchReqSchema, res: mailMessageFetchResSchema },
  'mail.message.markRead': { req: mailMessageMarkReadReqSchema, res: mailMessageMarkReadResSchema },
  'mail.message.translate': {
    req: mailMessageTranslateReqSchema,
    res: mailMessageTranslateResSchema,
  },
  'mail.message.send': { req: mailMessageSendReqSchema, res: mailMessageSendResSchema },
  'mail.attachment.select': {
    req: mailAttachmentSelectReqSchema,
    res: mailAttachmentSelectResSchema,
  },
  // Update 域（M20 提前落地，dev.114）：设置页更新按钮 → GitHub Releases 自动更新。
  // 进度经 `update:event` 推送（同 translate:progress 模式），4 个 RPC 返回状态快照。
  'update.getState': { req: updateGetStateReqSchema, res: updateGetStateResSchema },
  'update.check': { req: updateCheckReqSchema, res: updateCheckResSchema },
  'update.download': { req: updateDownloadReqSchema, res: updateDownloadResSchema },
  'update.install': { req: updateInstallReqSchema, res: updateInstallResSchema },
  // DevTools 域（M15 一期 · CDP 采集检视面板）：见 events.ts 的事件通道
  // devtools:event / devtools:toggle。本期不开放原始 cdp.send（DT10）。
  'devtools.attach': { req: devtoolsAttachReqSchema, res: devtoolsAttachResSchema },
  'devtools.detach': { req: devtoolsDetachReqSchema, res: devtoolsDetachResSchema },
  'devtools.status': { req: devtoolsStatusReqSchema, res: devtoolsStatusResSchema },
  'devtools.network.list': { req: devtoolsNetworkListReqSchema, res: devtoolsNetworkListResSchema },
  'devtools.network.clear': {
    req: devtoolsNetworkClearReqSchema,
    res: devtoolsNetworkClearResSchema,
  },
  'devtools.console.list': { req: devtoolsConsoleListReqSchema, res: devtoolsConsoleListResSchema },
  'devtools.console.clear': {
    req: devtoolsConsoleClearReqSchema,
    res: devtoolsConsoleClearResSchema,
  },
  'devtools.evaluate': { req: devtoolsEvaluateReqSchema, res: devtoolsEvaluateResSchema },
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
