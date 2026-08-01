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
 * 设计理由（agents.md §七.2 + 项目特化审查点）：
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

if (isTrustedOrigin) {
  contextBridge.exposeInMainWorld('urchin', api);
}

// 类型导出（供渲染层 import type 使用）
export type UrchinApi = typeof api;
