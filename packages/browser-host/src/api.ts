/**
 * @urchin/browser-host · Host API 契约定义
 *
 * 设计依据：ADR-008 v0.1 范围与工期 / 02-架构设计 §4 安全边界
 *
 * 定位：
 *   本包定义「扩展模块（如 AI 模块）↔ 浏览器核心」之间的标准 Host API。
 *   AI 模块作为独立标签页应用（urchin://ai），通过此接口访问浏览器核心能力
 *   （页面上下文、tab 管理、设置、存储、AI Provider 等），不直接耦合具体实现。
 *
 * 解耦目标：
 *   1. AI 模块可独立升级迭代，不影响浏览器主功能区
 *   2. AI 模块可声明它对宿主的最小依赖，便于移植到其他宿主
 *   3. 浏览器核心可自由重构内部实现，只要满足 Host API 契约即可
 *
 * 安全约束：
 *   - Host API 不暴露任意文件系统/Shell 访问
 *   - 仅 fs/workspace 命名空间在用户授权目录内提供受限访问
 *   - 所有调用经 IPC + zod 校验，主进程是 Single Source of Truth
 */

// ============================================================================
// 通用基础类型
// ============================================================================

/** 受理结果：成功 */
export interface OkResult {
  readonly ok: true;
}

/** 失败结果，附带错误码与消息 */
export interface ErrorResult {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

/** 联合结果类型 */
export type Result<T> = { readonly ok: true; readonly value: T } | ErrorResult;

/** 取消订阅函数（用于事件订阅） */
export type Unsubscribe = () => void;

// ============================================================================
// Page 命名空间：当前页面上下文
// ============================================================================

/** 页面抽取方法 */
export type ExtractionMethod = 'readability' | 'dom-simplified' | 'raw-text';

/** 抽取出的页面上下文 */
export interface ExtractedPageContext {
  readonly url: string;
  readonly title: string;
  readonly extractedAt: string;
  readonly byline?: string;
  readonly excerpt?: string;
  readonly textContent: string;
  readonly markdown: string;
  readonly length: number;
  readonly language?: string;
  readonly siteName?: string;
  readonly extraction_method: ExtractionMethod;
  readonly warnings: readonly string[];
}

/** 活跃 Tab 信息（AI 模块关心的最小字段集） */
export interface ActiveTabInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
}

/** Page 命名空间：访问当前激活 tab 的页面上下文 */
export interface PageApi {
  /** 抽取指定 tab 的页面正文 */
  readonly extract: (tabId: number, maxLength?: number) => Promise<ExtractedPageContext>;
  /** 获取当前激活 tab 信息 */
  readonly getActive: () => Promise<ActiveTabInfo | null>;
}

// ============================================================================
// Tabs 命名空间：tab 管理
// ============================================================================

/** Tab 快照（AI 模块关心的最小字段集） */
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

/** Tab 事件 */
export type TabEvent =
  | { readonly type: 'created'; readonly snapshot: TabSnapshot }
  | { readonly type: 'updated'; readonly snapshot: TabSnapshot }
  | { readonly type: 'removed'; readonly snapshot: TabSnapshot }
  | { readonly type: 'activated'; readonly snapshot: TabSnapshot }
  | { readonly type: 'crashed'; readonly snapshot: TabSnapshot };

/** Tabs 命名空间：tab 创建/激活/列表 + 事件订阅 */
export interface TabsApi {
  /** 创建新 tab */
  readonly create: (url: string, active?: boolean) => Promise<TabSnapshot>;
  /** 关闭 tab */
  readonly close: (tabId: number) => Promise<OkResult>;
  /** 激活 tab */
  readonly setActive: (tabId: number) => Promise<TabSnapshot>;
  /** 列出当前窗口的 tab */
  readonly list: () => Promise<readonly TabSnapshot[]>;
  /** 在指定 tab 内导航 */
  readonly loadUrl: (tabId: number, url: string) => Promise<OkResult>;
  /** 订阅 tab 事件 */
  readonly onEvent: (handler: (event: TabEvent) => void) => Unsubscribe;
}

// ============================================================================
// Settings 命名空间：设置读写
// ============================================================================

