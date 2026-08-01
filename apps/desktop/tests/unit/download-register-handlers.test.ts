/**
 * Download IPC Handler 注册单元测试
 *
 * 验证 download.list / cancel / pause / resume / clear 五个通道：
 * - 转发到 DownloadManager 对应方法
 * - 返回结果结构正确
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

import { registerDownloadHandlers } from '../../src/main/downloads/register-handlers';
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

function createMockDownloadManager() {
  return {
    list: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clear: vi.fn(),
  };
}

describe('registerDownloadHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('download.list should forward and return downloads', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockDownloadManager();
    manager.list.mockReturnValue([{ id: 'd1', filename: 'x.pdf' }]);

    registerDownloadHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('download.list', {})) as { downloads: unknown[] };

    expect(manager.list).toHaveBeenCalled();
    expect(result.downloads).toHaveLength(1);
  });

  it('download.cancel should forward id and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockDownloadManager();

    registerDownloadHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('download.cancel', { id: 'd1' })) as {
      ok: boolean;
      id: string;
    };

    expect(manager.cancel).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ ok: true, id: 'd1' });
  });

  it('download.pause should forward id and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockDownloadManager();

    registerDownloadHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('download.pause', { id: 'd1' })) as {
      ok: boolean;
      id: string;
    };

    expect(manager.pause).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ ok: true, id: 'd1' });
  });

  it('download.resume should forward id and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockDownloadManager();

    registerDownloadHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('download.resume', { id: 'd1' })) as {
      ok: boolean;
      id: string;
    };

    expect(manager.resume).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ ok: true, id: 'd1' });
  });

  it('download.clear should forward id and return deleted count', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockDownloadManager();
    manager.clear.mockReturnValue(5);

    registerDownloadHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('download.clear', { id: 'd1' })) as {
      ok: boolean;
      deleted: number;
    };

    expect(manager.clear).toHaveBeenCalledWith('d1');
    expect(result).toEqual({ ok: true, deleted: 5 });
  });
});
