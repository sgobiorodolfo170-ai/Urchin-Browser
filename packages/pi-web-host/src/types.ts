/**
 * pi 阶段 2 自研托管服务 · 共享类型与协议面
 *
 * 依据：docs/pi-web-评估.md 阶段 2（自研 apps/pi-web 前端 + packages/pi-web-host 托管服务）。
 * M2A 骨架承载协议 v0 子集（hello/ping）；M2B 扩展 prompt/abort/stream.* ——会话/模型目录/
 * 工具能力（list_models/list_sessions/new_session/switch_session/fork_session/get_state）
 * 随 M2B-3/4 推进，不要在本枚举外扩散消息类型。
 *
 * 该包在 utilityProcess（Electron 内置 Node）内运行；M2B 起 import vendored pi 的
 * @earendil-works/pi-agent-core + pi-ai（浏览器安全子集，经 esbuild 别名打包）。
 */

/** 托管服务状态机（与 desktop 侧 PiWebHostLauncher 的 PiWebHostState 一致） */
export type PiWebHostState = 'stopped' | 'starting' | 'running' | 'error';

/**
 * WebSocket 协议 v0 · 客户端 → 服务端
 *
 * 所有消息为 JSON over WS（docs/pi-web-评估.md 决策：官方无 CBOR 面，闭合成 JSON）。
 */
export type HostClientMessage =
  | { readonly type: 'hello'; readonly client?: string }
  | { readonly type: 'ping' }
  | { readonly type: 'prompt'; readonly text: string; readonly sessionId?: string }
  | { readonly type: 'abort' }
  | { readonly type: 'list_models' }
  | { readonly type: 'get_state' }
  /** M2B-3b：创建新会话 */
  | { readonly type: 'new_session' }
  /** M2B-3b：列出历史会话 */
  | { readonly type: 'list_sessions' }
  /** M2B-3b：切换到指定会话 */
  | { readonly type: 'switch_session'; readonly sessionId: string };

/** token 用量（promptTokens/completionTokens） */
export interface HostUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** WebSocket 协议 v0 · 服务端 → 客户端 */
export type HostServerMessage =
  | {
      readonly type: 'hello_ok';
      readonly service: 'pi-web-host';
      readonly version: string;
      readonly status: 'ok';
      readonly provider?: string;
      readonly model?: string;
    }
  | { readonly type: 'pong'; readonly ts: number }
  | { readonly type: 'stream.chunk'; readonly content: string }
  | {
      readonly type: 'stream.end';
      readonly finishReason: string;
      readonly usage?: HostUsage;
    }
  | { readonly type: 'models'; readonly providers: readonly string[] }
  | { readonly type: 'state'; readonly streaming: boolean; readonly messageCount: number }
  | {
      readonly type: 'session_list';
      readonly sessions: readonly {
        readonly id: string;
        readonly firstMessage: string;
        readonly messageCount: number;
      }[];
    }
  | { readonly type: 'session_created'; readonly sessionId: string }
  | {
      readonly type: 'session_switched';
      readonly sessionId: string;
      readonly messages: readonly {
        readonly role: 'user' | 'assistant';
        readonly content: string;
      }[];
    }
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