/** Settings 命名空间：读写浏览器核心设置（含 AI 配置） */
export interface SettingsApi {
  /** 读取设置值，未配置返回 null */
  readonly get: <T = unknown>(key: string) => Promise<T | null>;
  /** 写入设置值 */
  readonly set: (key: string, value: unknown) => Promise<OkResult>;
  /** 读取全部设置 */
  readonly getAll: () => Promise<readonly { key: string; value: unknown }[]>;
  /** 订阅设置变更 */
  readonly onChanged: (handler: (key: string, value: unknown) => void) => Unsubscribe;
}

// ============================================================================
// Storage 命名空间：AI 模块私有存储
// ============================================================================

/**
 * Storage 命名空间：AI 模块私有键值存储。
 *
 * 数据存储在 ai.db，与其他扩展模块隔离。
 * 大文件应使用 fs 命名空间，而非 storage。
 */
export interface StorageApi {
  readonly get: <T = unknown>(key: string) => Promise<T | null>;
  readonly set: <T>(key: string, value: T) => Promise<OkResult>;
  readonly delete: (key: string) => Promise<OkResult>;
  readonly keys: (prefix?: string) => Promise<readonly string[]>;
}

// ============================================================================
// AI 命名空间：AI 服务访问
// ============================================================================

/** Provider 信息 */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly authMethod: 'api_key' | 'oauth' | 'none' | 'local';
  readonly rateLimit?: { readonly requestsPerMin: number; readonly tokensPerMin?: number };
}

/** 对话消息 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 流式消息类型 */
export type StreamMessage =
  | {
      readonly kind: 'stream.chunk';
      readonly conversationId: string;
      readonly chunk: { readonly content?: string; readonly role?: string };
    }
  | {
      readonly kind: 'stream.end';
      readonly conversationId: string;
      readonly finishReason?: string;
      readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
    }
  | {
      readonly kind: 'error';
      readonly conversationId: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable?: boolean;
      };
    }
  | { readonly kind: 'abort'; readonly conversationId: string };

/** Provider 事件 */
export type ProviderEvent =
  | {
      readonly type: 'state-changed';
      readonly providerId: string;
      readonly state: 'initializing' | 'ready' | 'crashed' | 'disposed';
    }
  | { readonly type: 'crashed'; readonly providerId: string; readonly reason: string };

/** AI 命名空间：访问浏览器核心的 AI 编排能力 */
export interface AiApi {
  /** 列出已注册 Provider */
  readonly listProviders: () => Promise<readonly ProviderInfo[]>;
  /** 重新扫描 Provider 目录 */
  readonly rescanProviders: () => Promise<readonly ProviderInfo[]>;
  /** 启动流式对话 */
  readonly startChat: (params: {
    readonly providerId: string;
    readonly conversationId: string;
    readonly messages: readonly ChatMessage[];
    readonly model: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
  }) => Promise<{ readonly conversationId: string }>;
  /** 中止对话 */
  readonly abortChat: (conversationId: string) => Promise<OkResult>;
  /** 订阅 MessagePort 下发（用于接收流式 chunk） */
  readonly onStreamPort: (
    handler: (conversationId: string, port: MessagePortLike) => void,
  ) => Unsubscribe;
  /** 订阅 Provider 事件 */
  readonly onProviderEvent: (handler: (event: ProviderEvent) => void) => Unsubscribe;
}

// ============================================================================
// Lifecycle 命名空间：扩展模块生命周期
// ============================================================================

/** Lifecycle 事件 */
export type LifecycleEvent =
  | 'mount' // 扩展模块挂载（tab 创建后）
  | 'activate' // tab 激活
  | 'deactivate' // tab 失活
  | 'unmount'; // tab 关闭

/** Lifecycle 命名空间：扩展模块生命周期钩子 */
export interface LifecycleApi {
  /** 通知宿主扩展已就绪（在扩展入口调用） */
  readonly ready: () => Promise<OkResult>;
  /** 订阅生命周期事件 */
  readonly onEvent: (handler: (event: LifecycleEvent) => void) => Unsubscribe;
}

// ============================================================================
// Input 命名空间：截图、上传文件、设置工作目录
// ============================================================================

/** 截图结果 */
export interface ScreenshotResult {
  /** data URI 格式：data:image/png;base64,xxxx */
  readonly dataUri: string;
  /** MIME 类型，如 image/png */
  readonly mimeType: string;
  /** base64 编码数据（不含 data: 前缀） */
  readonly base64: string;
  /** 截图来源显示器 ID */
  readonly displayId?: string;
}

/** 上传文件信息 */
export interface UploadedFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
  readonly base64: string;
  readonly isImage: boolean;
}

