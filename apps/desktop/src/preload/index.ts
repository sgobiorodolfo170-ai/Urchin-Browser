/**
 * Urchin Browser · preload 脚本
 *
 * 依据：02-架构设计 §4 安全边界 / 契约 B §5 typedInvoke 客户端 / 契约 B §6 流式协议
 * 职责：
 * 1. 在 sandbox + contextIsolation 下暴露最小化 API 到渲染进程
 * 2. 暴露 typedInvoke 让渲染层强类型调用 Main，无需直接访问 ipcRenderer
 * 3. 暴露 on 订阅单向事件推送
 * 4. 暴露 onMessagePort 订阅 MessagePort 下发（W4 AI 流式对话用）
 *
 * 设计理由（AGENTS.md §七.2 + 项目特化审查点）：
 * 不暴露 ipcRenderer 全量 API 是因为渲染层拿到 ipcRenderer 可绕过校验。
 * 仅暴露 typedInvoke 把「类型约束 + zod 校验 + 错误解包」收口在 preload。
 * MessagePort 通过 webContents.postMessage 的 transferList 下发，
 * 需要 ipcRenderer.on 监听事件并在回调中接收 port。
 *
 * 安全边界（M18）：
 * - 主窗口渲染进程（chrome-extension:// 或 file://）：无条件暴露 urchin API
 * - BrowserView 中的外部网页（http/https/file）：不暴露 urchin API，防止恶意网站调用 IPC
 * - BrowserView 中的内部页面（urchin://）：暴露 urchin API，供设置页等应用页面调用
 */
import { contextBridge, ipcRenderer } from 'electron';
import { createTypedInvoke } from '@urchin/ipc-contract';

/**
 * 渲染进程侧 MessagePort 代理接口（方法形式）。
 *
 * ⚠️ contextBridge 限制：
 * 1. DOM MessagePort 不能直接通过 contextBridge 传递（structured clone 丢失方法）
 * 2. 暴露对象的属性 setter 不会跨上下文同步（渲染进程设置 proxy.onmessage 不会更新 preload 中的值）
 *
 * 因此采用方法形式：渲染进程通过调用 `port.onMessage(handler)` 注册消息处理器，
 * 方法调用通过 contextBridge 代理到 preload，handler 存入闭包变量。
 * 当 DOM MessagePort 收到消息时，preload 调用闭包中的 handler。
 *
 * host-impl.ts 会将此接口适配为 @urchin/browser-host 的 MessagePortLike（属性形式），
 * 供 ai-chat-view.tsx 使用，无需改动渲染层代码。
 */
export interface RendererMessagePort {
  /** 注册消息处理器（替代 DOM MessagePort 的 onmessage 属性 setter） */
  onMessage(handler: (data: unknown) => void): void;
  /** 启动 port（转发到 DOM MessagePort.start） */
  start(): void;
  /** 关闭 port（转发到 DOM MessagePort.close） */
  close?(): void;
  /** 向对端发送消息（用于 abort 信号） */
  postMessage(message: unknown): void;
}

/**
 * 创建 DOM MessagePort 的普通对象代理（方法形式）。
 *
 * 返回的 proxy 是一个 plain object（非 MessagePort 实例），
 * 其方法在 preload 上下文中闭包捕获真正的 port 和 handler，
 * 因此可以安全通过 contextBridge 跨上下文传递。
 */
function createPortProxy(port: MessagePort): RendererMessagePort {
  let messageHandler: ((data: unknown) => void) | null = null;

  // 在 preload 中监听真正的 DOM MessagePort，将消息转发到 messageHandler
  port.onmessage = (e: MessageEvent): void => {
    if (messageHandler) {
      messageHandler(e.data);
    }
  };

  return {
    onMessage: (handler: (data: unknown) => void): void => {
      messageHandler = handler;
    },
    start: () => port.start(),
    close: () => port.close(),
    postMessage: (message: unknown) => port.postMessage(message),
  };
}

// 创建类型化 invoke 客户端
const typedInvoke = createTypedInvoke(ipcRenderer);

/**
 * 暴露到渲染进程的 API 表面。
 * 渲染层通过 window.urchin.invoke(...) 调用 RPC，通过 window.urchin.on(...) 订阅事件。
 * 无 ipcRenderer 直接访问权。
 */
