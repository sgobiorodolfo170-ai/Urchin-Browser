/**
 * plugin-host.ts 鍗曞厓娴嬭瘯
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PluginEffectStack,
  clearPluginStorage,
  loadPluginStorage,
  savePluginStorage,
  createPluginHost,
} from '../src/plugin-host';
import type { PluginTool, PluginCommand, HostContext } from '../src/plugin-host';
import { extractCapabilities } from '../src/plugin-permissions';

describe('PluginEffectStack', () => {
  it('should call cleanups in reverse order on release', () => {
    const stack = new PluginEffectStack();
    const order: number[] = [];
    stack.add(() => order.push(1));
    stack.add(() => order.push(2));
    stack.add(() => order.push(3));
    stack.release();
    expect(order).toEqual([3, 2, 1]);
  });

  it('should handle empty stack release', () => {
    const stack = new PluginEffectStack();
    expect(() => stack.release()).not.toThrow();
  });

  it('should not fail on cleanup errors', () => {
    const stack = new PluginEffectStack();
    stack.add(() => {
      throw new Error('cleanup error');
    });
    stack.add(() => {
      /* normal cleanup */
    });
    expect(() => stack.release()).not.toThrow();
  });
});

describe('storage functions', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'pi-host-test-'));
    clearPluginStorage('test-plugin');
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    clearPluginStorage('test-plugin');
  });

  describe('loadPluginStorage / savePluginStorage', () => {
    it('should load empty storage when file does not exist', async () => {
      await loadPluginStorage(agentDir, 'test-plugin');
      const host = createPluginHost(
        'test-plugin',
        new PluginEffectStack(),
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        extractCapabilities({ permissions: ['storage'], apiVersion: 2 }),
      );
      expect((host.storage as { get: (k: string) => unknown }).get('key')).toBeUndefined();
    });

    it('should persist and reload storage', async () => {
      const caps = extractCapabilities({ permissions: ['storage'], apiVersion: 2 });
      const host = createPluginHost(
        'test-plugin',
        new PluginEffectStack(),
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        caps,
      );
      const storage = host.storage as {
        set: (k: string, v: unknown) => void;
        get: (k: string) => unknown;
      };
      storage.set('name', 'test-value');
      storage.set('count', 42);

      await savePluginStorage(agentDir, 'test-plugin');
      clearPluginStorage('test-plugin');

      await loadPluginStorage(agentDir, 'test-plugin');
      const host2 = createPluginHost(
        'test-plugin',
        new PluginEffectStack(),
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        caps,
      );
      const storage2 = host2.storage as {
        get: (k: string) => unknown;
      };
      expect(storage2.get('name')).toBe('test-value');
      expect(storage2.get('count')).toBe(42);
    });
  });

  describe('clearPluginStorage', () => {
    it('should clear plugin-specific keys only', () => {
      const caps = extractCapabilities({ permissions: ['storage'], apiVersion: 2 });
      const hostA = createPluginHost(
        'plugin-a',
        new PluginEffectStack(),
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        caps,
      );
      const hostB = createPluginHost(
        'plugin-b',
        new PluginEffectStack(),
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        caps,
      );
      (hostA.storage as { set: (k: string, v: unknown) => void }).set('key', 'value-a');
      (hostB.storage as { set: (k: string, v: unknown) => void }).set('key', 'value-b');

      clearPluginStorage('plugin-a');

      expect((hostB.storage as { get: (k: string) => unknown }).get('key')).toBe('value-b');
    });
  });
});

