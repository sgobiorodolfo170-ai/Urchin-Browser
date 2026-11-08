/**
 * server.ts WebSocket / HTTP 分支测试（无 Agent 凭据路径）
 *
 * server.test.ts 已覆盖 hello/ping/未知类型与主题、插件静态、会话 fork/delete。
 * 本文件补齐其余无状态分支：错误信封（坏 JSON / 二进制）、prompt 无 key、
 * get_state、new/switch/list session、compacted、set_cwd、SCM 四类请求、
 * 插件安装/启用/禁用/catalog/授权、模型管理域缺 agentDir、file-ops 回落，
 * 以及 Cookie 只回写一次的 HTTP 行为。
 *
 * 终端 / SSH / 真实 Agent 流式需要原生模块或 Provider，不在本文件范围。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

// agent-bridge 静态 import 了 vendored pi 包（仅 esbuild 别名可解析）；这里替身化。
// 另：plugin_enable 会 await import('./agent-bridge')，因此必须 mock 整个模块。
vi.mock('../src/agent-bridge', () => ({
  createAgentBridge: vi.fn(),
  getProviderList: () => ['anthropic', 'openai'],
  createLlmProvider: vi.fn(() => ({})),
  normalizeProviderId: (value: string) => value,
  resolveModel: () => ({}),
  extractDeltaForTest: () => ({}),
}));

import { startPiWebHostServer, type PiWebHostServerHandle } from '../src/server';
import { HOST_TOKEN_COOKIE } from '../src/auth';
import { persistExchange } from '../src/session-store';
import { setDomConsent } from '../src/plugin-permissions';

const handles: PiWebHostServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startServer(opts?: { agentDir?: string }): Promise<PiWebHostServerHandle> {
  const wwwDir = tempDir('piwh-ws-www-');
  writeFileSync(join(wwwDir, 'index.html'), '<!doctype html><html><body>pi-web</body></html>');
  const handle = await startPiWebHostServer({ wwwDir, agentDir: opts?.agentDir });
  handles.push(handle);
  return handle;
}

function parseMessage(data: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString('utf8')) as Record<string, unknown>;
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'),
    ) as Record<string, unknown>;
  }
  return JSON.parse(String(data)) as Record<string, unknown>;
}

interface Client {
  ws: WebSocket;
  send: (msg: Record<string, unknown> | string) => void;
  sendBinary: (payload: Buffer) => void;
  next: (label: string) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function connect(h: PiWebHostServerHandle): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?token=${h.token}`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const inbox: Record<string, unknown>[] = [];
  const waiters: {
    resolve: (m: Record<string, unknown>) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];
  ws.on('message', (data) => {
    const msg = parseMessage(data);
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });
  return {
    ws,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    sendBinary: (payload) => ws.send(payload),
    next: (label) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const queued = inbox.shift();
        if (queued) {
          res(queued);
          return;
        }
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), 5_000);
        waiters.push({ resolve: res, reject: rej, timer });
      }),
    close: () => ws.close(),
  };
}

function authFetch(h: PiWebHostServerHandle, path: string, cookie = true): Promise<Response> {
  return fetch(`http://127.0.0.1:${h.port}${path}`, {
    headers: cookie ? { cookie: `${HOST_TOKEN_COOKIE}=${h.token}` } : {},
  });
}

/** 授权落盘是 fire-and-forget，轮询直到可见（避免读写在临时目录上竞态） */
async function waitForGrants(c: Client): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    c.send({ type: 'plugin_grants' });
    const msg = await c.next('plugin_grants');
    const grants = (msg.grants ?? []) as Record<string, unknown>[];
    if (grants.length > 0) return grants;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('grants were not persisted in time');
}

async function waitForPermissions(c: Client): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    c.send({ type: 'plugin_permissions' });
    const msg = await c.next('plugin_permissions');
    const grants = (msg.grants ?? []) as Record<string, unknown>[];
    if (grants.length > 0) return grants;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('permissions were not persisted in time');
}

