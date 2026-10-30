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
import { readFile } from 'node:fs/promises';
import {
  join as pathJoin,
  basename as pathBasename,
  extname,
  resolve as pathResolve,
} from 'node:path';
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
  createLlmProvider,
} from './agent-bridge';
import {
  persistExchange,
  listSessions,
  loadSessionMessages,
  generateSessionId,
  deleteSession,
  forkSession,
} from './session-store';
import { handleFileOps } from './file-ops';
import { getGitStatus, getGitHistory, getGitFileDiff, getGitCommitDetail } from './git-ops';
import {
  createTerminal,
  terminalInput,
  terminalResize,
  terminalKill,
  listTerminals,
  disposeAllTerminals,
} from './terminal';
import {
  probe as sshProbe,
  listDir as sshListDir,
  installTools as sshInstallTools,
  listProfiles as sshListProfiles,
  deleteProfile as sshDeleteProfile,
  saveProfile as sshSaveProfile,
  disposeAllSsh,
} from './ssh-client';
import {
  scanPlugins,
  readCatalog,
  addCatalogEntry,
  removeCatalogEntry,
  installPlugin,
  uninstallPlugin,
  activatePlugin,
  deactivatePlugin,
  deactivateAllPlugins,
  getActivePluginTools,
} from './plugin-manager';
import { listGrants, listPermissions, grantDirAccess, grantNetHost } from './plugin-permissions';
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
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ themes }));
    } catch {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ themes: [] }));
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

