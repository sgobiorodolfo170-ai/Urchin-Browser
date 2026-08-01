/**
 * M2 Tab Manager · 模块入口
 *
 * 依据：04-模块全景 M2 / 02-架构设计 §1 进程模型 / 契约 D
 */
export { TabManager } from './tab-manager';
export { createBrowserView } from './create-browser-view';
export { registerTabHandlers } from './register-handlers';
export { installTabViewIntegration, getLayoutState, setLayoutState } from './view-integration';
export type { TabEventPayload, TabViewIntegrationHandle, LayoutState } from './view-integration';
export type {
  WebContentsLike,
  BrowserViewLike,
  BrowserViewFactory,
  Tab,
  TabSnapshot,
  CreateTabOptions,
  TabEvent,
  TabEventListener,
} from './types';
