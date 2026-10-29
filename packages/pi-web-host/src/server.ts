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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join as pathJoin, basename as pathBasename } from 'node:path';
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
import {
  persistExchange,
  listSessions,
  loadSessionMessages,
  generateSessionId,
} from './session-store';
import { handleFileOps } from './file-ops';
import { getGitStatus } from './git-ops';
import { PiWebHostState, type HostServerMessage } from './types';

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
  /** M2B-3b：agent 数据目录（会话 JSONL 持久化根） */
  readonly agentDir?: string;
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

/** 处理主题文件请求 /themes/<name>.css 或 /api/themes（列表） */
function handleThemeRequest(urlPath: string, wwwDir: string, res: ServerResponse): void {
  const themesDir = pathJoin(wwwDir, 'themes');
  if (urlPath === '/api/themes') {
    try {
      const files = readdirSync(themesDir).filter((f) => f.endsWith('.css'));
      const themes = files.map((f) => {
        const id = f.replace(/\.css$/, '');
        return {
          id,
          name: id,
          builtin: true,
          scheme:
            id.includes('light') || id.includes('latte') || id.includes('white') ? 'light' : 'dark',
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(themes));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    }
    return;
  }
  const themeName = pathBasename(urlPath).replace(/\.css$/, '');
  const filePath = pathJoin(themesDir, `${themeName}.css`);
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf8');
    res
      .writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      .end(content);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('theme not found');
  }
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

    // 主题文件：/themes/*.css → wwwDir/themes/*.css
    const urlPath = req.url?.split('?')[0] ?? '';
    if (urlPath.startsWith('/themes/') || urlPath === '/api/themes') {
      handleThemeRequest(urlPath, options.wwwDir, res);
      return;
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
    const agentDir = options.agentDir;
    let messageCount = 0;
    let currentSessionId = generateSessionId();
    let lastUserText = '';
    let assistantAccumulator = '';
    let currentCwd: string | undefined;
    const ctx = {
      version: SERVICE_VERSION,
      provider: agentOpts?.providerId,
      model: agentOpts?.modelId,
    };

    /** 创建/重建 Agent 桥（带当前 sessionId） */
    const ensureBridge = (): AgentBridgeHandle | null => {
      if (bridge) return bridge;
      if (!agentOpts?.apiKey) {
        sendError(ws, 'no_api_key', '未配置 API Key（请在 Urchin 设置中配置 AI Provider）');
        return null;
      }
      bridge = createAgentBridge(
        { ...agentOpts, sessionId: currentSessionId },
        (msg) => {
          // 拦截 stream.chunk 累积 assistant 文本（用于 stream.end 时持久化）
          if (msg.type === 'stream.chunk' && typeof msg.content === 'string') {
            assistantAccumulator += msg.content;
          }
          sendJson(ws, msg);
        },
        (code, message) => sendError(ws, code, message),
      );
      return bridge;
    };

    /** 销毁当前桥（切换/新建会话时调用） */
    const disposeBridge = (): void => {
      bridge?.dispose();
      bridge = null;
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
          lastUserText = promptText;
          assistantAccumulator = '';
          // stream.end 时持久化（在 onMessage 回调中检测）
          const origDispose = h.dispose.bind(h);
          h.dispose = () => origDispose();
          void h
            .prompt(promptText)
            .then(() => {
              // prompt 完成（agent.prompt resolved = agent_end 已触发）；
              // 持久化本轮对话
              if (agentDir && lastUserText && assistantAccumulator) {
                void persistExchange(
                  agentDir,
                  currentSessionId,
                  lastUserText,
                  assistantAccumulator,
                ).catch(() => {
                  /* 持久化失败不阻塞对话 */
                });
              }
            })
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
        case 'new_session': {
          disposeBridge();
          currentSessionId = generateSessionId();
          messageCount = 0;
          lastUserText = '';
          assistantAccumulator = '';
          sendJson(ws, { type: 'session_created', sessionId: currentSessionId });
          return;
        }
        case 'list_sessions': {
          if (!agentDir) {
            sendJson(ws, { type: 'session_list', sessions: [] });
            return;
          }
          void listSessions(agentDir)
            .then((sessions) =>
              sendJson(ws, {
                type: 'session_list',
                sessions: sessions.map((s) => ({
                  id: s.id,
                  firstMessage: s.firstMessage,
                  messageCount: s.messageCount,
                })),
              }),
            )
            .catch(() => sendJson(ws, { type: 'session_list', sessions: [] }));
          return;
        }
        case 'switch_session': {
          const targetId = (parsed as { sessionId?: string }).sessionId ?? '';
          if (!targetId) {
            sendError(ws, 'bad_message', 'switch_session.sessionId required');
            return;
          }
          disposeBridge();
          currentSessionId = targetId;
          messageCount = 0;
          lastUserText = '';
          assistantAccumulator = '';
          const sendSwitched = (
            messages: readonly { role: 'user' | 'assistant'; content: string }[],
          ) => {
            messageCount = messages.length;
            sendJson(ws, { type: 'session_switched', sessionId: targetId, messages });
          };
          if (!agentDir) {
            sendSwitched([]);
            return;
          }
          void loadSessionMessages(agentDir, targetId)
            .then((msgs) => sendSwitched(msgs))
            .catch(() => sendSwitched([]));
          return;
        }
        case 'get_compacted_messages': {
          const compactionMessageId =
            (parsed as { compactionMessageId?: string }).compactionMessageId ?? '';
          sendJson(ws, {
            type: 'compacted_messages_result',
            compactionMessageId,
            conversationId: currentSessionId,
            messages: [],
            error: 'no compacted history',
          } as unknown as HostServerMessage);
          return;
        }
        case 'tool_approval_response': {
          const id = (parsed as { id?: string }).id ?? '';
          const rawDecision = (parsed as { decision?: string }).decision ?? 'approve';
          const decision =
            rawDecision === 'deny' ? 'deny' : rawDecision === 'edit' ? 'edit' : 'approve';
          bridge?.resolveApproval(id, decision);
          sendJson(ws, { type: 'tool_approval_resolved', id });
          return;
        }
        case 'set_cwd': {
          currentCwd = (parsed as { path?: string }).path;
          return;
        }
        case 'scm_status': {
          const reqId = (parsed as { reqId?: number }).reqId ?? 0;
          const cwd = currentCwd ?? agentDir ?? process.cwd();
          void getGitStatus(cwd).then((result) => {
            sendJson(ws, {
              type: 'scm_data',
              reqId,
              kind: 'status',
              ok: result.ok,
              error: result.error,
              notRepo: result.notRepo,
              branch: result.branch,
              files: result.files,
              branches: result.branches,
            } as unknown as HostServerMessage);
          });
          return;
        }
        default:
          // 文件操作 / 设置：交给 file-ops 处理；未命中则走无状态 handler
          if (agentDir) {
            void handleFileOps(parsed as Record<string, unknown>, agentDir)
              .then((result) => {
                if (result) sendJson(ws, result as unknown as Parameters<typeof sendJson>[1]);
                else handleClientMessage(ws, text, ctx);
              })
              .catch(() => handleClientMessage(ws, text, ctx));
          } else {
            handleClientMessage(ws, text, ctx);
          }
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
