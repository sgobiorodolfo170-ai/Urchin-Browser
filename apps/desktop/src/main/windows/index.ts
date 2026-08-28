/**
 * M1 Window Lifecycle · 模块入口
 *
 * 依据：04-模块全景 M1 / 02-架构设计 §1 进程模型
 */
export { WindowManager } from './window-manager';
export { createBrowserWindow } from './create-window';
export { registerWindowHandlers } from './register-handlers';
export { loadWindowState, trackWindowState, WINDOW_STATE_SETTINGS_KEY } from './window-state';
export type {
  WindowState,
  TrackedWindow,
  WindowStateSettings,
  DisplayBoundsProvider,
} from './window-state';
export {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from './window-geometry';
export type {
  BrowserWindowLike,
  ManagedWindow,
  CreateWindowOptions,
  BrowserWindowFactory,
  WindowEvent,
  WindowEventListener,
} from './types';
