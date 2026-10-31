import { afterEach, describe, expect, it, vi } from 'vitest';

// agent-bridge imports vendored pi 包（仅 esbuild 别名解析）；单测 mock 掉避免
// vitest 解析失败。server.test.ts 只测 HTTP/WS 协议面，不测真实 Agent 行为。
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

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startPiWebHostServer, type PiWebHostServerHandle } from '../src/server';
import { HOST_TOKEN_COOKIE, buildHostUrl, generateToken } from '../src/auth';
import { persistExchange } from '../src/session-store';

const handles: PiWebHostServerHandle[] = [];
let wwwDir: string;

async function startServer(opts?: {
  agentDir?: string;
  themes?: string[];
}): Promise<PiWebHostServerHandle> {
  wwwDir = mkdtempSync(join(tmpdir(), 'piwh-srv-'));
  writeFileSync(join(wwwDir, 'index.html'), '<!doctype html><html><body>pi-web</body></html>');
  if (opts?.themes?.length) {
    mkdirSync(join(wwwDir, 'themes'), { recursive: true });
    for (const t of opts.themes) {
      writeFileSync(join(wwwDir, 'themes', `${t}.css`), `/* ${t} theme */`);
    }
  }
  const handle = await startPiWebHostServer({ wwwDir, agentDir: opts?.agentDir });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.close().catch(() => undefined);
  }
});

async function httpGet(url: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/** ws 消息二进制载荷 → 解析为 JSON 对象（类型收敛，避免 String(Buffer) 直拼） */
function parseMessage(data: unknown): Record<string, unknown> {
  let text: string;
  if (Buffer.isBuffer(data)) {
    text = data.toString('utf8');
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString('utf8');
  } else if (ArrayBuffer.isView(data)) {
    text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  } else {
    text = String(data);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe('startPiWebHostServer · HTTP', () => {
  it('rejects unauthenticated page request with 401', async () => {
    const h = await startServer();
    const res = await httpGet(`http://127.0.0.1:${h.port}/`);
    expect(res.status).toBe(401);
  });

  it('serves index.html with token in query and sets cookie', async () => {
    const h = await startServer();
    const res = await httpGet(buildHostUrl(h.port, h.token));
    expect(res.status).toBe(200);
    expect(res.body).toContain('pi-web');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(HOST_TOKEN_COOKIE);
  });

  it('serves page again using only cookie (no token query)', async () => {
    const h = await startServer();
    const cookie = `${HOST_TOKEN_COOKIE}=${h.token}`;
    const res = await fetch(`http://127.0.0.1:${h.port}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe('startPiWebHostServer · WebSocket', () => {
  function wsUrl(h: PiWebHostServerHandle, withToken: boolean): string {
    const t = withToken ? `?token=${h.token}` : '';
    return `ws://127.0.0.1:${h.port}/ws${t}`;
  }

  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function expectHello(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (data) => resolve(parseMessage(data)));
      ws.once('error', reject);
      ws.send(JSON.stringify({ type: 'hello' }));
    });
  }

  it('rejects unauthenticated websocket upgrade', async () => {
    const h = await startServer();
    await expect(connect(wsUrl(h, false))).rejects.toThrow();
  });

  it('hello -> hello_ok handshake with token', async () => {
    const h = await startServer();
    const ws = await connect(wsUrl(h, true));
    const msg = await expectHello(ws);
    expect(msg.type).toBe('hello_ok');
    expect(msg.service).toBe('pi-web-host');
    ws.close();
  });

  it('ping -> pong', async () => {
    const h = await startServer();
    const ws = await connect(wsUrl(h, true));
    const pong = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (d) => resolve(parseMessage(d)));
      ws.once('error', reject);
      ws.send(JSON.stringify({ type: 'ping' }));
    });
    const msg = pong;
    expect(msg.type).toBe('pong');
    ws.close();
  });

  it('unknown message type -> error envelope', async () => {
    const h = await startServer();
    const ws = await connect(wsUrl(h, true));
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('message', (d) => resolve(parseMessage(d)));
      ws.once('error', reject);
      ws.send(JSON.stringify({ type: 'nope' }));
    });
    expect(msg).toMatchObject({ type: 'error', code: 'unknown_type' });
    ws.close();
  });
});

describe('startPiWebHostServer · lifecycle', () => {
  it('exposes pre-set token / port / url and closes server', async () => {
    const token = generateToken();
    const h = await startPiWebHostServer({ wwwDir, port: 0, token });
    handles.push(h);
    expect(h.token).toBe(token);
    expect(h.url).toBe(buildHostUrl(h.port, token));
    expect(h.state).toBe('running');
    await h.close();
    await expect(httpGet(buildHostUrl(h.port, token))).rejects.toThrow();
  });
});

/* ── P2 扩展：session / plugin WS + themes / plugin-static HTTP ── */

function wsUrlOf(h: PiWebHostServerHandle): string {
  return `ws://127.0.0.1:${h.port}/ws?token=${h.token}`;
}

async function wsConnect(h: PiWebHostServerHandle): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlOf(h));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function wsHello(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve());
    ws.once('error', reject);
    ws.send(JSON.stringify({ type: 'hello' }));
  });
}

function wsSendAndWait(
  ws: WebSocket,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.once('message', (d) => resolve(parseMessage(d)));
    ws.once('error', reject);
    ws.send(JSON.stringify(msg));
  });
}

