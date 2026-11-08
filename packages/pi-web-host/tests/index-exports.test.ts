/**
 * index.ts 公共面测试
 *
 * 宿主包对外导出的形状是 desktop 主进程与单测的契约：任何导出改名/丢失都会
 * 在编译期之外静默破坏调用方，这里按「函数/常量存在 + 关键值」锁定。
 * vendored pi 包用 vi.mock 替代（vitest 无法解析 esbuild 别名）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: class MockAgent {
    subscribe() {
      return () => undefined;
    }
    async prompt() {
      /* mock */
    }
    abort() {
      /* mock */
    }
  },
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => undefined),
  getProviders: vi.fn(() => []),
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashTool: vi.fn(() => ({})),
  createReadTool: vi.fn(() => ({})),
  createEditTool: vi.fn(() => ({})),
  createWriteTool: vi.fn(() => ({})),
}));

import * as host from '../src/index';

const FUNCTION_EXPORTS = [
  'startPiWebHostServer',
  'generateToken',
  'buildHostUrl',
  'isAuthorizedRequest',
  'isTokenValid',
  'tokenFromQuery',
  'tokenFromCookie',
  'buildTokenCookie',
  'createStaticHandler',
  'buildPiServerUrl',
  'handleClientMessage',
  'sendJson',
  'sendError',
  'createAgentBridge',
  'normalizeProviderId',
  'resolveModel',
  'extractDeltaForTest',
  'getProviderList',
  'persistExchange',
  'listSessions',
  'loadSessionMessages',
  'generateSessionId',
] as const;

describe('@urchin/pi-web-host public surface', () => {
  it('should export every documented function', () => {
    for (const name of FUNCTION_EXPORTS) {
      expect(typeof (host as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('should export the StaticHandler class', () => {
    expect(typeof host.StaticHandler).toBe('function');
  });

  it('should pin the service version and ready prefixes', () => {
    expect(host.SERVICE_VERSION).toBe('0.2.0');
    expect(host.HOST_READY_PREFIX).toBe('pi-web-host ready: ');
    expect(host.PI_SERVER_READY_PREFIX).toBe('pi-server ready: ');
    expect(host.HOST_TOKEN_COOKIE).toBe('ub_pi_host_token');
  });

  it('should expose ready-line regexes that parse a full line', () => {
    const hostLine = `${host.HOST_READY_PREFIX}http://127.0.0.1:1/?token=abc\n`;
    expect(host.HOST_READY_LINE_RE.exec(hostLine)?.[1]).toBe('http://127.0.0.1:1/?token=abc');
    const piLine = `${host.PI_SERVER_READY_PREFIX}http://127.0.0.1:2/?token=def\n`;
    expect(host.PI_SERVER_READY_LINE_RE.exec(piLine)?.[1]).toBe('http://127.0.0.1:2/?token=def');
  });
});
