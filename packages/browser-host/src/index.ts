/**
 * @urchin/browser-host · 浏览器宿主 API 契约包入口
 *
 * 导出 Host API 接口与相关类型，供扩展模块（如 AI 模块）声明对宿主的依赖。
 *
 * 用法：
 *   import type { BrowserHostApi } from '@urchin/browser-host';
 *
 *   // 扩展模块入口
 *   function bootstrap(host: BrowserHostApi) {
 *     // 通过 host.page / host.tabs / host.ai 等访问能力
 *   }
 *
 * 注意：本包仅导出类型与接口，不含任何运行时代码。
 * 实现侧在浏览器核心主进程 + preload 中完成。
 */
export type {
  // 通用
  OkResult,
  ErrorResult,
  Result,
  Unsubscribe,
  MessagePortLike,
  // Page
  ExtractionMethod,
  ExtractedPageContext,
  ActiveTabInfo,
  PageApi,
  // Tabs
  TabSnapshot,
  TabEvent,
  TabsApi,
  // Settings
  SettingsApi,
  // Storage
  StorageApi,
  // AI
  ProviderInfo,
  ChatMessage,
  StreamMessage,
  ProviderEvent,
  AiApi,
  // Lifecycle
  LifecycleEvent,
  LifecycleApi,
  // Input（截图、上传文件、设置工作目录）
  ScreenshotResult,
  UploadedFile,
  InputApi,
  // Workspace
  WorkspaceProject,
  FileEntry,
  WorkspaceApi,
  // 顶层
  BrowserHostApi,
} from './api.js';