const api = {
  invoke: typedInvoke,
  /**
   * 订阅 main → renderer 的单向事件推送。
   * @returns 取消订阅函数
   */
  on(channel: string, callback: (payload: unknown) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  /**
   * 订阅 MessagePort 下发事件（W4 AI 流式对话用）。
   *
   * Main 进程通过 `webContents.postMessage(channel, data, [port])` 下发 MessagePort，
   * 渲染进程在 ipcRenderer 回调中通过 `event.ports[0]` 接收 DOM MessagePort。
   *
   * ⚠️ contextBridge 无法直接传递 DOM MessagePort（structured clone 丢失方法），
   * 因此 preload 内部用 createPortProxy 包装为普通对象 PortProxy，
   * 其方法通过闭包访问真正的 port。渲染层使用方式与 DOM MessagePort 一致：
   *
   * ```ts
   * window.urchin.onMessagePort('ai.chat.port', (payload, port) => {
   *   port.onmessage = (e) => { const msg = e.data; ... };
   *   port.start();
   * });
   * ```
   *
   * @returns 取消订阅函数
   */
  onMessagePort(
    channel: string,
    callback: (payload: unknown, port: RendererMessagePort) => void,
  ): () => void {
    const wrapped = (event: Electron.IpcRendererEvent, payload: unknown): void => {
      const port = event.ports[0];
      if (!port) {
        // port 缺失说明主进程未通过 transferList 传递，无法建立流式通道
        return;
      }
      // 用普通对象代理包装 port，避免 contextBridge 序列化丢失方法
      const proxy = createPortProxy(port);
      callback(payload, proxy);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  /** 平台信息（v0.1 最小集） */
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

/**
 * 安全决策：仅在受信任的来源暴露 urchin API。
 *
 * - 主窗口渲染进程（file:// 或 http://localhost:5173 dev server）：暴露
 * - BrowserView 内部协议页面（urchin://）：暴露
 * - BrowserView 外部网页（http/https/about）：不暴露，防止恶意网站调用 IPC
 *
 * 判断依据：location.protocol === 'urchin:' 或 location.protocol === 'file:'
 * （主窗口加载打包文件时为 file:）。dev server 在主窗口中加载，协议为 http:，
 * 但 hostname 为 localhost，单独放行。
 */
const protocol = typeof location !== 'undefined' ? location.protocol : '';
const hostname = typeof location !== 'undefined' ? location.hostname : '';
const isTrustedOrigin =
  protocol === 'urchin:' ||
  protocol === 'file:' ||
  (protocol === 'http:' && hostname === 'localhost');

/**
 * GenOffice AI 桥（阶段 3）。
 *
 * 背景：GenOffice 原生 AI 的通道（ai:*）由 vendor 嵌入包在主进程注册，但
 * Urchin 的 typedInvoke 是「契约闭集」（未知通道直接拒绝）——AI 设置界面
 * 需要一组白名单透传。这里用显式 allowlist 收敛暴露面：
 * - 仅 AI 设置/测试/目录通道，不含任何文件或通用能力
 * - 仅受信来源（主窗口）可拿到 window.urchinGenoffice
 */
const GENOFFICE_AI_CHANNELS: ReadonlySet<string> = new Set([
  'genoffice:ai-catalogs',
  'ai:get-settings',
  'ai:set-settings',
  'ai:chat',
  'ai:search-test',
  'ai:media-test',
  'ai:codex-models',
  'ai:gsk-status',
]);

const genofficeApi = {
  invoke(channel: string, payload: unknown): Promise<unknown> {
    if (!GENOFFICE_AI_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`GenOffice 通道未授权: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
};

/**
 * GenOffice shell Home 适配层（阶段 4.6，用户指令：入口直接使用上游 Home 前端）。
 *
 * 上游 Home 期望 `window.aiOffice`（apps/shell/src/preload）；宿主不加载其
 * preload，而是由本层把 Home 使用到的方法映射为宿主通道：
 * - 业务方法 → 单一 `genoffice:home` invoke（`{ method, args }`，主进程白名单分发）
 * - AI 设置 → 既有 `ai:*` 通道（与编辑器 AI 面板同源）
 * - 事件 → `genoffice:home:event`（folderChanged）与 `app:theme-changed`
 *
 * 仅对 `genoffice-app://shell/` 页面暴露；账号/云项目/MCP/更新/集成等上游壳
 * 能力以中性桩返回（主进程侧实现），保证 Home 完整渲染。
 */
function createGenOfficeHomeBridge(): Record<string, unknown> {
  const home = (method: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('genoffice:home', { method, args });
  const subscribe = (type: string, handler: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      const evt = (payload ?? {}) as { type?: unknown };
      if (evt.type === type) handler(payload);
    };
    ipcRenderer.on('genoffice:home:event', listener);
    return () => ipcRenderer.removeListener('genoffice:home:event', listener);
  };
  return {
    // ── 最近 / 星标 / 打开 ──
    recents: (query?: unknown) => home('recents', query),
    starred: (query?: unknown) => home('starred', query),
    statPaths: (paths: unknown) => home('statPaths', paths),
    toggleStar: (path: unknown) => home('toggleStar', path),
    removeRecent: (paths: unknown) => home('removeRecent', paths),
    openPath: (path: unknown) => home('openPath', path),
    browse: () => home('browse'),
    revealPath: (path: unknown) => home('revealPath', path),
    // ── 新建 ──
    newDoc: (opts?: unknown) => home('newDoc', opts),
    newSheet: (opts?: unknown) => home('newSheet', opts),
    newSlide: (opts?: unknown) => home('newSlide', opts),
    newMarkdown: (opts?: unknown) => home('newMarkdown', opts),
    newHtml: (opts?: unknown) => home('newHtml', opts),
    newPdf: (opts?: unknown) => home('newPdf', opts),
    // ── 文件 / 文件夹管理 ──
    renameFile: (path: unknown, newName: unknown) => home('renameFile', path, newName),
    duplicateFile: (path: unknown) => home('duplicateFile', path),
    deleteFiles: (paths: unknown) => home('deleteFiles', paths),
    folderRoot: () => home('folderRoot'),
    listFolder: (dir: unknown) => home('listFolder', dir),
    createFolder: (parent: unknown, name: unknown) => home('createFolder', parent, name),
    renameFolder: (dir: unknown, newName: unknown) => home('renameFolder', dir, newName),
    movePaths: (paths: unknown, targetDir: unknown, onConflict: unknown) =>
      home('movePaths', paths, targetDir, onConflict),
    deleteFolder: (dir: unknown) => home('deleteFolder', dir),
    openTrash: () => home('openTrash'),
    onFolderChanged: (handler: (dirs: string[]) => void) =>
      subscribe('folderChanged', (payload) => {
        const dirs = (payload as { dirs?: unknown }).dirs;
        if (Array.isArray(dirs)) handler(dirs.filter((d): d is string => typeof d === 'string'));
      }),
    // ── 设置 / 主题 / 语言 ──
    getLanguage: () => home('getLanguage'),
    setLanguage: (lang: unknown) => home('setLanguage', lang),
    getTheme: () => home('getTheme'),
    setTheme: (theme: unknown) => home('setTheme', theme),
    onThemeChanged: (handler: (theme: string) => void) => {
      const listener = (_event: unknown, theme: unknown): void => {
        if (theme === 'light' || theme === 'dark' || theme === 'system') handler(theme);
      };
      ipcRenderer.on('app:theme-changed', listener);
      return () => ipcRenderer.removeListener('app:theme-changed', listener);
    },
    getAutoSaveDefault: () => home('getAutoSaveDefault'),
    setAutoSaveDefault: (on: unknown) => home('setAutoSaveDefault', on),
    getAiPanelPrefs: () => home('getAiPanelPrefs'),
    setAiPanelPrefs: (patch: unknown) => home('setAiPanelPrefs', patch),
    getDefaultSaveDir: () => home('getDefaultSaveDir'),
    pickDefaultSaveDir: () => home('pickDefaultSaveDir'),
    getAppVersion: () => home('getAppVersion'),
    onboardingSeen: () => home('onboardingSeen'),
    setOnboardingSeen: () => home('setOnboardingSeen'),
    getUpdateChannel: () => home('getUpdateChannel'),
    setUpdateChannel: (channel: unknown) => home('setUpdateChannel', channel),
    // ── MCP / 更新 / 统计（宿主中性桩） ──
    getMcpStatus: () => home('getMcpStatus'),
    setMcpSettings: (patch: unknown) => home('setMcpSettings', patch),
    getMcpLogs: () => home('getMcpLogs'),
    clearMcpLogs: () => home('clearMcpLogs'),
    openMcpLogFile: () => home('openMcpLogFile'),
    getAnalyticsEnabled: () => home('getAnalyticsEnabled'),
    setAnalyticsEnabled: (enabled: unknown) => home('setAnalyticsEnabled', enabled),
    githubStars: () => home('githubStars'),
    starPromptShouldShow: () => home('starPromptShouldShow'),
    starPromptAction: (action: unknown) => home('starPromptAction', action),
    openGitHubRepo: () => home('openGitHubRepo'),
    // ── GenOffice 原生 AI（与编辑器 AI 面板同源通道） ──
    getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
    setAiSettings: (settings: unknown) => ipcRenderer.invoke('ai:set-settings', settings),
    getAiProviders: () =>
      ipcRenderer
        .invoke('genoffice:ai-catalogs')
        .then((c: unknown) => (c as { providers?: unknown }).providers ?? []),
    getAiMediaProviders: () =>
      ipcRenderer
        .invoke('genoffice:ai-catalogs')
        .then((c: unknown) => (c as { mediaProviders?: unknown }).mediaProviders ?? []),
    getAiSearchProviders: () =>
      ipcRenderer
        .invoke('genoffice:ai-catalogs')
        .then((c: unknown) => (c as { searchProviders?: unknown }).searchProviders ?? []),
    getCodexModels: (cliPath: unknown) => ipcRenderer.invoke('ai:codex-models', cliPath),
    testAiSettings: (settings: unknown) =>
      ipcRenderer
        .invoke('ai:chat', {
          settings,
          system: 'You are a connectivity test. Reply with the single word OK.',
          user: 'ping',
        })
        .then((r: unknown) => {
          const res = (r ?? {}) as { ok?: unknown; error?: unknown };
          return res.ok === true
            ? { ok: true }
            : { ok: false, error: typeof res.error === 'string' ? res.error : '' };
        }),
    testAiSearchSettings: (input: unknown) => ipcRenderer.invoke('ai:search-test', input),
    testAiMediaSettings: (input: unknown) => ipcRenderer.invoke('ai:media-test', input),
    // ── 集成（安装 skill 等，宿主暂不支持：中性桩） ──
    integrations: {
      status: () => home('integrations.status'),
      installSkill: (target: unknown) => home('integrations.installSkill', target),
      uninstallSkill: (agentId: unknown) => home('integrations.uninstallSkill', agentId),
      pickSkillDir: (title: unknown) => home('integrations.pickSkillDir', title),
      saveSkillZip: (title: unknown) => home('integrations.saveSkillZip', title),
      copyText: (text: unknown) => home('integrations.copyText', text),
    },
  };
}

if (isTrustedOrigin) {
  contextBridge.exposeInMainWorld('urchin', api);
  contextBridge.exposeInMainWorld('urchinGenoffice', genofficeApi);
}

// GenOffice shell Home 页面（genoffice-app://shell/）额外暴露 window.aiOffice
if (protocol === 'genoffice-app:' && hostname === 'shell') {
  contextBridge.exposeInMainWorld('aiOffice', createGenOfficeHomeBridge());
  // 上游 shell 的窗口内标签条（AppFrame/TabBar）在 Urchin 中由浏览器标签体系
  // 取代：提供最小 TabsApi 桩（Home 视图内不再有独立标签），标签条由宿主 CSS 隐藏。
  contextBridge.exposeInMainWorld('aiOfficeTabs', {
    list: () => Promise.resolve([]),
    activate: () => Promise.resolve(),
    close: () => Promise.resolve(),
    showMenu: () => Promise.resolve(),
    showNewMenu: () => Promise.resolve(),
    showAppMenu: () => Promise.resolve(),
    reorder: () => Promise.resolve(),
    onChanged: () => () => undefined,
    notifyChromePressed: () => undefined,
    onChromePressed: () => () => undefined,
  });
}

// 类型导出（供渲染层 import type 使用）
export type UrchinApi = typeof api;
export type UrchinGenOfficeApi = typeof genofficeApi;
