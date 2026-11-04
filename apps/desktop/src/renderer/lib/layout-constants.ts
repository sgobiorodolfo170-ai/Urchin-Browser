/**
 * 窗口布局尺寸常量
 *
 * 与主进程 view-integration.ts 的 BrowserView bounds 计算保持同一份数值：
 * 渲染层侧栏/地址栏宽度变化时通过 ui.layout.setState 同步，主进程据此扣减网页区域。
 * 单一真源避免两侧数值漂移（曾出现侧栏宽度与 BrowserView 不一致导致页面被遮挡）。
 */

export const LEFT_EXPANDED = 220;
export const LEFT_COLLAPSED = 44;
export const RIGHT_EXPANDED = 360;
export const RIGHT_COLLAPSED = 44;
export const BOTTOM_HEIGHT = 48;

/** Ctrl+滚轮内部页缩放步长与范围（仅作用于中区 React 内容，侧栏/地址栏不受影响） */
export const CONTENT_ZOOM_STEP = 1.1;
export const CONTENT_ZOOM_MIN = 0.25;
export const CONTENT_ZOOM_MAX = 5;

/** 右侧边栏宽度拖拽调节范围（px） */
export const RIGHT_MIN = 120;
export const RIGHT_MAX = 600;

/** 右侧边栏宽度持久化 settings key（拖拽调节后记录位置，重启恢复） */
export const RIGHT_SIDEBAR_WIDTH_KEY = 'ui.rightSidebarWidth';
