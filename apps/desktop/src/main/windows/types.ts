/**
 * M1 Window Lifecycle · 类型定义
 *
 * 依据：02-架构设计 §1 进程模型 / 04-模块全景 M1
 *
 * 设计理由（agents.md §七.2）：
 * BrowserWindowLike 接口将 WindowManager 与 Electron BrowserWindow 解耦，
 * 使 WindowManager 的核心逻辑（ID 分配 / 集合管理 / 事件分发）可在单测中
 * 用 mock 验证，无需启动真实 Electron 实例。
 */

/**
 * BrowserWindow 的最小依赖接口（便于测试 mock）。
 * 完整实现由 Electron 在运行时提供。
 */
export interface BrowserWindowLike {
  /** Electron 内部 webContents id（用于 IPC 事件推送） */
  readonly webContents: { readonly id: number };
  /** 显示窗口 */
  show(): void;
  /** 隐藏窗口 */
  hide(): void;
  /** 关闭窗口（触发 'closed' 事件） */
  close(): void;
  /** 最小化 */
  minimize(): void;
  /** 最大化 */
  maximize(): void;
  /** 取消最大化 */
  unmaximize(): void;
  /** 是否已最大化 */
  isMaximized(): boolean;
  /** 设置全屏 */
  setFullScreen(flag: boolean): void;
  /** 是否全屏 */
  isFullScreen(): boolean;
  /** 从最小化/最大化恢复 */
  restore(): void;
  /** 注册事件监听 */
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * 受管理的窗口实例：包含 Urchin 内部 windowId 与 BrowserWindow 引用。
 */
export interface ManagedWindow {
  /** Urchin 内部窗口 ID（单调递增正整数，与 BrowserWindow.id 不同） */
  readonly id: number;
  /** 底层 BrowserWindow 实例 */
  readonly browserWindow: BrowserWindowLike;
  /** 是否为隐私窗口 */
  readonly isIncognito: boolean;
}

/**
 * 创建窗口的选项。
 */
export interface CreateWindowOptions {
  /** 初始 URL（可选，默认走主进程加载逻辑） */
  url?: string;
  /** 是否隐私窗口 */
  incognito?: boolean;
  /** 初始宽度 */
  width?: number;
  /** 初始高度 */
  height?: number;
}

/**
 * BrowserWindow 工厂函数类型（依赖注入）。
 * WindowManager 通过它创建真实 BrowserWindow，测试时注入 mock。
 */
export type BrowserWindowFactory = (opts: CreateWindowOptions) => BrowserWindowLike;

/**
 * 窗口事件类型。
 */
export type WindowEvent = 'window-created' | 'window-closed';

/**
 * 窗口事件监听器。
 */
export type WindowEventListener = (windowId: number) => void;
