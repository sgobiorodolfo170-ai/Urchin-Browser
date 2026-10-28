/**
 * pi 阶段 2 托管服务 · 组合服务（HTTP 静态 + WebSocket + token 鉴权）
 *
 * M2A 骨架：单 createServer 承载
 * - HTTP：GET 经鉴权后由 StaticHandler 提供 apps/pi-web 产物
 * - WebSocket：upgrade 前校验 token（401 拒绝），连接后走 ws-handler 协议 v0
 *
 * 生命周期：startPiWebHostServer() 幂等返回 handle（port/url/token/close）。
 * 本模块零 Electron 依赖，可在 vitest 内直接跑真端口（127.0.0.1）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildHostUrl,
  generateToken,
  isAuthorizedRequest,
  HOST_TOKEN_COOKIE,
  buildTokenCookie,
} from './auth';
import { StaticHandler } from './http-static';
import { handleClientMessage, sendError, sendJson } from './ws-handler';
import {
  createAgentBridge,
  type AgentBridgeHandle,
  type AgentBridgeOptions,
  getProviderList,
} from './agent-bridge';
import { PiWebHostState } from './types';

export const SERVICE_VERSION = '0.2.0';

export interface PiWebHostServerOptions {
  /** 静态文件根目录（apps/pi-web 构建产物） */
  readonly wwwDir: string;
  /** 监听端口；0（默认）= 由系统分配空闲端口 */
  readonly port?: number;
  /** 绑定地址（仅回环） */
  readonly host?: string;
  /** 预置 token（缺省自动生成） */
  readonly token?: string;
  /** M2B：Agent 凭据/模型（缺省时 prompt 回 no_api_key 错误） */
  readonly agent?: AgentBridgeOptions;
}

export interface PiWebHostServerHandle {
  readonly port: number;
  /** 带 token 的入口 URL（渲染层直接 tab.open） */
  readonly url: string;
  readonly token: string;
  readonly state: PiWebHostState;
  close(): Promise<void>;
}

/** 从请求地址判定是否携带有效 token（query 或 Cookie） */
function requestAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const urlPath = req.url ?? '';
  const question = urlPath.indexOf('?');
  const search = question >= 0 ? urlPath.slice(question) : undefined;
  return isAuthorizedRequest(expectedToken, search, req.headers.cookie);
}

export async function startPiWebHostServer(
  options: PiWebHostServerOptions,
): Promise<PiWebHostServerHandle> {
  const token = options.token ?? generateToken();
  const host = options.host ?? '127.0.0.1';
  const staticHandler = new StaticHandler(options.wwwDir);

  const server: Server = createServer((req, res) => {
    // 未授权 → 401，不进入静态服务
    if (!requestAuthorized(req, token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('unauthorized');
      return;
    }
    // 首次有效请求回写 Cookie（后续请求可只带 Cookie，避免 token 长期留在地址栏外显）
    if (req.headers.cookie?.includes(HOST_TOKEN_COOKIE) !== true) {
      res.setHeader('Set-Cookie', buildTokenCookie(token));
    }
    void staticHandler.serve(req, res);
  });

  // WebSocket：upgrade 前校验 token（401 拒绝）
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket: Duplex, head) => {
    if (!requestAuthorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    let bridge: AgentBridgeHandle | null = null;
    const agentOpts = options.agent;
    let messageCount = 0;
    const ctx = {
      version: SERVICE_VERSION,
      provider: agentOpts?.providerId,
      model: agentOpts?.modelId,
    };

    const ensureBridge = (): AgentBridgeHandle | null => {
      if (bridge) return bridge;
      if (!agentOpts?.apiKey) {
        sendError(ws, 'no_api_key', '未配置 API Key（请在 Urchin 设置中配置 AI Provider）');
        return null;
      }
      bridge = createAgentBridge(
        agentOpts,
        (msg) => sendJson(ws, msg),
        (code, message) => sendError(ws, code, message),
      );
      return bridge;
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sendError(ws, 'bad_message', 'text/JSON only');
        return;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : ArrayBuffer.isView(data) || data instanceof ArrayBuffer
          ? Buffer.from(data as ArrayBuffer).toString('utf8')
          : String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendError(ws, 'bad_message', 'invalid JSON');
        return;
      }
      const msg = parsed as { type?: string };
      switch (msg?.type) {
        case 'prompt': {
          const h = ensureBridge();
          if (!h) return;
          const promptText = (parsed as { text?: string }).text ?? '';
          if (!promptText) {
            sendError(ws, 'bad_message', 'prompt.text required');
            return;
          }
          messageCount++;
          void h
            .prompt(promptText)
            .catch((e: unknown) =>
              sendError(ws, 'prompt_failed', e instanceof Error ? e.message : String(e)),
            );
          return;
        }
        case 'abort': {
          bridge?.abort();
          return;
        }
        case 'list_models': {
          sendJson(ws, { type: 'models', providers: [...getProviderList()] });
          return;
        }
        case 'get_state': {
          sendJson(ws, {
            type: 'state',
            streaming: bridge !== null && messageCount > 0,
            messageCount,
          });
          return;
        }
        default:
          handleClientMessage(ws, text, ctx);
      }
    });

    ws.on('close', () => {
      bridge?.dispose();
      bridge = null;
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('pi-web-host: failed to determine listening port');
  }
  const port = address.port;
  const url = buildHostUrl(port, token);

  const handle: PiWebHostServerHandle = {
    port,
    url,
    token,
    state: 'running',
    close(): Promise<void> {
      return new Promise((resolveClose) => {
        wss.close(() => {
          server.close(() => resolveClose());
        });
        // 兜底：异常打开的连接不应阻塞 close
        for (const client of wss.clients) {
          client.terminate();
        }
      });
    },
  };
  return handle;
}

export { HOST_TOKEN_COOKIE };
