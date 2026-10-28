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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startPiWebHostServer, type PiWebHostServerHandle } from '../src/server';
import { HOST_TOKEN_COOKIE, buildHostUrl, generateToken } from '../src/auth';

const handles: PiWebHostServerHandle[] = [];
let wwwDir: string;

async function startServer(): Promise<PiWebHostServerHandle> {
  wwwDir = mkdtempSync(join(tmpdir(), 'piwh-srv-'));
  writeFileSync(join(wwwDir, 'index.html'), '<!doctype html><html><body>pi-web</body></html>');
  const handle = await startPiWebHostServer({ wwwDir });
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