describe('WS protocol errors', () => {
  it('should reject invalid JSON with bad_message', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send('{not json');
    expect(await c.next('bad_message')).toMatchObject({
      type: 'error',
      code: 'bad_message',
      message: 'invalid JSON',
    });
    c.close();
  });

  it('should reject binary frames', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.sendBinary(Buffer.from([1, 2, 3]));
    expect(await c.next('binary error')).toMatchObject({
      type: 'error',
      code: 'bad_message',
      message: 'text/JSON only',
    });
    c.close();
  });

  it('should fall through to the stateless handler for unknown types', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-agent-') });
    const c = await connect(h);
    c.send({ type: 'definitely_unknown' });
    expect(await c.next('unknown')).toMatchObject({ type: 'error', code: 'unknown_type' });
    c.close();
  });

  it('should answer list_models from the bridge provider list', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'list_models' });
    expect(await c.next('models')).toEqual({
      type: 'models',
      providers: ['anthropic', 'openai'],
    });
    c.close();
  });
});

describe('prompt / state / sessions', () => {
  it('should report no_api_key when no credentials are configured', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: 'hello' });
    expect(await c.next('no_api_key')).toMatchObject({ type: 'error', code: 'no_api_key' });
    c.close();
  });

  it('should return the idle state', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'get_state' });
    expect(await c.next('state')).toEqual({
      type: 'state',
      streaming: false,
      messageCount: 0,
    });
    c.close();
  });

  it('should create a new session id', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'new_session' });
    const created = await c.next('session_created');
    expect(created.type).toBe('session_created');
    expect(typeof created.sessionId).toBe('string');
    expect(String(created.sessionId).length).toBeGreaterThan(0);
    c.close();
  });

  it('should return an empty session list without agentDir', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'list_sessions' });
    expect(await c.next('session_list')).toEqual({ type: 'session_list', sessions: [] });
    c.close();
  });

  it('should list persisted sessions with path aliases', async () => {
    const agentDir = tempDir('piwh-ws-agent-');
    await persistExchange(agentDir, 'conv-1', 'hi', 'hello');
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'list_sessions' });
    const list = await c.next('session_list');
    const sessions = list.sessions as Record<string, unknown>[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'conv-1', path: 'conv-1' });
    c.close();
  });

  it('should reject switch_session without a session id', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'switch_session' });
    expect(await c.next('bad_message')).toMatchObject({
      type: 'error',
      code: 'bad_message',
      message: 'switch_session.sessionId required',
    });
    c.close();
  });

  it('should switch to an empty conversation without agentDir', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'switch_session', sessionId: 'conv-x' });
    expect(await c.next('session_switched')).toEqual({
      type: 'session_switched',
      sessionId: 'conv-x',
      messages: [],
    });
    c.close();
  });

  it('should load persisted messages on switch_session', async () => {
    const agentDir = tempDir('piwh-ws-agent-');
    await persistExchange(agentDir, 'conv-2', 'question', 'answer');
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'switch_session', sessionId: 'conv-2' });
    const switched = await c.next('session_switched');
    expect(switched.type).toBe('session_switched');
    expect((switched.messages as unknown[]).length).toBeGreaterThan(0);
    c.close();
  });

  it('should report no compacted history', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'get_compacted_messages', compactionMessageId: 'cmp-1' });
    expect(await c.next('compacted')).toMatchObject({
      type: 'compacted_messages_result',
      compactionMessageId: 'cmp-1',
      messages: [],
      error: 'no compacted history',
    });
    c.close();
  });

  it('should reflect set_cwd in the next hello_ok', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'set_cwd', path: '/tmp/somewhere' });
    c.send({ type: 'hello' });
    expect(await c.next('hello_ok')).toMatchObject({ type: 'hello_ok', cwd: '/tmp/somewhere' });
    c.close();
  });

  it('should acknowledge tool approvals with the resolved id', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'tool_approval_response', id: 'apr-1', decision: 'deny' });
    expect(await c.next('approval')).toEqual({ type: 'tool_approval_resolved', id: 'apr-1' });
    c.close();
  });
});

