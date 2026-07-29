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
