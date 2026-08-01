/**
 * Host API 适配层（createHostFromUrchin）单元测试
 *
 * 验证 BrowserHostApi 各命名空间方法正确桥接 window.urchin IPC：
 * 1. page.extract / page.getActive
 * 2. tabs.create / close / setActive / list / loadUrl / onEvent
 * 3. settings.get / set / getAll / onChanged（DOM CustomEvent）
 * 4. storage 命名空间抛 NotSupported
 * 5. ai.listProviders / rescanProviders / startChat / abortChat / onStreamPort / onProviderEvent
 * 6. lifecycle.ready / onEvent（tab:event 推导）
 * 7. input.screenshot / uploadFile / setWorkdir
 * 8. platform 信息
 * 9. window.urchin 缺失时抛错
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHostFromUrchin } from '../../src/renderer/host-impl';
import type { MessagePortLike } from '@urchin/browser-host';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockOnMessagePort = vi.fn();

function installUrchin(
  overrides: Partial<{
    platform: string;
    versions: { electron: string; chrome: string; node: string };
  }> = {},
): void {
  Object.defineProperty(window, 'urchin', {
    value: {
      invoke: mockInvoke,
      on: mockOn,
      onMessagePort: mockOnMessagePort,
      platform: overrides.platform ?? 'win32',
      versions: overrides.versions ?? { electron: '32.0.0', chrome: '128.0.0', node: '22.0.0' },
    },
    writable: true,
    configurable: true,
  });
}

function makeTab(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    windowId: 1,
    url: 'https://urchin.dev',
    title: 'Urchin',
    favicon: undefined,
    active: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    indexInWindow: 0,
    ...overrides,
  };
}

/** 触发一个 DOM CustomEvent */
function dispatchCustomEvent(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockOn.mockReset();
  mockOnMessagePort.mockReset();
  installUrchin();
});

