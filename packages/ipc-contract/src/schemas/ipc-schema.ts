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
  'download.list': { req: downloadListReqSchema, res: downloadListResSchema },
  'download.cancel': { req: downloadCancelReqSchema, res: downloadCancelResSchema },
  'download.pause': { req: downloadPauseReqSchema, res: downloadPauseResSchema },
  'download.resume': { req: downloadResumeReqSchema, res: downloadResumeResSchema },
  'download.clear': { req: downloadClearReqSchema, res: downloadClearResSchema },
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
