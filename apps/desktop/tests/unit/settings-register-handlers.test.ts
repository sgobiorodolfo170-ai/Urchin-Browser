/**
 * Settings IPC Handler 注册单元测试
 *
 * 验证 settings.get / set / getAll 三个通道：
 * - get：键存在返回 value，不存在返回 null
 * - set：转发 key/value
 * - getAll：返回 entries
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@urchin/ipc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@urchin/ipc-contract')>();
  return {
    ...actual,
    registerHandler: (
      ipcMain: { handle: (channel: string, fn: unknown) => void },
      channel: string,
      fn: (req: unknown, ctx: unknown) => unknown,
    ) => {
      ipcMain.handle(channel, (event: unknown, rawReq: unknown) => fn(rawReq, { event }));
    },
  };
});

import { registerSettingsHandlers } from '../../src/main/settings/register-handlers';
import type { IpcMainInvokeEvent } from 'electron';

function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null } as never, req);
    },
  };
}

function createMockSettingsManager() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    getAll: vi.fn(),
  };
}

describe('registerSettingsHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settings.get should return value when key exists', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockSettingsManager();
    manager.get.mockReturnValue('dark');

    registerSettingsHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('settings.get', { key: 'theme' })) as {
      value: unknown;
    };

    expect(manager.get).toHaveBeenCalledWith('theme');
    expect(result.value).toBe('dark');
  });

  it('settings.get should return null when key missing', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockSettingsManager();
    manager.get.mockReturnValue(undefined);

    registerSettingsHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('settings.get', { key: 'missing' })) as {
      value: unknown;
    };

    expect(result.value).toBeNull();
  });

  it('settings.set should forward key/value and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockSettingsManager();

    registerSettingsHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('settings.set', { key: 'theme', value: 'light' })) as {
      ok: boolean;
    };

    expect(manager.set).toHaveBeenCalledWith('theme', 'light');
    expect(result.ok).toBe(true);
  });

  it('settings.getAll should return entries', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockSettingsManager();
    manager.getAll.mockReturnValue([{ key: 'theme', value: 'light' }]);

    registerSettingsHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('settings.getAll', {})) as { entries: unknown[] };

    expect(manager.getAll).toHaveBeenCalled();
    expect(result.entries).toHaveLength(1);
  });
});
