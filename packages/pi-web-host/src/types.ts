/**
 * pi 阶段 2 自研托管服务 · 共享类型与协议面
 *
 * 依据：docs/pi-web-评估.md 阶段 2（自研 apps/pi-web 前端 + packages/pi-web-host 托管服务）。
 * M2A 骨架只承载协议 v0 子集（hello/hello_ok/ping/pong/error）；完整的会话/对话命令集
 * （prompt/abort/list_models/list_sessions/new_session/switch_session/fork_session/get_state）
 * 在 M2B 接入 AgentSession 时扩展——不要在本枚举外扩散消息类型。
 *
 * 该包只在 utilityProcess（Electron 内置 Node）内运行，与 vendor/pi 的 Node-only
 * @earendil-works/pi-coding-agent 对接面留给 M2B；本层不 import 任何 pi 代码。
 */

/** 托管服务状态机（与 desktop 侧 PiWebHostLauncher 的 PiWebHostState 一致） */
export type PiWebHostState = 'stopped' | 'starting' | 'running' | 'error';

/**
 * WebSocket 协议 v0 · 客户端 → 服务端
 *
 * 所有消息为 JSON over WS（docs/pi-web-评估.md 决策：官方无 CBOR 面，闭合成 JSON）。
 */
export type HostClientMessage =
  /** 握手：服务端回 hello_ok（携带 service/version） */
  | { readonly type: 'hello'; readonly client?: string }
  /** 心跳：服务端回 pong */
  | { readonly type: 'ping' };

/** WebSocket 协议 v0 · 服务端 → 客户端 */
export type HostServerMessage =
  | {
      readonly type: 'hello_ok';
      readonly service: 'pi-web-host';
      readonly version: string;
      readonly status: 'ok';
    }
  | { readonly type: 'pong'; readonly ts: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

/** 静态文件 Content-Type 映射（M2A 最小集，覆盖自研前端产物） */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};
