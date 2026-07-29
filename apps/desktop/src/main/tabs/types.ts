/**
 * M2 Tab Manager · 类型定义
 *
 * 依据：契约 D §2 / 02-架构设计 §1 进程模型 / 04-模块全景 M2
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「可序列化」）：
 * - Tab 含不可序列化的 webContents/view，仅存在于主进程
 * - TabSnapshot 是可序列化快照，用于跨进程传输与渲染层 store 镜像
 * - BrowserViewLike / WebContentsLike 接口将 TabManager 与 Electron 解耦，使核心逻辑可单测
 */

/**
 * WebContents 的最小依赖接口（便于测试 mock）。
 */
export interface WebContentsLike {
  /** 加载 URL */
  loadURL(url: string): void;
  /** 重新加载 */
  reload(): void;
  /** 忽略缓存重新加载 */
  reloadIgnoringCache(): void;
  /** 停止加载 */
  stop(): void;
  /** 返回 */
  goBack(): void;
  /** 前进 */
  goForward(): void;
  /** 是否可返回 */
  canGoBack(): boolean;
  /** 是否可前进 */
  canGoForward(): boolean;
  /** 销毁 */
  destroy(): void;
  /** 注册事件监听 */
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * BrowserView 的最小依赖接口（便于测试 mock）。
 */
export interface BrowserViewLike {
  /** 关联的 webContents */
  readonly webContents: WebContentsLike;
  /** 设置边界 */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

/**
 * BrowserView 工厂函数类型（依赖注入）。
 * TabManager 通过它创建真实 BrowserView，测试时注入 mock。
 */
export type BrowserViewFactory = () => BrowserViewLike;

/**
 * Tab 内部状态（主进程持有，含不可序列化的 webContents/view）。
 */
export interface Tab {
  /** Tab ID（单调递增正整数） */
  readonly id: number;
  /** 所属窗口 ID */
  readonly windowId: number;
  /** 当前 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 网站图标 URL */
  favicon?: string;
  /** 是否激活（每窗口仅一个 active tab） */
  active: boolean;
  /** 是否加载中 */
  loading: boolean;
  /** 是否可返回 */
  canGoBack: boolean;
  /** 是否可前进 */
  canGoForward: boolean;
  /** 是否崩溃 */
  crashed: boolean;
  /** 在窗口中的位置索引 */
  indexInWindow: number;
  /** 底层 webContents（仅主进程持有） */
  readonly webContents: WebContentsLike;
  /** 底层 BrowserView（仅主进程持有） */
  readonly view: BrowserViewLike;
}

/**
 * Tab 快照（可序列化，跨进程传输用）。
 * 剔除不可序列化的 webContents / view 字段。
 */
export interface TabSnapshot {
  readonly id: number;
  readonly windowId: number;
  readonly url: string;
  readonly title: string;
  readonly favicon?: string;
  readonly active: boolean;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly crashed: boolean;
  readonly indexInWindow: number;
}

/**
 * 创建 Tab 的选项。
 */
export interface CreateTabOptions {
  /** 所属窗口 ID */
  windowId: number;
  /** 初始 URL（可选，默认 about:blank） */
  url?: string;
  /** 是否激活（默认 true） */
  active?: boolean;
  /** 在窗口中的位置索引（可选，追加到末尾） */
  index?: number;
}

/**
 * Tab 事件类型。
 */
export type TabEvent = 'created' | 'updated' | 'removed' | 'activated' | 'crashed';

/**
 * Tab 事件监听器。
 */
export type TabEventListener = (tab: TabSnapshot) => void;