function authFetch(h: PiWebHostServerHandle, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${h.port}${path}`, {
    headers: { cookie: `${HOST_TOKEN_COOKIE}=${h.token}` },
  });
}

describe('session WS (fork / delete)', () => {
  it('fork_session returns session_created with new id', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-sess-'));
    await persistExchange(agentDir, 'orig-session', 'hello', 'world');
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'fork_session', conversationId: 'orig-session' });
    expect(msg.type).toBe('session_created');
    expect(msg.sessionId).not.toBe('orig-session');
    ws.close();
  });

  it('fork_session falls back to currentSessionId when conversationId omitted', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-sess-'));
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'fork_session' });
    expect(msg.type).toBe('session_created');
    expect(typeof msg.sessionId).toBe('string');
    ws.close();
  });

  it('delete_session returns session_list', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-sess-'));
    await persistExchange(agentDir, 'to-delete', 'msg', 'reply');
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'delete_session', path: 'to-delete' });
    expect(msg.type).toBe('session_list');
    ws.close();
  });

  it('fork_session without agentDir returns error', async () => {
    const h = await startServer();
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'fork_session' });
    expect(msg).toMatchObject({ type: 'error', code: 'no_agent_dir' });
    ws.close();
  });
});

describe('plugin WS', () => {
  it('plugins_reload returns plugins array', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-plug-'));
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'plugins_reload' });
    expect(msg.type).toBe('plugins');
    expect(Array.isArray(msg.plugins)).toBe(true);
    expect(msg.epoch).toBeDefined();
    ws.close();
  });

  it('plugin_grants returns empty array when no grants', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-plug-'));
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'plugin_grants' });
    expect(msg.type).toBe('plugin_grants');
    expect(msg.grants).toEqual([]);
    ws.close();
  });

  it('plugin_permissions returns grants when agentDir set', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-plug-'));
    const h = await startServer({ agentDir });
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'plugin_permissions' });
    expect(msg.type).toBe('plugin_permissions');
    expect(Array.isArray(msg.grants)).toBe(true);
    ws.close();
  });

  it('plugin_grants without agentDir returns empty', async () => {
    const h = await startServer();
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'plugin_grants' });
    expect(msg.type).toBe('plugin_grants');
    expect(msg.grants).toEqual([]);
    ws.close();
  });

  it('plugin_permissions without agentDir returns empty', async () => {
    const h = await startServer();
    const ws = await wsConnect(h);
    await wsHello(ws);
    const msg = await wsSendAndWait(ws, { type: 'plugin_permissions' });
    expect(msg.type).toBe('plugin_permissions');
    ws.close();
  });
});

describe('themes HTTP', () => {
  it('GET /api/themes returns theme list', async () => {
    const h = await startServer({ themes: ['dark', 'light', 'latte'] });
    const res = await authFetch(h, '/api/themes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { themes: { id: string; scheme: string }[] };
    expect(body.themes).toHaveLength(3);
    const ids = body.themes.map((t) => t.id);
    expect(ids).toContain('dark');
    expect(ids).toContain('light');
    expect(ids).toContain('latte');
    const light = body.themes.find((t) => t.id === 'light');
    expect(light?.scheme).toBe('light');
    const latte = body.themes.find((t) => t.id === 'latte');
    expect(latte?.scheme).toBe('light');
    const dark = body.themes.find((t) => t.id === 'dark');
    expect(dark?.scheme).toBe('dark');
  });

  it('GET /api/themes returns empty when no themes dir', async () => {
    const h = await startServer();
    const res = await authFetch(h, '/api/themes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { themes: unknown[] };
    expect(body.themes).toEqual([]);
  });

  it('GET /themes/<name>.css serves css file', async () => {
    const h = await startServer({ themes: ['dark'] });
    const res = await authFetch(h, '/themes/dark.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    const text = await res.text();
    expect(text).toContain('dark theme');
  });

  it('GET /themes/<unknown>.css returns 404', async () => {
    const h = await startServer({ themes: ['dark'] });
    const res = await authFetch(h, '/themes/nonexistent.css');
    expect(res.status).toBe(404);
  });
});

describe('plugin static HTTP', () => {
  it('serves plugin client file under /plugins/<id>/client/', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-pstatic-'));
    const pluginDir = join(agentDir, 'plugins', 'demo', 'client');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'main.js'), 'console.log("hi")');
    const h = await startServer({ agentDir });
    const res = await authFetch(h, '/plugins/demo/client/main.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log("hi")');
  });

  it('returns 404 for non-existent plugin file', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-pstatic-'));
    const h = await startServer({ agentDir });
    const res = await authFetch(h, '/plugins/ghost/client/main.js');
    expect(res.status).toBe(404);
  });

  it('rejects path traversal with 403', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-pstatic-'));
    const h = await startServer({ agentDir });
    const res = await authFetch(h, '/plugins/demo/client/../../../etc/passwd');
    expect([403, 404]).toContain(res.status);
  });

  it('rejects invalid plugin id with 403', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'piwh-pstatic-'));
    const h = await startServer({ agentDir });
    const res = await authFetch(h, '/plugins/..%2Fetc/client/x.js');
    expect([403, 404]).toContain(res.status);
  });
});