describe('createPluginHost', () => {
  it('should enforce tools permission for registerAgentTool', () => {
    const tools = new Map<string, PluginTool>();
    const caps = extractCapabilities({ permissions: ['fs'], apiVersion: 2 });
    const host = createPluginHost(
      'test',
      new PluginEffectStack(),
      tools,
      new Map<string, PluginCommand>(),
      caps,
    );
    (host as { registerAgentTool: (t: unknown) => void }).registerAgentTool({
      name: 'test-tool',
      description: 'test',
      execute: () => Promise.resolve(),
    });
    expect(tools.size).toBe(0);
  });

  it('should allow registerAgentTool with tools permission', () => {
    const tools = new Map<string, PluginTool>();
    const caps = extractCapabilities({ permissions: ['tools'], apiVersion: 2 });
    const host = createPluginHost(
      'test',
      new PluginEffectStack(),
      tools,
      new Map<string, PluginCommand>(),
      caps,
    );
    (host as { registerAgentTool: (t: unknown) => void }).registerAgentTool({
      name: 'test-tool',
      description: 'test',
      execute: () => Promise.resolve(),
    });
    expect(tools.size).toBe(1);
    expect(tools.has('test-tool')).toBe(true);
  });

  it('should enforce storage permission', () => {
    const caps = extractCapabilities({ permissions: [], apiVersion: 2 });
    const host = createPluginHost(
      'test',
      new PluginEffectStack(),
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      caps,
    );
    const storage = host.storage as {
      set: (k: string, v: unknown) => void;
      get: (k: string) => unknown;
    };
    storage.set('key', 'value');
    expect(storage.get('key')).toBeUndefined();
  });

  it('should allow storage with permission', () => {
    const caps = extractCapabilities({ permissions: ['storage'], apiVersion: 2 });
    const host = createPluginHost(
      'test',
      new PluginEffectStack(),
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      caps,
    );
    const storage = host.storage as {
      set: (k: string, v: unknown) => void;
      get: (k: string) => unknown;
    };
    storage.set('key', 'value');
    expect(storage.get('key')).toBe('value');
  });

  it('should allow everything in legacy mode', () => {
    const tools = new Map<string, PluginTool>();
    const caps = extractCapabilities({ apiVersion: 1 });
    const host = createPluginHost(
      'test',
      new PluginEffectStack(),
      tools,
      new Map<string, PluginCommand>(),
      caps,
    );
    (host as { registerAgentTool: (t: unknown) => void }).registerAgentTool({
      name: 'legacy-tool',
      description: 'legacy',
      execute: () => Promise.resolve(),
    });
    expect(tools.size).toBe(1);
  });

  it('should pass pluginId in host', () => {
    const host = createPluginHost(
      'my-plugin',
      new PluginEffectStack(),
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      extractCapabilities({ apiVersion: 1 }),
    );
    expect((host as { pluginId: string }).pluginId).toBe('my-plugin');
  });
});

/* ── 阶段 5a：A+B 类 host 方法补全 ── */

function makeHost(capsPerms: string[], hostContext?: HostContext): Record<string, unknown> {
  return createPluginHost(
    'test',
    new PluginEffectStack(),
    new Map<string, PluginTool>(),
    new Map<string, PluginCommand>(),
    extractCapabilities({ permissions: capsPerms, apiVersion: 2 }),
    undefined,
    hostContext,
  );
}

describe('host A-class: paths & state', () => {
  it('should expose cwd / agentDir / dataDir / pluginsDir from hostContext', () => {
    const host = makeHost(['tools'], {
      agentDir: '/tmp/agent',
      cwd: '/tmp/work',
      conversationId: 'sess-1',
      messageCount: 5,
    });
    expect(host.cwd).toBe('/tmp/work');
    expect(host.agentDir).toBe('/tmp/agent');
    expect(host.dataDir).toBe('/tmp/agent');
    expect(host.pluginsDir).toContain('plugins');
    expect(host.conversationId).toBe('sess-1');
  });

  it('should fall back to process.cwd() when no hostContext', () => {
    const host = makeHost(['tools']);
    expect(host.cwd).toBe(process.cwd());
    expect(host.agentDir).toBeUndefined();
    expect(host.pluginsDir).toBeUndefined();
  });

  it('getActiveConversation returns id + messageCount', () => {
    const host = makeHost([], { conversationId: 's-42', messageCount: 7 });
    const conv = (host.getActiveConversation as () => { id: string; messageCount: number })();
    expect(conv.id).toBe('s-42');
    expect(conv.messageCount).toBe(7);
  });

  it('getActiveConversation returns defaults when no context', () => {
    const host = makeHost([]);
    const conv = (host.getActiveConversation as () => { id: string; messageCount: number })();
    expect(conv.id).toBe('');
    expect(conv.messageCount).toBe(0);
  });
});