describe('SCM requests', () => {
  async function connectInDir(agentDir: string): Promise<Client> {
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'set_cwd', path: agentDir });
    return c;
  }

  it('should answer scm_status for a non-git directory', async () => {
    const dir = tempDir('piwh-ws-scm-');
    const c = await connectInDir(dir);
    c.send({ type: 'scm_status', reqId: 1 });
    const msg = await c.next('scm_data');
    expect(msg).toMatchObject({ type: 'scm_data', reqId: 1, kind: 'status' });
    // 现状：非 git 目录返回 ok:true + 空列表（notRepo 分支不可达，见缺陷 SCM-01）
    expect(msg.ok).toBe(true);
    expect(msg.files).toEqual([]);
    expect(msg.branches).toEqual([]);
    c.close();
  });

  it('should mark a non-git directory as notRepo', async () => {
    const dir = tempDir('piwh-ws-scm-');
    const c = await connectInDir(dir);
    c.send({ type: 'scm_status', reqId: 2 });
    const msg = await c.next('scm_data');
    expect(msg.notRepo).toBe(true);
    c.close();
  });

  it('should answer scm_history', async () => {
    const c = await connectInDir(tempDir('piwh-ws-scm-'));
    c.send({ type: 'scm_history', reqId: 2 });
    expect(await c.next('scm_data')).toMatchObject({
      type: 'scm_data',
      reqId: 2,
      kind: 'history',
    });
    c.close();
  });

  it('should answer scm_filediff', async () => {
    const c = await connectInDir(tempDir('piwh-ws-scm-'));
    c.send({ type: 'scm_filediff', reqId: 3, path: 'a.ts' });
    expect(await c.next('scm_data')).toMatchObject({
      type: 'scm_data',
      reqId: 3,
      kind: 'filediff',
    });
    c.close();
  });

  it('should answer scm_commit', async () => {
    const c = await connectInDir(tempDir('piwh-ws-scm-'));
    c.send({ type: 'scm_commit', reqId: 4, hash: 'abc' });
    expect(await c.next('scm_data')).toMatchObject({
      type: 'scm_data',
      reqId: 4,
      kind: 'commit',
    });
    c.close();
  });

  it('should return an empty commit message', async () => {
    const c = await connectInDir(tempDir('piwh-ws-scm-'));
    c.send({ type: 'scm_commitmsg', reqId: 5 });
    expect(await c.next('scm_data')).toEqual({
      type: 'scm_data',
      reqId: 5,
      kind: 'commitmsg',
      ok: true,
      text: '',
    });
    c.close();
  });
});