const PLUGIN_MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** 插件静态文件：/plugins/<id>/client/<path> → agentDir/plugins/<id>/client/<path> */
async function handlePluginStatic(
  urlPath: string,
  agentDir: string,
  res: ServerResponse,
): Promise<void> {
  const parts = urlPath.split('/');
  if (parts.length < 5) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  const pluginId = parts[2] ?? '';
  const filePath = parts.slice(4).join('/');

  if (!/^[A-Za-z0-9_-]+$/.test(pluginId) || filePath.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
    return;
  }

  const baseDir = pathResolve(pathJoin(agentDir, 'plugins', pluginId, 'client'));
  const fullPath = pathResolve(pathJoin(baseDir, filePath));
  if (!fullPath.startsWith(baseDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
    return;
  }

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const contentType = PLUGIN_MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType }).end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
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

    // 插件静态文件：/plugins/<id>/client/<path> → agentDir/plugins/<id>/client/<path>
    if (urlPath.startsWith('/plugins/') && urlPath.includes('/client/')) {
      const agentDir = options.agentDir;
      if (agentDir) {
        void handlePluginStatic(urlPath, agentDir, res);
        return;
      }
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
    // Phase 4：运行时可变的 model/provider（set_model 更新，ensureBridge 使用）
    let currentProviderId = agentOpts?.providerId;
    let currentModelId = agentOpts?.modelId;
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
        {
          ...agentOpts,
          providerId: currentProviderId ?? agentOpts.providerId,
          modelId: currentModelId ?? agentOpts.modelId,
          sessionId: currentSessionId,
          extraTools: getActivePluginTools(),
        },
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
        case 'set_model': {
          const provider =
            typeof (parsed as { provider?: string }).provider === 'string'
              ? (parsed as { provider?: string }).provider
              : '';
          const model =
            typeof (parsed as { model?: string }).model === 'string'
              ? (parsed as { model?: string }).model
              : '';
          if (provider && model) {
            // 更新当前 model/provider，销毁旧 bridge（下次 prompt 时 ensureBridge 用新值重建）
            currentProviderId = provider;
            currentModelId = model;
            disposeBridge();
            // Phase 4：写回主进程 pi.* 键（MessagePort）
            try {
              const parentPort =
                typeof process !== 'undefined' && 'parentPort' in process && process.parentPort;
              if (
                parentPort &&
                typeof (parentPort as { postMessage: unknown }).postMessage === 'function'
              ) {
                (parentPort as { postMessage: (msg: unknown) => void }).postMessage({
                  type: 'piSettingsChanged',
                  providerId: provider,
                  modelId: model,
                });
              }
            } catch {
              /* parentPort 不可用时静默跳过 */
            }
          }
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
              detached: result.detached,
              upstream: result.upstream,
              ahead: result.ahead,
              behind: result.behind,
              files: result.files,
              branches: result.branches,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'fork_session': {
          const originalId =
            (parsed as { conversationId?: string }).conversationId ?? currentSessionId;
          if (!agentDir) {
            sendError(ws, 'no_agent_dir', 'agentDir not configured');
            return;
          }
          void forkSession(agentDir, originalId).then((newId) => {
            sendJson(ws, {
              type: 'session_created',
              sessionId: newId,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'delete_session': {
          const targetId = (parsed as { path?: string }).path ?? '';
          if (!agentDir || !targetId) {
            return;
          }
          void deleteSession(agentDir, targetId).then(() => {
            sendJson(ws, { type: 'session_list', sessions: [] } as unknown as HostServerMessage);
          });
          return;
        }
        case 'scm_history': {
          const reqId = (parsed as { reqId?: number }).reqId ?? 0;
          const cwd = currentCwd ?? agentDir ?? process.cwd();
          void getGitHistory(cwd).then((result) => {
            sendJson(ws, {
              type: 'scm_data',
              reqId,
              kind: 'history',
              ok: result.ok,
              error: result.error,
              history: result.history,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'scm_filediff': {
          const reqId = (parsed as { reqId?: number }).reqId ?? 0;
          const filePath = (parsed as { path?: string }).path ?? '';
          const cwd = currentCwd ?? agentDir ?? process.cwd();
          void getGitFileDiff(cwd, filePath).then((result) => {
            sendJson(ws, {
              type: 'scm_data',
              reqId,
              kind: 'filediff',
              ok: result.ok,
              error: result.error,
              stagedText: result.stagedText,
              worktreeText: result.worktreeText,
              untracked: result.untracked,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'scm_commit': {
          const reqId = (parsed as { reqId?: number }).reqId ?? 0;
          const hash = (parsed as { hash?: string }).hash ?? '';
          const cwd = currentCwd ?? agentDir ?? process.cwd();
          void getGitCommitDetail(cwd, hash).then((result) => {
            sendJson(ws, {
              type: 'scm_data',
              reqId,
              kind: 'commit',
              ok: result.ok,
              error: result.error,
              stagedText: result.stagedText,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'scm_commitmsg': {
          const reqId = (parsed as { reqId?: number }).reqId ?? 0;
          // AI 生成提交信息需要 LLM 调用，简化为返回空文本
          sendJson(ws, {
            type: 'scm_data',
            reqId,
            kind: 'commitmsg',
            ok: true,
            text: '',
          } as unknown as HostServerMessage);
          return;
        }
        case 'terminal_create': {
          const terminalId = (parsed as { terminalId?: string }).terminalId ?? '';
          const cwd = (parsed as { cwd?: string }).cwd ?? '';
          const cols = (parsed as { cols?: number }).cols ?? 80;
          const rows = (parsed as { rows?: number }).rows ?? 24;
          const title = (parsed as { title?: string }).title;
          if (!terminalId) return;
          createTerminal(
            terminalId,
            cwd,
            cols,
            rows,
            title,
            (id, data) =>
              sendJson(ws, {
                type: 'terminal_output',
                terminalId: id,
                data,
              } as unknown as HostServerMessage),
            (id, exitCode) => {
              sendJson(ws, {
                type: 'terminal_exit',
                terminalId: id,
                exitCode,
              } as unknown as HostServerMessage);
              sendJson(ws, {
                type: 'terminal_list',
                terminals: listTerminals(),
              } as unknown as HostServerMessage);
            },
          );
          sendJson(ws, {
            type: 'terminal_list',
            terminals: listTerminals(),
          } as unknown as HostServerMessage);
          return;
        }
        case 'terminal_input': {
          const terminalId = (parsed as { terminalId?: string }).terminalId ?? '';
          const data = (parsed as { data?: string }).data ?? '';
          if (terminalId) terminalInput(terminalId, data);
          return;
        }
        case 'terminal_resize': {
          const terminalId = (parsed as { terminalId?: string }).terminalId ?? '';
          const cols = (parsed as { cols?: number }).cols ?? 80;
          const rows = (parsed as { rows?: number }).rows ?? 24;
          if (terminalId) terminalResize(terminalId, cols, rows);
          return;
        }
        case 'terminal_kill': {
          const terminalId = (parsed as { terminalId?: string }).terminalId ?? '';
          if (terminalId) terminalKill(terminalId);
          sendJson(ws, {
            type: 'terminal_list',
            terminals: listTerminals(),
          } as unknown as HostServerMessage);
          return;
        }
        case 'remote_ssh_probe': {
          const params = (parsed as { params?: Record<string, unknown> }).params;
          if (!params) return;
          const host = typeof params.host === 'string' ? params.host : '';
          const port = typeof params.port === 'number' ? params.port : 22;
          const username = typeof params.username === 'string' ? params.username : '';
          const auth = params.auth as
            | { type: 'password'; password?: string }
            | { type: 'key'; privateKey?: string; passphrase?: string }
            | { type: 'agent' };
          void sshProbe(host, port, username, auth).then((result) => {
            sendJson(ws, {
              type: 'remote_ssh_probe_result',
              ok: result.ok,
              connectionId: result.connectionId,
              error: result.error,
              system: result.system,
              tools: result.tools,
            } as unknown as HostServerMessage);
            if (result.ok && result.connectionId && params.saveProfile && agentDir) {
              const profileName =
                typeof params.profileName === 'string' ? params.profileName : `${username}@${host}`;
              void sshSaveProfile(agentDir, {
                name: profileName,
                host,
                port,
                username,
                authType:
                  auth.type === 'password' ? 'password' : auth.type === 'key' ? 'key' : 'agent',
              });
            }
          });
          return;
        }
        case 'remote_ssh_list_dir': {
          const connectionId = (parsed as { connectionId?: string }).connectionId ?? '';
          const dirPath = (parsed as { path?: string }).path ?? '.';
          void sshListDir(connectionId, dirPath).then((result) => {
            sendJson(ws, {
              type: 'remote_ssh_list_dir_result',
              ok: result.ok,
              error: result.error,
              items: result.items,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'remote_ssh_install_tools': {
          const connectionId = (parsed as { connectionId?: string }).connectionId ?? '';
          const tools = (parsed as { tools?: string[] }).tools ?? [];
          void sshInstallTools(connectionId, tools).then((result) => {
            sendJson(ws, {
              type: 'remote_ssh_install_result',
              ok: result.ok,
              error: result.error,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'remote_ssh_list_profiles': {
          if (!agentDir) {
            sendJson(ws, {
              type: 'remote_ssh_profiles_result',
              profiles: [],
            } as unknown as HostServerMessage);
            return;
          }
          void sshListProfiles(agentDir).then((profiles) => {
            sendJson(ws, {
              type: 'remote_ssh_profiles_result',
              profiles,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'remote_ssh_delete_profile': {
          const name = (parsed as { name?: string }).name ?? '';
          if (agentDir && name) void sshDeleteProfile(agentDir, name);
          return;
        }
        case 'plugins_reload': {
          if (!agentDir) return;
          disposeBridge();
          void scanPlugins(agentDir).then((plugins) => {
            sendJson(ws, {
              type: 'plugins',
              plugins,
              epoch: Date.now(),
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'plugin_install': {
          const source = (parsed as { source?: string }).source ?? '';
          const pluginId = (parsed as { id?: string }).id ?? '';
          if (!agentDir || !source || !pluginId) return;
          void installPlugin(agentDir, source, pluginId).then((result) => {
            sendJson(ws, {
              type: 'plugin_job',
              jobId: `install-${pluginId}-${Date.now()}`,
              action: 'install',
              pluginId,
              phase: 'done',
              ok: result.ok,
              error: result.error,
            } as unknown as HostServerMessage);
            if (result.ok) {
              void scanPlugins(agentDir).then((plugins) => {
                sendJson(ws, {
                  type: 'plugins',
                  plugins,
                  epoch: Date.now(),
                } as unknown as HostServerMessage);
              });
            }
          });
          return;
        }
        case 'plugin_uninstall': {
          const pluginId = (parsed as { id?: string }).id ?? '';
          if (!agentDir || !pluginId) return;
          void uninstallPlugin(agentDir, pluginId).then(() => {
            sendJson(ws, {
              type: 'plugin_job',
              jobId: `uninstall-${pluginId}-${Date.now()}`,
              action: 'uninstall',
              pluginId,
              phase: 'done',
              ok: true,
            } as unknown as HostServerMessage);
            void scanPlugins(agentDir).then((plugins) => {
              sendJson(ws, {
                type: 'plugins',
                plugins,
                epoch: Date.now(),
              } as unknown as HostServerMessage);
            });
          });
          return;
        }
        case 'plugin_enable': {
          const pluginId = (parsed as { id?: string }).id ?? '';
          if (!agentDir || !pluginId) return;
          const llmProvider = agentOpts?.apiKey
            ? createLlmProvider({
                apiKey: agentOpts.apiKey,
                providerId: currentProviderId ?? agentOpts.providerId,
                modelId: currentModelId ?? agentOpts.modelId,
                baseUrl: agentOpts.baseUrl,
              })
            : undefined;
          void activatePlugin(agentDir, pluginId, llmProvider).then((result) => {
            sendJson(ws, {
              type: 'plugin_job',
              jobId: `enable-${pluginId}-${Date.now()}`,
              action: 'install',
              pluginId,
              phase: 'done',
              ok: result.ok,
              error: result.error,
            } as unknown as HostServerMessage);
            void scanPlugins(agentDir).then((plugins) => {
              sendJson(ws, {
                type: 'plugins',
                plugins,
                epoch: Date.now(),
              } as unknown as HostServerMessage);
            });
          });
          return;
        }
        case 'plugin_disable': {
          const pluginId = (parsed as { id?: string }).id ?? '';
          if (agentDir && pluginId) {
            void deactivatePlugin(agentDir, pluginId).then(() => {
              void scanPlugins(agentDir).then((plugins) => {
                sendJson(ws, {
                  type: 'plugins',
                  plugins,
                  epoch: Date.now(),
                } as unknown as HostServerMessage);
              });
            });
          }
          return;
        }
        case 'plugin_catalog_add': {
          if (!agentDir) return;
          const entry = parsed as {
            id?: string;
            name?: string;
            source?: string;
            description?: string;
            icon?: string;
          };
          if (entry.id && entry.name && entry.source) {
            void addCatalogEntry(agentDir, {
              id: entry.id,
              name: entry.name,
              source: entry.source,
              description: entry.description,
              icon: entry.icon,
              builtin: false,
            }).then(() => {
              void readCatalog(agentDir).then((catalog) => {
                sendJson(ws, {
                  type: 'plugin_catalog',
                  entries: catalog,
                  epoch: Date.now(),
                } as unknown as HostServerMessage);
              });
            });
          }
          return;
        }
        case 'plugin_catalog_remove': {
          const id = (parsed as { id?: string }).id ?? '';
          if (agentDir && id) {
            void removeCatalogEntry(agentDir, id).then(() => {
              void readCatalog(agentDir).then((catalog) => {
                sendJson(ws, {
                  type: 'plugin_catalog',
                  entries: catalog,
                  epoch: Date.now(),
                } as unknown as HostServerMessage);
              });
            });
          }
          return;
        }
        case 'plugin_grants': {
          if (!agentDir) {
            sendJson(ws, { type: 'plugin_grants', grants: [] } as unknown as HostServerMessage);
            return;
          }
          void listGrants(agentDir).then((grants) => {
            sendJson(ws, {
              type: 'plugin_grants',
              grants: grants.map((g) => ({ pluginId: g.pluginId, paths: g.paths })),
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'plugin_permissions': {
          if (!agentDir) {
            sendJson(ws, {
              type: 'plugin_permissions',
              grants: [],
            } as unknown as HostServerMessage);
            return;
          }
          void listPermissions(agentDir).then((perms) => {
            sendJson(ws, {
              type: 'plugin_permissions',
              grants: perms,
            } as unknown as HostServerMessage);
          });
          return;
        }
        case 'plugin_path_response': {
          const pluginId = (parsed as { pluginId?: string }).pluginId ?? '';
          const path = (parsed as { path?: string }).path ?? '';
          const granted = (parsed as { granted?: boolean }).granted === true;
          if (agentDir && pluginId && path && granted) {
            void grantDirAccess(agentDir, pluginId, path);
          }
          return;
        }
        case 'plugin_permission_response': {
          const pluginId = (parsed as { pluginId?: string }).pluginId ?? '';
          const family = (parsed as { family?: string }).family ?? '';
          const granted = (parsed as { granted?: boolean }).granted === true;
          if (agentDir && pluginId && family === 'net' && granted) {
            const hosts = (parsed as { hosts?: string[] }).hosts ?? [];
            for (const host of hosts) {
              void grantNetHost(agentDir, pluginId, host);
            }
          }
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
      disposeAllTerminals();
      disposeAllSsh();
      if (agentDir) void deactivateAllPlugins(agentDir);
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