/** Input 命名空间：原生输入辅助能力 */
export interface InputApi {
  /** 截取全屏，返回 base64 PNG */
  readonly screenshot: () => Promise<ScreenshotResult>;
  /** 弹出文件选择器，读取选中文件 */
  readonly uploadFile: (options?: {
    readonly title?: string;
    readonly filters?: readonly string[];
    readonly multiple?: boolean;
  }) => Promise<readonly UploadedFile[]>;
  /** 弹出目录选择器，返回工作目录路径 */
  readonly setWorkdir: (options?: { readonly title?: string }) => Promise<{
    readonly path: string | null;
    readonly exists: boolean;
    readonly entryCount?: number;
  }>;
}

// ============================================================================
// Workspace 命名空间：本地项目开发能力（v0.1 阶段6 实现）
// ============================================================================

/** 工作区项目信息 */
export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 文件入口（目录或文件） */
export interface FileEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly modifiedAt: number;
}

/**
 * Workspace 命名空间：本地项目开发能力。
 *
 * 设计依据：阶段6（本地开发能力）
 * - 所有访问限定在用户授权的项目目录内
 * - shell 仅允许白名单命令（避免任意命令执行）
 * - 通过 settings.workspace.allowedPaths 控制授权范围
 */
export interface WorkspaceApi {
  /** 列出已添加的项目 */
  readonly listProjects: () => Promise<readonly WorkspaceProject[]>;
  /** 添加项目（弹出原生目录选择器，路径写入授权列表） */
  readonly addProject: () => Promise<WorkspaceProject | null>;
  /** 移除项目（仅从列表移除，不删除文件） */
  readonly removeProject: (projectId: string) => Promise<OkResult>;
  /** 列出项目内文件（限定在授权目录内） */
  readonly listFiles: (projectId: string, dirPath: string) => Promise<readonly FileEntry[]>;
  /** 读取文件内容（限定在授权目录内） */
  readonly readFile: (
    projectId: string,
    filePath: string,
    encoding?: 'utf-8' | 'base64',
  ) => Promise<string>;
  /** 写入文件内容（限定在授权目录内） */
  readonly writeFile: (
    projectId: string,
    filePath: string,
    content: string,
    encoding?: 'utf-8' | 'base64',
  ) => Promise<OkResult>;
  /** 在项目目录内执行受限命令（白名单） */
  readonly runCommand: (
    projectId: string,
    command: string,
    args?: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
}

// ============================================================================
// 浏览器宿主 API 总接口
// ============================================================================

/**
 * BrowserHostApi：浏览器核心向扩展模块（如 AI 模块）暴露的标准能力接口。
 *
 * 实现侧：浏览器核心在主进程实现该接口，通过 preload 注入到扩展模块的渲染进程。
 * 调用侧：扩展模块通过注入的 host 对象访问能力，不直接使用 IPC。
 *
 * 注入方式：
 *   1. 主窗口 preload 通过 contextBridge.exposeInMainWorld('urchin', api) 注入
 *   2. 扩展模块通过 (window as any).urchin 访问
 *   3. 通过 host() 工厂函数获取强类型对象
 */
export interface BrowserHostApi {
  readonly page: PageApi;
  readonly tabs: TabsApi;
  readonly settings: SettingsApi;
  readonly storage: StorageApi;
  readonly ai: AiApi;
  readonly lifecycle: LifecycleApi;
  /**
   * 输入辅助命名空间：截图、上传文件、设置工作目录。
   *
   * 由浏览器核心主进程提供原生能力（desktopCapturer / dialog.showOpenDialog），
   * AI 模块通过此接口访问，不直接调用 Electron API。
   */
  readonly input: InputApi;
  /** v0.1 阶段6 启用，未实现前抛 NotSupported */
  readonly workspace?: WorkspaceApi;
  /** 平台信息 */
  readonly platform: {
    readonly os: 'win32' | 'darwin' | 'linux';
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

// ============================================================================
// MessagePort 抽象类型（避免直接依赖 DOM lib）
// ============================================================================

/**
 * MessagePort 最小接口抽象。
 *
 * 浏览器核心实现侧通过 IPC MessagePort 注入；扩展模块通过此接口接收流式 chunk。
 * 不直接依赖 DOM `MessagePort` 类型，以便包在 Node 环境下也能 typecheck。
 */
export interface MessagePortLike {
  onmessage: ((e: { readonly data: unknown }) => void) | null;
  start(): void;
  close?(): void;
}
