/**
 * M1 Window Lifecycle · 模块入口
 *
 * 依据：04-模块全景 M1 / 02-架构设计 §1 进程模型
 */
export { WindowManager } from './window-manager';
export { createBrowserWindow } from './create-window';
export { registerWindowHandlers } from './register-handlers';
export type {
  BrowserWindowLike,
  ManagedWindow,
  CreateWindowOptions,
  BrowserWindowFactory,
  WindowEvent,
  WindowEventListener,
} from './types';
