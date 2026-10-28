/**
 * @urchin/pi-web-host · 阶段 2 托管服务公共面
 *
 * 供 desktop 主进程启动器与单测引用；utilityProcess 运行时走 entry.ts（bundle）。
 */
export {
  startPiWebHostServer,
  SERVICE_VERSION,
  type PiWebHostServerOptions,
  type PiWebHostServerHandle,
} from './server';
export {
  generateToken,
  buildHostUrl,
  isAuthorizedRequest,
  isTokenValid,
  tokenFromQuery,
  tokenFromCookie,
  buildTokenCookie,
  HOST_READY_PREFIX,
  HOST_READY_LINE_RE,
  HOST_TOKEN_COOKIE,
} from './auth';
export { createStaticHandler, StaticHandler, type StaticHandlerOptions } from './http-static';
export { handleClientMessage, sendJson, sendError } from './ws-handler';
export {
  createAgentBridge,
  normalizeProviderId,
  resolveModel,
  extractDeltaForTest,
  getProviderList,
  type AgentBridgeOptions,
  type AgentBridgeHandle,
} from './agent-bridge';
export {
  persistExchange,
  listSessions,
  loadSessionMessages,
  generateSessionId,
  type SessionInfo,
  type StoredMessage,
} from './session-store';
export type { HostClientMessage, HostServerMessage, PiWebHostState, HostUsage } from './types';
