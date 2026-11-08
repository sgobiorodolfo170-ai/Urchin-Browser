/**
 * server.ts Agent 对话链路测试（注入 agent-bridge 假件）
 *
 * 覆盖 ensureBridge 的懒加载与凭据门禁、prompt 的流式累积与落盘、set_model
 * 重建桥、abort、tool_approval_response、ephemeral 会话不落盘、prompt 失败回执。
 * 真实 Provider / 网络不在范围内（agent-bridge 被 mock）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import type { AgentBridgeHandle, AgentBridgeOptions } from '../src/agent-bridge';

interface FakeBridge {
  options: AgentBridgeOptions;
  onMessage: (msg: Record<string, unknown>) => void;
  promptCalls: string[];
  promptResult: 'resolve' | 'reject';
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  resolveApproval: ReturnType<typeof vi.fn>;
  releasePrompt: () => void;
}

const { bridges, createAgentBridgeMock, createLlmProviderMock } = vi.hoisted(() => {
  const list: unknown[] = [];
  return {
    bridges: list,
    createAgentBridgeMock: vi.fn(),
    createLlmProviderMock: vi.fn(() => ({})),
  };
});

vi.mock('../src/agent-bridge', () => ({
  createAgentBridge: createAgentBridgeMock,
  getProviderList: () => ['anthropic', 'openai'],
  createLlmProvider: createLlmProviderMock,
  normalizeProviderId: (value: string) => value,
  resolveModel: () => ({}),
  extractDeltaForTest: () => ({}),
}));

import { startPiWebHostServer, type PiWebHostServerHandle } from '../src/server';
import { listSessions } from '../src/session-store';

const handles: PiWebHostServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  bridges.length = 0;
  createAgentBridgeMock.mockReset();
  createLlmProviderMock.mockReset();
  createLlmProviderMock.mockReturnValue({});
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type FakeList = FakeBridge[];

function installFakeBridge(behaviour: { promptResult?: 'resolve' | 'reject' } = {}): FakeList {
  const list = bridges as unknown as FakeList;
  createAgentBridgeMock.mockImplementation(
    (
      options: AgentBridgeOptions,
      onMessage: (msg: Record<string, unknown>) => void,
      onError: (code: string, message: string) => void,
    ) => {
      let release: () => void = () => undefined;
      const bridge: FakeBridge = {
        options,
        onMessage,
        promptCalls: [],
        promptResult: behaviour.promptResult ?? 'resolve',
        abort: vi.fn(),
        dispose: vi.fn(),
        resolveApproval: vi.fn(),
        releasePrompt: () => release(),
      };
      const handle = {
        prompt: (text: string) => {
          bridge.promptCalls.push(text);
          return new Promise<void>((resolve, reject) => {
            release = () => {
              if (bridge.promptResult === 'reject') reject(new Error('provider exploded'));
              else resolve();
            };
          });
        },
        abort: bridge.abort,
        dispose: bridge.dispose,
        resolveApproval: bridge.resolveApproval,
      } as unknown as AgentBridgeHandle;
      void onError;
      list.push(bridge);
      return handle;
    },
  );
  return list;
}

async function startServer(options: { agentDir?: string } = {}): Promise<PiWebHostServerHandle> {
  const wwwDir = tempDir('piwh-flow-www-');
  const handle = await startPiWebHostServer({
    wwwDir,
    agentDir: options.agentDir,
    agent: { apiKey: 'sk-test', providerId: 'anthropic', modelId: 'claude-sonnet-4' },
  });
  handles.push(handle);
  return handle;
}

function parseMessage(data: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(data)) return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  return JSON.parse(String(data)) as Record<string, unknown>;
}

interface Client {
  send: (msg: Record<string, unknown>) => void;
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
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (label) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const queued = inbox.shift();
        if (queued) {
          res(queued);
          return;
        }
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), 5_000);
        waiters.push({ resolve: res, timer });
      }),
    close: () => ws.close(),
  };
}

describe('prompt flow', () => {
  it('should create a bridge on first prompt and forward the text', async () => {
    const list = installFakeBridge();
    const h = await startServer({ agentDir: tempDir('piwh-flow-agent-') });
    const c = await connect(h);

    c.send({ type: 'prompt', text: 'hello agent' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    const bridge = list[0];
    expect(bridge.options).toMatchObject({
      apiKey: 'sk-test',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
    expect(typeof bridge.options.sessionId).toBe('string');
    expect(bridge.options.extraTools).toEqual([]);
    expect(bridge.promptCalls).toEqual(['hello agent']);
    bridge.releasePrompt();
    c.close();
  });

  it('should reject an empty prompt text', async () => {
    const list = installFakeBridge();
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: '' });
    expect(await c.next('bad_message')).toMatchObject({
      type: 'error',
      code: 'bad_message',
      message: 'prompt.text required',
    });
    // ensureBridge 先于文本校验执行，会建一次桥（无 agentDir 时仍可用）
    expect(list).toHaveLength(1);
    c.close();
  });

  it('should surface prompt failures as prompt_failed', async () => {
    const list = installFakeBridge({ promptResult: 'reject' });
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: 'boom' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    list[0].releasePrompt();
    expect(await c.next('prompt_failed')).toMatchObject({
      type: 'error',
      code: 'prompt_failed',
      message: 'provider exploded',
    });
    c.close();
  });

  it('should accumulate stream chunks and persist the exchange', async () => {
    const agentDir = tempDir('piwh-flow-agent-');
    const list = installFakeBridge();
    const h = await startServer({ agentDir });
    const c = await connect(h);

    c.send({ type: 'prompt', text: 'what is pi?' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    const bridge = list[0];
    bridge.onMessage({ type: 'stream.chunk', content: 'pi ' });
    bridge.onMessage({ type: 'stream.chunk', content: 'is a browser' });
    bridge.onMessage({ type: 'stream.end', finishReason: 'stop', usage: null });
    bridge.releasePrompt();
    await vi.waitFor(async () => {
      const sessions = await listSessions(agentDir);
      expect(sessions.length).toBeGreaterThan(0);
    });

    const sessions = await listSessions(agentDir);
    expect(sessions[0]?.firstMessage).toContain('what is pi?');
    c.close();
  });

  it('should not persist an ephemeral session', async () => {
    const agentDir = tempDir('piwh-flow-agent-');
    const list = installFakeBridge();
    const h = await startServer({ agentDir });
    const c = await connect(h);

    c.send({ type: 'new_session', ephemeral: true });
    await c.next('session_created');
    c.send({ type: 'prompt', text: 'temporary question' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    const bridge = list[0];
    bridge.onMessage({ type: 'stream.chunk', content: 'temporary answer' });
    bridge.onMessage({ type: 'stream.end', finishReason: 'stop', usage: null });
    bridge.releasePrompt();
    await new Promise((r) => setTimeout(r, 100));
    expect(await listSessions(agentDir)).toEqual([]);
    c.close();
  });

  it('should forward abort to the active bridge', async () => {
    const list = installFakeBridge();
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: 'long task' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    c.send({ type: 'abort' });
    await vi.waitFor(() => expect(list[0].abort).toHaveBeenCalledTimes(1));
    list[0].releasePrompt();
    c.close();
  });

  it('should resolve tool approvals through the bridge', async () => {
    const list = installFakeBridge();
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: 'edit a file' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    c.send({ type: 'tool_approval_response', id: 'apr-9', decision: 'edit' });
    await vi.waitFor(() => expect(list[0].resolveApproval).toHaveBeenCalledWith('apr-9', 'edit'));
    expect(await c.next('approval_resolved')).toEqual({
      type: 'tool_approval_resolved',
      id: 'apr-9',
    });
    list[0].releasePrompt();
    c.close();
  });
});

describe('session switching rebuilds the bridge', () => {
  it('should apply set_model to the next bridge', async () => {
    const list = installFakeBridge();
    const h = await startServer({ agentDir: tempDir('piwh-flow-agent-') });
    const c = await connect(h);

    c.send({ type: 'prompt', text: 'first' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    list[0].releasePrompt();

    c.send({ type: 'set_model', modelId: 'openai/gpt-5' });
    c.send({ type: 'prompt', text: 'second' });
    await vi.waitFor(() => expect(list).toHaveLength(2));
    expect(list[0].dispose).toHaveBeenCalled();
    expect(list[1]?.options).toMatchObject({ providerId: 'openai', modelId: 'gpt-5' });
    list[1].releasePrompt();
    c.close();
  });

  it('should keep the current model when set_model only switches provider', async () => {
    const list = installFakeBridge();
    const h = await startServer();
    const c = await connect(h);

    c.send({ type: 'prompt', text: 'first' });
    await vi.waitFor(() => expect(list).toHaveLength(1));
    list[0].releasePrompt();

    c.send({ type: 'set_model', modelId: 'openai' });
    c.send({ type: 'prompt', text: 'second' });
    await vi.waitFor(() => expect(list).toHaveLength(2));
    expect(list[1]?.options).toMatchObject({
      providerId: 'openai',
      modelId: 'claude-sonnet-4',
    });
    list[1].releasePrompt();
    c.close();
  });

  it('should dispose the bridge on new_session and close', async () => {
    const list = installFakeBridge();
    const h = await startServer();
    const c = await connect(h);
    c.send({ type: 'prompt', text: 'first' });
    await vi.waitFor(() => expect(list).toHaveLength(1));

    c.send({ type: 'new_session' });
    await c.next('session_created');
    expect(list[0].dispose).toHaveBeenCalled();

    const before = list[0].dispose.mock.calls.length;
    c.close();
    expect(before).toBeGreaterThan(0);
  });
});