describe('plugin routes', () => {
  it('should reload plugins', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({ type: 'plugins_reload' });
    const msg = await c.next('plugins');
    expect(msg.type).toBe('plugins');
    expect(msg.plugins).toEqual([]);
    c.close();
  });

  it('should install a plugin from a local path', async () => {
    const agentDir = tempDir('piwh-ws-plug-');
    const sourceDir = tempDir('piwh-ws-src-');
    writeFileSync(join(sourceDir, 'manifest.json'), JSON.stringify({ name: 'Demo' }));
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'plugin_install', source: sourceDir, id: 'demo' });
    expect(await c.next('plugin_job')).toMatchObject({
      type: 'plugin_job',
      action: 'install',
      pluginId: 'demo',
      phase: 'done',
      ok: true,
    });
    const plugs = await c.next('plugins');
    expect((plugs.plugins as Record<string, unknown>[])[0]).toMatchObject({
      id: 'demo',
      name: 'Demo',
    });
    c.close();
  });

  it('should enable a static plugin', async () => {
    const agentDir = tempDir('piwh-ws-plug-');
    mkdirSync(join(agentDir, 'plugins', 'static-plugin'), { recursive: true });
    writeFileSync(
      join(agentDir, 'plugins', 'static-plugin', 'manifest.json'),
      JSON.stringify({ name: 'Static' }),
    );
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'plugin_enable', id: 'static-plugin' });
    expect(await c.next('plugin_job')).toMatchObject({
      action: 'install',
      pluginId: 'static-plugin',
      ok: true,
    });
    expect((await c.next('plugins')).type).toBe('plugins');
    c.close();
  });

  it('should disable a plugin and return the refreshed list', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({ type: 'plugin_disable', id: 'anything' });
    expect((await c.next('plugins')).type).toBe('plugins');
    c.close();
  });

  it('should add and remove catalog entries', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({
      type: 'plugin_catalog_add',
      id: 'cat-1',
      name: 'Catalog One',
      source: 'owner/repo',
    });
    const added = await c.next('plugin_catalog');
    expect((added.entries as Record<string, unknown>[])[0]).toMatchObject({ id: 'cat-1' });

    c.send({ type: 'plugin_catalog_remove', id: 'cat-1' });
    const removed = await c.next('plugin_catalog');
    expect(removed.entries).toEqual([]);
    c.close();
  });

  it('should persist a granted directory and echo it via plugin_grants', async () => {
    const agentDir = tempDir('piwh-ws-plug-');
    const target = join(agentDir, 'workspace');
    const h = await startServer({ agentDir });
    const c = await connect(h);
    c.send({ type: 'plugin_path_response', pluginId: 'p1', path: target, granted: true });
    const grants = await waitForGrants(c);
    expect(grants).toEqual([{ pluginId: 'p1', paths: [resolve(target)] }]);
    c.close();
  });

  it('should ignore a denied directory response', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({ type: 'plugin_path_response', pluginId: 'p1', path: '/tmp/x', granted: false });
    c.send({ type: 'plugin_grants' });
    expect((await c.next('plugin_grants')).grants).toEqual([]);
    c.close();
  });

  it('should persist granted network hosts', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({
      type: 'plugin_permission_response',
      pluginId: 'p1',
      family: 'net',
      granted: true,
      hosts: ['example.com'],
    });
    const perms = await waitForPermissions(c);
    expect(perms).toEqual([{ pluginId: 'p1', family: 'net', hosts: ['example.com'] }]);
    c.close();
  });

  it('should ignore non-net permission responses', async () => {
    const h = await startServer({ agentDir: tempDir('piwh-ws-plug-') });
    const c = await connect(h);
    c.send({
      type: 'plugin_permission_response',
      pluginId: 'p1',
      family: 'llm',
      granted: true,
      hosts: ['example.com'],
    });
    c.send({ type: 'plugin_permissions' });
    expect((await c.next('plugin_permissions')).grants).toEqual([]);
    c.close();
  });
});

describe('model admin without agentDir', () => {
  it('should report model_admin_unavailable', async () => {
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'list_providers' });
    expect(await c.next('model_admin')).toMatchObject({
      type: 'error',
      code: 'model_admin_unavailable',
      message: 'agentDir not configured',
    });
    c.close();
  });
});

describe('HTTP edge cases', () => {
  it('should set the token cookie only when absent', async () => {
    const h = await startServer();
    const url = `http://127.0.0.1:${h.port}/?token=${h.token}`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain(HOST_TOKEN_COOKIE);

    const second = await fetch(url, { headers: { cookie: `${HOST_TOKEN_COOKIE}=${h.token}` } });
    expect(second.status).toBe(200);
    expect(second.headers.get('set-cookie')).toBeNull();
  });

  it('should pass /plugins/ through the static handler when no agentDir is set', async () => {
    const h = await startServer();
    const res = await authFetch(h, '/plugins/demo/client/main.js');
    expect(res.status).toBe(404);
  });

  it('should require DOM consent before serving a privileged plugin client', async () => {
    const agentDir = tempDir('piwh-ws-dom-');
    const clientDir = join(agentDir, 'plugins', 'dom-plugin', 'client');
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'plugins', 'dom-plugin', 'manifest.json'),
      JSON.stringify({ name: 'Dom', permissions: ['dom'] }),
    );
    writeFileSync(join(clientDir, 'main.js'), 'export default 1;');
    const h = await startServer({ agentDir });

    const denied = await authFetch(h, '/plugins/dom-plugin/client/main.js');
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('dom consent required');

    await setDomConsent(agentDir, 'dom-plugin', true);
    const allowed = await authFetch(h, '/plugins/dom-plugin/client/main.js');
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe('export default 1;');
  });

  it('should serve unknown plugin extensions as octet-stream', async () => {
    const agentDir = tempDir('piwh-ws-mime-');
    const clientDir = join(agentDir, 'plugins', 'demo', 'client');
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, 'blob.bin'), Buffer.from([0, 1, 2]));
    const h = await startServer({ agentDir });
    const res = await authFetch(h, '/plugins/demo/client/blob.bin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
