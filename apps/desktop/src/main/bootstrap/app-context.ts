/**
 * AppContext · 主进程全局状态容器
 *
 * 依据：docs/refactor-plan-p2.md §1.1-1.2（P2 拆分规划 Session 1）
 * 设计理由：performCleanup 与 registerIpcHandlers 原先闭包引用 index.ts 的
 * 31 个模块级 let + 2 个顶层常量。拆分到独立文件（lifecycle/cleanup.ts、
 * bootstrap/handlers.ts）前，必须先把这些可变状态打包成显式传递的上下文
 * 对象——提取时只移动函数体并传入 ctx，闭包依赖即随之消失。
 *
 * 约定：
 * - readonly 字段为进程生命周期内不变的单例（windowManager / tabManager）；
 * - 其余字段多数在 app.whenReady 内初始化，初始化前的语义与原
 *   `let x!: T`（确信赋值断言）一致——使用方信任初始化顺序；
 * - 函数局部控制流变量（GenOffice 关窗守卫的 allowClose、会话恢复的
 *   restored / activeTabId / mainWindowOpts）不进入本上下文：它们不被
 *   cleanup / handlers 闭包引用，且 allowClose 必须保持每窗口一份
 *   （进 ctx 会跨窗口共享，属行为变更）。
 */
import type { WindowManager } from '../windows';
import type { TabManager, TabViewIntegrationHandle } from '../tabs';
import type { HistoryManager } from '../history';
import type { BookmarkManager } from '../bookmarks';
import type { FaviconService } from '../favicons/favicon-service';
import type { SettingsManager } from '../settings';
import type { WorkspaceRegistry, WorkspaceSessionManager } from '../workspaces';
import type { ProviderRegistry } from '../orchestrator/provider-registry';
import type { Orchestrator } from '../orchestrator/orchestrator';
import type { ProviderConfigStore } from '../ai';
import type { GenOfficeIntegration } from '../genoffice/integration';
import type { BookmarkPanel } from '../panel/bookmark-panel';
import type { StatusBarOverlay } from '../status-bar/status-bar-overlay';
import type { StatusBarBall } from '../status-bar/status-bar-ball';
import type { SelectionCardOverlay } from '../translate/selection-card-overlay';
import type { DshLauncher } from '../deepseek-harness';
import type { PiWebHostLauncher } from '../pi-web-host';
import type { StorageLayer } from '../storage';
import type { MailContentStore } from '../mail';
import type { TranslateManager } from '../translate/translate-manager';
import type { TrayManager } from '../tray';

/** 主进程全局状态：performCleanup / registerIpcHandlers 的闭包变量打包。 */
export interface AppContext {
  /** 全局 WindowManager 实例（M1）：单例管理所有窗口，保证 windowId 全局唯一。 */
  readonly windowManager: WindowManager;

  /**
   * 全局 TabManager 实例（M2）。主进程是 Single Source of Truth，渲染层
   * store 只是镜像。TP7 工作区：工厂按标签的工作区 id 解析 session。
   */
  readonly tabManager: TabManager;

  /**
   * 当前生效的用户数据目录（DD1 决策；app ready 前解析，供截图等按数据
   * 目录落盘的功能读取）。
   */
  currentDataDir: string;

  /**
   * 全局 HistoryManager 实例（M6）。在 app.whenReady() 中初始化，注入
   * StorageLayer 持久化。启动时从 SQLite 加载已有历史记录，变更时同步写入。
   */
  historyManager: HistoryManager;

  /**
   * 全局 BookmarkManager 实例（M5）。在 app.whenReady() 中初始化，注入
   * StorageLayer 持久化。启动时从 SQLite 加载已有书签，变更时同步写入。
   */
  bookmarkManager: BookmarkManager;

  /**
   * 全局 favicon 缓存服务（M2 图标链路）。在 app.whenReady() 中按当前
   * 数据目录初始化；协议与 TabManager 共用。
   */
  faviconService: FaviconService | undefined;

  /** 全局 SettingsManager 实例（M7）。在 app.whenReady() 中初始化，注入 StorageLayer 持久化。 */
  settingsManager: SettingsManager;

  /**
   * 全局 WorkspaceRegistry 实例（TP7 工作区）。在 app.whenReady() 中初始化
   * （依赖 SettingsManager 持久化 + 下载管理器）。只管元数据；session 分区
   * 在首开工作区标签时惰性配置。
   */
  workspaceRegistry: WorkspaceRegistry;

  /** 全局 WorkspaceSessionManager 实例（TP7 工作区）：自定义工作区 = 持久化分区。 */
  workspaceSessions: WorkspaceSessionManager;

  /**
   * Provider 注册表（M11）：扫描 %APPDATA%/Urchin/providers/ 目录。
   * 在 app.whenReady() 内初始化，避免模块加载阶段触碰文件系统。
   */
  providerRegistry: ProviderRegistry;

  /** AI Orchestrator（M11/M12）：管理 Provider utility 子进程生命周期。 */
  orchestrator: Orchestrator;

  /** per-provider 配置存储（M12 契约边界）。 */
  providerConfigStore: ProviderConfigStore;

