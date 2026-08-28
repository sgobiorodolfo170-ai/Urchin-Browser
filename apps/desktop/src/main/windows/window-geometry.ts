/**
 * M1 Window Lifecycle · 窗口几何常量（单一真源）
 *
 * create-window（创建时应用）与 window-state（恢复/保存校验）共用，
 * 独立成值模块避免两处硬编码漂移，且不引入 electron 依赖（可被纯单测导入）。
 */

/** 默认窗口尺寸（首次启动 / 无可恢复记录时） */
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;

/** 窗口最小尺寸（BrowserWindow minWidth/minHeight，同时约束可恢复的记录） */
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