describe('createHostFromUrchin', () => {
  describe('page', () => {
    it('extract should bridge page.extract and return context', async () => {
      mockInvoke.mockResolvedValue({ context: { url: 'https://urchin.dev', title: 'Urchin' } });
      const host = createHostFromUrchin();

      const context = await host.page.extract(7, 10_000);

      expect(mockInvoke).toHaveBeenCalledWith('page.extract', { tabId: 7 });
      expect(context).toEqual({ url: 'https://urchin.dev', title: 'Urchin' });
    });

    it('getActive should return active tab projection', async () => {
      mockInvoke.mockResolvedValue({
        tabs: [makeTab({ id: 1, active: false }), makeTab({ id: 2 })],
      });
      const host = createHostFromUrchin();

      const active = await host.page.getActive();

      expect(active).toEqual({ id: 2, url: 'https://urchin.dev', title: 'Urchin', loading: false });
    });

    it('getActive should return null when no active tab', async () => {
      mockInvoke.mockResolvedValue({ tabs: [makeTab({ active: false })] });
      const host = createHostFromUrchin();

      expect(await host.page.getActive()).toBeNull();
    });
  });

  describe('tabs', () => {
    it('create should bridge tab.create with active default true', async () => {
      mockInvoke.mockResolvedValue({ tab: makeTab() });
      const host = createHostFromUrchin();

      const tab = await host.tabs.create('https://example.com');

      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'https://example.com',
        active: true,
      });
      expect(tab.id).toBe(1);
    });

    it('create should pass active false when provided', async () => {
      mockInvoke.mockResolvedValue({ tab: makeTab() });
      const host = createHostFromUrchin();

      await host.tabs.create('https://example.com', false);

      expect(mockInvoke).toHaveBeenCalledWith('tab.create', {
        windowId: 1,
        url: 'https://example.com',
        active: false,
      });
    });

    it('close should bridge tab.close', async () => {
      const host = createHostFromUrchin();

      const res = await host.tabs.close(3);

      expect(mockInvoke).toHaveBeenCalledWith('tab.close', { tabId: 3 });
      expect(res).toEqual({ ok: true });
    });

    it('setActive should bridge tab.setActive', async () => {
      mockInvoke.mockResolvedValue({ tab: makeTab() });
      const host = createHostFromUrchin();

      await host.tabs.setActive(5);

      expect(mockInvoke).toHaveBeenCalledWith('tab.setActive', { tabId: 5 });
    });

    it('list should bridge tab.list and return tabs', async () => {
      mockInvoke.mockResolvedValue({ tabs: [makeTab(), makeTab({ id: 2, active: false })] });
      const host = createHostFromUrchin();

      const tabs = await host.tabs.list();

      expect(mockInvoke).toHaveBeenCalledWith('tab.list', { windowId: 1 });
      expect(tabs).toHaveLength(2);
    });

    it('loadUrl should bridge tab.loadUrl', async () => {
      const host = createHostFromUrchin();

      const res = await host.tabs.loadUrl(9, 'https://target.dev');

      expect(mockInvoke).toHaveBeenCalledWith('tab.loadUrl', {
        tabId: 9,
        url: 'https://target.dev',
      });
      expect(res).toEqual({ ok: true });
    });

    it('onEvent should subscribe to tab:event and unwrap payload', () => {
      const unsubscribe = vi.fn();
      mockOn.mockReturnValue(unsubscribe);
      const handler = vi.fn();
      const host = createHostFromUrchin();

      const result = host.tabs.onEvent(handler);
      const tabEventCb = mockOn.mock.calls.find((c) => (c[0] as string) === 'tab:event')?.[1] as (
        payload: unknown,
      ) => void;
      tabEventCb({ type: 'activated', snapshot: makeTab() });

      expect(mockOn).toHaveBeenCalledWith('tab:event', expect.any(Function));
      expect(handler).toHaveBeenCalledWith({
        type: 'activated',
        snapshot: expect.any(Object) as Record<string, unknown>,
      });
      expect(result).toBe(unsubscribe);
    });
  });

  describe('settings', () => {
    it('get should bridge settings.get and return value', async () => {
      mockInvoke.mockResolvedValue({ value: 'dark' });
      const host = createHostFromUrchin();

      const value = await host.settings.get<string>('theme');

      expect(mockInvoke).toHaveBeenCalledWith('settings.get', { key: 'theme' });
      expect(value).toBe('dark');
    });

    it('get should return null when unset', async () => {
      mockInvoke.mockResolvedValue({ value: null });
      const host = createHostFromUrchin();

      expect(await host.settings.get('missing')).toBeNull();
    });

    it('set should bridge settings.set', async () => {
      const host = createHostFromUrchin();

      const res = await host.settings.set('theme', 'light');

      expect(mockInvoke).toHaveBeenCalledWith('settings.set', { key: 'theme', value: 'light' });
      expect(res).toEqual({ ok: true });
    });

    it('getAll should bridge settings.getAll', async () => {
      mockInvoke.mockResolvedValue({ settings: [{ key: 'theme', value: 'dark' }] });
      const host = createHostFromUrchin();

      const all = await host.settings.getAll();

      expect(mockInvoke).toHaveBeenCalledWith('settings.getAll', {});
      expect(all).toEqual([{ key: 'theme', value: 'dark' }]);
    });

    it('onChanged should fire handler for single key change', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      const unsubscribe = host.settings.onChanged(handler);
      dispatchCustomEvent('urchin:settings-changed', { key: 'theme', value: 'dark' });

      expect(handler).toHaveBeenCalledWith('theme', 'dark');

      unsubscribe();
      dispatchCustomEvent('urchin:settings-changed', { key: 'theme', value: 'dark' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('onChanged should fire handler per key for batch change', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      host.settings.onChanged(handler);
      dispatchCustomEvent('urchin:settings-changed', { keys: ['a', 'b'] });

      expect(handler).toHaveBeenCalledWith('a', undefined);
      expect(handler).toHaveBeenCalledWith('b', undefined);
    });

    it('onChanged should ignore events without key or keys', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      host.settings.onChanged(handler);
      dispatchCustomEvent('urchin:settings-changed', {});
      dispatchCustomEvent('urchin:settings-changed', null);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('storage', () => {
    it('should throw NotSupported for all storage methods', () => {
      const host = createHostFromUrchin();

      expect(() => host.storage.get('k')).toThrow(/not supported/i);
      expect(() => host.storage.set('k', 'v')).toThrow(/not supported/i);
      expect(() => host.storage.delete('k')).toThrow(/not supported/i);
      expect(() => host.storage.keys()).toThrow(/not supported/i);
    });
  });

  describe('ai', () => {
    it('listProviders should bridge provider.list', async () => {
      mockInvoke.mockResolvedValue({ providers: [{ id: 'openai' }] });
      const host = createHostFromUrchin();

      const providers = await host.ai.listProviders();

      expect(mockInvoke).toHaveBeenCalledWith('provider.list', {});
      expect(providers).toEqual([{ id: 'openai' }]);
    });

    it('rescanProviders should bridge provider.rescan', async () => {
      mockInvoke.mockResolvedValue({ providers: [{ id: 'anthropic' }] });
      const host = createHostFromUrchin();

      const providers = await host.ai.rescanProviders();

      expect(mockInvoke).toHaveBeenCalledWith('provider.rescan', {});
      expect(providers).toEqual([{ id: 'anthropic' }]);
    });

    it('startChat should bridge ai.agent.start with stream flag', async () => {
      mockInvoke.mockResolvedValue({ conversationId: 'conv-1' });
      const host = createHostFromUrchin();

      const result = await host.ai.startChat({
        providerId: 'openai',
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o',
      });

      expect(mockInvoke).toHaveBeenCalledWith('ai.agent.start', {
        providerId: 'openai',
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'hi' }],
        model: 'gpt-4o',
        temperature: undefined,
        maxTokens: undefined,
        stream: true,
      });
      expect(result).toEqual({ conversationId: 'conv-1' });
    });

    it('abortChat should bridge ai.agent.abort', async () => {
      const host = createHostFromUrchin();

      const res = await host.ai.abortChat('conv-1');

      expect(mockInvoke).toHaveBeenCalledWith('ai.agent.abort', { conversationId: 'conv-1' });
      expect(res).toEqual({ ok: true });
    });

    it('onStreamPort should bridge ai.chat.port and adapt port', () => {
      const unsubscribe = vi.fn();
      mockOnMessagePort.mockReturnValue(unsubscribe);
      const handler = vi.fn();
      const portHandlers: ((data: unknown) => void)[] = [];
      const port = {
        onMessage: (h: (data: unknown) => void) => {
          portHandlers.push(h);
        },
        start: vi.fn(),
        close: vi.fn(),
      };
      const host = createHostFromUrchin();

      const result = host.ai.onStreamPort(handler);
      const portCb = mockOnMessagePort.mock.calls.find(
        (c) => (c[0] as string) === 'ai.chat.port',
      )?.[1] as (payload: unknown, port: unknown) => void;
      portCb({ conversationId: 'conv-9' }, port);

      expect(handler).toHaveBeenCalledTimes(1);
      const [conversationId, adapter] = handler.mock.calls[0] as [string, MessagePortLike];
      expect(conversationId).toBe('conv-9');
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.close).toBe('function');

      adapter.onmessage = ({ data }) => expect(data).toEqual({ type: 'delta', text: 'hi' });
      expect(adapter.onmessage).not.toBeNull();
      portHandlers[0]!({ type: 'delta', text: 'hi' });

      adapter.start();
      expect(port.start).toHaveBeenCalled();
      adapter.close?.();
      expect(port.close).toHaveBeenCalled();

      expect(result).toBe(unsubscribe);
    });

    it('onProviderEvent should bridge provider:event', () => {
      const unsubscribe = vi.fn();
      mockOn.mockReturnValue(unsubscribe);
      const handler = vi.fn();
      const host = createHostFromUrchin();

      const result = host.ai.onProviderEvent(handler);
      const providerCb = mockOn.mock.calls.find(
        (c) => (c[0] as string) === 'provider:event',
      )?.[1] as (payload: unknown) => void;
      providerCb({ type: 'installed', provider: { id: 'openai' } });

      expect(handler).toHaveBeenCalledWith({
        type: 'installed',
        provider: expect.any(Object) as Record<string, unknown>,
      });
      expect(result).toBe(unsubscribe);
    });
  });

  describe('lifecycle', () => {
    it('ready should resolve ok', async () => {
      const host = createHostFromUrchin();

      expect(await host.lifecycle.ready()).toEqual({ ok: true });
    });

    it('onEvent should emit activate for urchin://ai activated tab', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      host.lifecycle.onEvent(handler);
      const cb = mockOn.mock.calls.find((c) => (c[0] as string) === 'tab:event')?.[1] as (
        payload: unknown,
      ) => void;
      cb({ type: 'activated', snapshot: makeTab({ url: 'urchin://ai' }) });

      expect(handler).toHaveBeenCalledWith('activate');
    });

    it('onEvent should emit mount for updated urchin://ai tab', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      host.lifecycle.onEvent(handler);
      const cb = mockOn.mock.calls.find((c) => (c[0] as string) === 'tab:event')?.[1] as (
        payload: unknown,
      ) => void;
      cb({ type: 'updated', snapshot: makeTab({ url: 'urchin://ai' }) });

      expect(handler).toHaveBeenCalledWith('mount');
    });

    it('onEvent should ignore non-urchin://ai tabs', () => {
      const handler = vi.fn();
      const host = createHostFromUrchin();

      host.lifecycle.onEvent(handler);
      const cb = mockOn.mock.calls.find((c) => (c[0] as string) === 'tab:event')?.[1] as (
        payload: unknown,
      ) => void;
      cb({ type: 'activated', snapshot: makeTab({ url: 'https://web.dev' }) });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('input', () => {
    it('screenshot should bridge ai.screenshot', async () => {
      mockInvoke.mockResolvedValue({
        dataUri: 'data:image/png',
        mimeType: 'image/png',
        base64: 'xx',
      });
      const host = createHostFromUrchin();

      const shot = await host.input.screenshot();

      expect(mockInvoke).toHaveBeenCalledWith('ai.screenshot', {});
      expect(shot.mimeType).toBe('image/png');
    });

    it('uploadFile should bridge ai.uploadFile with defaults', async () => {
      mockInvoke.mockResolvedValue({ files: [{ name: 'a.png' }] });
      const host = createHostFromUrchin();

      const files = await host.input.uploadFile({ multiple: true });

      expect(mockInvoke).toHaveBeenCalledWith('ai.uploadFile', {
        title: undefined,
        filters: [],
        multiple: true,
      });
      expect(files).toEqual([{ name: 'a.png' }]);
    });

    it('setWorkdir should bridge ai.setWorkdir', async () => {
      mockInvoke.mockResolvedValue({ path: 'C:\\wd', exists: true, entryCount: 3 });
      const host = createHostFromUrchin();

      const res = await host.input.setWorkdir({ title: '选择目录' });

      expect(mockInvoke).toHaveBeenCalledWith('ai.setWorkdir', { title: '选择目录' });
      expect(res.entryCount).toBe(3);
    });
  });

  describe('platform', () => {
    it('should expose os and version info', () => {
      const host = createHostFromUrchin();

      expect(host.platform.os).toBe('win32');
      expect(host.platform.electron).toBe('32.0.0');
      expect(host.platform.chrome).toBe('128.0.0');
      expect(host.platform.node).toBe('22.0.0');
    });
  });

  describe('error handling', () => {
    it('should throw when window.urchin is missing', async () => {
      Object.defineProperty(window, 'urchin', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      const host = createHostFromUrchin();

      await expect(host.tabs.list()).rejects.toThrow(/window\.urchin not available/i);
    });
  });
});