  /** TabManager ↔ WindowManager 集成句柄（BrowserView 挂载 + 事件推送）。 */
  tabViewIntegration: TabViewIntegrationHandle | null;

  /** 右键菜单（复制/粘贴/保存网页）卸载句柄（installTabContextMenu 返回）。退出时移除 created 监听。 */
  disposeContextMenu: (() => void) | null;

  /** Ctrl+滚轮缩放卸载句柄（installZoomControl 返回）。退出时移除 created 监听。 */
  disposeZoomControl: (() => void) | null;

  /** 中转区拖拽注入卸载句柄（installDragInjection 返回）。退出时移除 created 监听。 */
  disposeDragInjection: (() => void) | null;

  /** 网页翻译管理器卸载句柄（dev.80，M24：停轮询/移除导航钩子/清状态）。 */
  disposeTranslateManager: (() => void) | null;

  /** 网页翻译管理器引用（dev.81：右键菜单翻译动作与划词结果回传使用）。 */
  translateManagerRef: TranslateManager | null;

  /** M15 DevTools 管理器卸载句柄（dev.121，CDP 会话清理）。 */
  disposeDevtoolsManager: (() => void) | null;

  /** M15 DevTools F12 快捷键卸载句柄（dev.121）。 */
  disposeDevtoolsShortcuts: (() => void) | null;

  /** GenOffice 编辑器集成（阶段 2）：tab.create 分流 / tab.close 与窗口关闭守卫。 */
  genofficeIntegration: GenOfficeIntegration | null;

  /** 收藏夹悬浮面板（独立子窗口，悬浮于网页之上）。在 whenReady 内初始化。 */
  bookmarkPanel: BookmarkPanel | null;

  /**
   * picker 模式待存页面上下文（星标按钮未收藏时 ui.panel.saveBookmarkPicker
   * 写入，面板加载 ?mode=picker 后经 ui.panel.getPickerContext 读取）。
   */
  bookmarkPickerContext: { url: string; title: string } | null;

  /** 底部悬浮状态栏（独立透明子窗口，悬浮于网页之上）。在 whenReady 内初始化。 */
  statusBarOverlay: StatusBarOverlay | null;

  /** 悬浮球（独立透明子窗口，网页区右侧）。在 whenReady 内初始化。 */
  statusBarBall: StatusBarBall | null;

  /** 划词翻译结果卡（独立透明子窗口，悬浮于网页之上）。在 whenReady 内初始化。 */
  selectionCardOverlay: SelectionCardOverlay | null;

  /**
   * 系统托盘驻留管理器（2026-11-10 用户需求）：设置 `ui.minimizeToTray`
   * 开启时拦截窗口 close 改为隐藏，托盘菜单提供唤回与完全退出。
   * 在窗口创建后初始化；退出清理时 dispose（销毁托盘 + 解绑监听）。
   */
  trayManager: TrayManager | null;

  /**
   * AI IPC handlers 的 dispose 句柄（由 registerAiHandlers 返回）。
   * 进程退出时调用 dispose()，abort 所有活跃 chat/agent 流，间接触发
   * stream.ts / pi-event-bridge.ts 的 cleanup()，释放 listener、MessagePort
   * 和 HTTP 连接。
   */
  aiHandlersDispose: (() => void) | null;

  /**
   * DeepSeek Harness 启动器：系统 Node 子进程运行 vendor/deepseek-harness
   * (dsh web)。进程退出时 performCleanup 调用 dispose() 终止子进程树。
   * 标签关闭后自动停止后端（bindTabCloseToStop）。
   */
  dshLauncher: DshLauncher | null;

  /** dsh 标签关闭→停止 unbind 函数（performCleanup 调用）。 */
  unbindDshTabClose: (() => void) | null;

  /**
   * pi 阶段 2 自研托管服务启动器：Electron utilityProcess 运行
   * @urchin/pi-web-host（HTTP 静态 + WebSocket + 随机 token 鉴权）。
   * 进程退出时 performCleanup 调用 dispose() 终止 utility 子进程。
   * 阶段 1（pi-web-ui）已于 M2C 退役。
   */
  piWebHostLauncher: PiWebHostLauncher | null;

  /**
   * 全局 StorageLayer 引用（在 whenReady 中赋值）。退出时需调用 close()
   * 以释放 better-sqlite3 原生句柄，避免进程退出后残留线程或 WAL 文件
   * 未 checkpoint。
   */
  storageLayer: StorageLayer | null;

  /**
   * M25 邮箱正文内容库（在 whenReady 中赋值）。协议路由
   * urchin://mail-content/<token> 据此取已 sanitize 的 HTML 下发；
   * registerUrchinProtocol 的 getMailContent 回调以闭包引用本变量
   * （惰性求值——请求到达时本变量已初始化，无启动时序问题）。
   */
  mailContentStore: MailContentStore | null;

  /**
   * 退出清理标志位：避免 before-quit 与 window-all-closed / SIGINT 重复
   * 执行清理。第一次进入清理流程时置为 true，后续直接退出。
   */
  isCleaningUp: boolean;

  /**
   * 清理完成标志位：异步清理完成后置为 true，使 before-quit 重入时不再
   * preventDefault，允许进程真正退出。
   */
  cleanupDone: boolean;
}
