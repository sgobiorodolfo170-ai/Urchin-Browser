/**
 * plugin-host.ts 鍗曞厓娴嬭瘯
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PluginEffectStack,
  clearPluginStorage,
  loadPluginStorage,
  savePluginStorage,
  createPluginHost,
} from '../src/plugin-host';
import type { PluginTool, PluginCommand } from '../src/plugin-host';
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