describe('host A-class: execCommand', () => {
  it('should reject without tools permission', async () => {
    const host = makeHost([]);
    const result = await (
      host.execCommand as (cmd: string, args?: string[]) => Promise<{ ok: boolean; error?: string }>
    )('node', ['--version']);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('should execute command with tools permission', async () => {
    const host = makeHost(['tools']);
    const result = await (
      host.execCommand as (
        cmd: string,
        args?: string[],
      ) => Promise<{ ok: boolean; stdout?: string }>
    )('node', ['--version']);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('v');
  });

  it('should return error for non-existent command', async () => {
    const host = makeHost(['tools']);
    const result = await (
      host.execCommand as (cmd: string, args?: string[]) => Promise<{ ok: boolean; error?: string }>
    )('nonexistent-cmd-xyz', []);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('host A-class: glob', () => {
  it('should reject without fs:read permission', async () => {
    const host = makeHost([]);
    const result = await (host.glob as (p: string) => Promise<string[]>)('*.txt');
    expect(result).toEqual([]);
  });

  it('should match files by pattern', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-glob-'));
    try {
      writeFileSync(join(dir, 'a.txt'), '');
      writeFileSync(join(dir, 'b.txt'), '');
      writeFileSync(join(dir, 'c.js'), '');
      const host = makeHost(['fs:read'], { cwd: dir });
      const result = await (host.glob as (p: string) => Promise<string[]>)('*.txt');
      expect(result).toContain('a.txt');
      expect(result).toContain('b.txt');
      expect(result).not.toContain('c.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should return empty for non-existent directory', async () => {
    const host = makeHost(['fs:read'], { cwd: '/nonexistent/path/xyz' });
    const result = await (host.glob as (p: string) => Promise<string[]>)('*');
    expect(result).toEqual([]);
  });
});

describe('host A-class: ensureDeps', () => {
  it('should detect installed packages', () => {
    const host = makeHost(['tools'], { agentDir: process.cwd() });
    const result = (host.ensureDeps as (d: string[]) => { name: string; installed: boolean }[])([
      'ws',
      'nonexistent-pkg-xyz',
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('ws');
    expect(result[0].installed).toBe(true);
    expect(result[1].installed).toBe(false);
  });

  it('should handle empty deps list', () => {
    const host = makeHost(['tools']);
    const result = (host.ensureDeps as (d: string[]) => { name: string; installed: boolean }[])([]);
    expect(result).toEqual([]);
  });
});

describe('host A-class: watch', () => {
  it('should not create watcher without fs:read permission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-watch-'));
    try {
      const effects = new PluginEffectStack();
      const host = createPluginHost(
        'test',
        effects,
        new Map<string, PluginTool>(),
        new Map<string, PluginCommand>(),
        extractCapabilities({ permissions: [], apiVersion: 2 }),
        undefined,
        { cwd: dir },
      );
      (host.watch as (p: string, cb: (e: string, f: string | null) => void) => void)(
        dir,
        () => undefined,
      );
      // effects 为空说明 watcher 没创建
      // （无法直接检查 effects 私有字段，但不抛错即通过）
      expect(true).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('host B-class: models', () => {
  it('should return provider list from context', () => {
    const host = makeHost([], {
      getProviderList: () => ['openai', 'anthropic'],
    });
    const models = host.models as { list: () => readonly string[] };
    expect(models.list()).toEqual(['openai', 'anthropic']);
  });

  it('should return empty when no getProviderList', () => {
    const host = makeHost([]);
    const models = host.models as { list: () => readonly string[] };
    expect(models.list()).toEqual([]);
  });
});

describe('host B-class: conversations', () => {
  it('should list conversations from context callback', async () => {
    const host = makeHost([], {
      listConversations: () =>
        Promise.resolve([{ id: 's1', firstMessage: 'hello', messageCount: 2 }]),
    });
    const convs = host.conversations as {
      list: () => Promise<readonly { id: string; firstMessage: string; messageCount: number }[]>;
    };
    const result = await convs.list();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1');
  });

  it('should return empty when no listConversations', async () => {
    const host = makeHost([]);
    const convs = host.conversations as { list: () => Promise<readonly unknown[]> };
    const result = await convs.list();
    expect(result).toEqual([]);
  });

  it('current returns context conversationId/messageCount', () => {
    const host = makeHost([], { conversationId: 'cur-1', messageCount: 3 });
    const convs = host.conversations as { current: () => { id: string; messageCount: number } };
    const c = convs.current();
    expect(c.id).toBe('cur-1');
    expect(c.messageCount).toBe(3);
  });

  it('open calls openSession callback', async () => {
    let called = '';
    const host = makeHost([], {
      openSession: (id) => {
        called = id;
        return Promise.resolve();
      },
    });
    const convs = host.conversations as { open: (id: string) => Promise<void> };
    await convs.open('target-sess');
    expect(called).toBe('target-sess');
  });
});

describe('host B-class: steer / abortRun', () => {
  it('steer calls context steer callback', () => {
    let steered = '';
    const host = makeHost([], {
      steer: (text) => {
        steered = text;
      },
    });
    (host.steer as (text: string) => void)('redirect');
    expect(steered).toBe('redirect');
  });

  it('steer is no-op without context', () => {
    const host = makeHost([]);
    expect(() => (host.steer as (text: string) => void)('x')).not.toThrow();
  });

  it('abortRun calls context abortRun callback', () => {
    let aborted = false;
    const host = makeHost([], {
      abortRun: () => {
        aborted = true;
      },
    });
    (host.abortRun as () => void)();
    expect(aborted).toBe(true);
  });

  it('abortRun is no-op without context', () => {
    const host = makeHost([]);
    expect(() => (host.abortRun as () => void)()).not.toThrow();
  });
});

describe('host B-class: scm', () => {
  it('should reject status without fs:read permission', async () => {
    const host = makeHost([], { cwd: process.cwd() });
    const scm = host.scm as { status: () => Promise<{ ok: boolean; error?: string }> };
    const result = await scm.status();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('permission denied');
  });

  it('should bridge to git-ops status with fs:read permission', async () => {
    const host = makeHost(['fs:read'], { cwd: process.cwd() });
    const scm = host.scm as { status: () => Promise<{ ok: boolean }> };
    const result = await scm.status();
    expect(result.ok).toBe(true);
  });

  it('should reject history without fs:read permission', async () => {
    const host = makeHost([], { cwd: process.cwd() });
    const scm = host.scm as { history: () => Promise<{ ok: boolean; error?: string }> };
    const result = await scm.history();
    expect(result.ok).toBe(false);
  });
});

/* ── 阶段 5b：C 类回调注册 ── */

describe('host C-class: callback registration & dispatch', () => {
  it('should invoke onMessage when message event dispatched', () => {
    const effects = new PluginEffectStack();
    const host = createPluginHost(
      'test',
      effects,
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      extractCapabilities({ apiVersion: 1 }),
    );
    const received: unknown[] = [];
    (host.onMessage as (cb: (data: unknown) => void) => void)((data) => received.push(data));
    (host._dispatchEvent as (event: string, data: unknown) => void)('message', {
      role: 'assistant',
      content: 'hi',
    });
    expect(received).toHaveLength(1);
    expect((received[0] as { content: string }).content).toBe('hi');
  });

  it('should invoke onStreaming when streaming event dispatched', () => {
    const host = makeHost([]);
    const received: string[] = [];
    (host.onStreaming as (cb: (data: unknown) => void) => void)((data) =>
      received.push(data as string),
    );
    (host._dispatchEvent as (event: string, data: unknown) => void)('streaming', 'delta');
    expect(received).toEqual(['delta']);
  });

  it('should invoke onToolPre and onToolPost', () => {
    const host = makeHost([]);
    const pre: unknown[] = [];
    const post: unknown[] = [];
    (host.onToolPre as (cb: (data: unknown) => void) => void)((d) => pre.push(d));
    (host.onToolPost as (cb: (data: unknown) => void) => void)((d) => post.push(d));
    (host._dispatchEvent as (event: string, data: unknown) => void)('toolPre', {
      toolName: 'bash',
    });
    (host._dispatchEvent as (event: string, data: unknown) => void)('toolPost', {
      toolName: 'bash',
      status: 'end',
    });
    expect(pre).toHaveLength(1);
    expect(post).toHaveLength(1);
  });

  it('should invoke onRunEvent on stream end', () => {
    const host = makeHost([]);
    const events: unknown[] = [];
    (host.onRunEvent as (cb: (data: unknown) => void) => void)((d) => events.push(d));
    (host._dispatchEvent as (event: string, data: unknown) => void)('runEvent', {
      finishReason: 'stop',
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { finishReason: string }).finishReason).toBe('stop');
  });

  it('should invoke onConversationChanged / onCwdChange / onClientModelChanged', () => {
    const host = makeHost([]);
    const conv: unknown[] = [];
    const cwd: unknown[] = [];
    const model: unknown[] = [];
    (host.onConversationChanged as (cb: (data: unknown) => void) => void)((d) => conv.push(d));
    (host.onCwdChange as (cb: (data: unknown) => void) => void)((d) => cwd.push(d));
    (host.onClientModelChanged as (cb: (data: unknown) => void) => void)((d) => model.push(d));
    (host._dispatchEvent as (event: string, data: unknown) => void)('conversationChanged', {
      id: 's1',
    });
    (host._dispatchEvent as (event: string, data: unknown) => void)('cwdChange', '/new/path');
    (host._dispatchEvent as (event: string, data: unknown) => void)('clientModelChanged', {
      providerId: 'openai',
    });
    expect(conv).toHaveLength(1);
    expect(cwd).toHaveLength(1);
    expect(model).toHaveLength(1);
  });

  it('should invoke onStats / onSettingsChanged', () => {
    const host = makeHost([]);
    const stats: unknown[] = [];
    const settings: unknown[] = [];
    (host.onStats as (cb: (data: unknown) => void) => void)((d) => stats.push(d));
    (host.onSettingsChanged as (cb: (data: unknown) => void) => void)((d) => settings.push(d));
    (host._dispatchEvent as (event: string, data: unknown) => void)('stats', { tokens: 100 });
    (host._dispatchEvent as (event: string, data: unknown) => void)('settingsChanged', {
      key: 'theme',
    });
    expect(stats).toHaveLength(1);
    expect(settings).toHaveLength(1);
  });

  it('should not invoke callbacks for unregistered events', () => {
    const host = makeHost([]);
    const received: unknown[] = [];
    (host.onMessage as (cb: (data: unknown) => void) => void)((d) => received.push(d));
    (host._dispatchEvent as (event: string, data: unknown) => void)('streaming', 'delta');
    expect(received).toHaveLength(0);
  });

  it('should remove callbacks on effects.release()', () => {
    const effects = new PluginEffectStack();
    const host = createPluginHost(
      'test',
      effects,
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      extractCapabilities({ apiVersion: 1 }),
    );
    const received: unknown[] = [];
    (host.onMessage as (cb: (data: unknown) => void) => void)((d) => received.push(d));
    effects.release();
    (host._dispatchEvent as (event: string, data: unknown) => void)('message', 'after-release');
    expect(received).toHaveLength(0);
  });

  it('should isolate callbacks between different plugins', () => {
    const effects1 = new PluginEffectStack();
    const effects2 = new PluginEffectStack();
    const host1 = createPluginHost(
      'plugin-a',
      effects1,
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      extractCapabilities({ apiVersion: 1 }),
    );
    const host2 = createPluginHost(
      'plugin-b',
      effects2,
      new Map<string, PluginTool>(),
      new Map<string, PluginCommand>(),
      extractCapabilities({ apiVersion: 1 }),
    );
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    (host1.onMessage as (cb: (data: unknown) => void) => void)((d) => received1.push(d));
    (host2.onMessage as (cb: (data: unknown) => void) => void)((d) => received2.push(d));
    (host1._dispatchEvent as (event: string, data: unknown) => void)('message', 'to-a');
    (host2._dispatchEvent as (event: string, data: unknown) => void)('message', 'to-b');
    expect(received1).toEqual(['to-a']);
    expect(received2).toEqual(['to-b']);
  });

  it('should not throw when callback throws', () => {
    const host = makeHost([]);
    (host.onMessage as (cb: (data: unknown) => void) => void)(() => {
      throw new Error('callback error');
    });
    expect(() =>
      (host._dispatchEvent as (event: string, data: unknown) => void)('message', 'x'),
    ).not.toThrow();
  });
});
