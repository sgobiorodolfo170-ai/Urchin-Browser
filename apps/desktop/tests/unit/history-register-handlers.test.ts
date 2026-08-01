/**
 * History IPC Handler 注册单元测试
 *
 * 验证 history.record / search / list / delete / clear 五个通道：
 * - 转发到 HistoryManager 对应方法
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

import { registerHistoryHandlers } from '../../src/main/history/register-handlers';
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

function createMockHistoryManager() {
  return {
    record: vi.fn(),
    search: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };
}

describe('registerHistoryHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('history.record should forward url/title and return entry', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockHistoryManager();
    const entry = { id: 'h1', url: 'https://urchin.dev', title: 'Urchin', visitedAt: 1 };
    manager.record.mockReturnValue(entry);

    registerHistoryHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('history.record', {
      url: 'https://urchin.dev',
      title: 'Urchin',
    })) as { ok: boolean; entry: typeof entry };

    expect(manager.record).toHaveBeenCalledWith('https://urchin.dev', 'Urchin');
    expect(result).toEqual({ ok: true, entry });
  });

  it('history.search should forward query and limit', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockHistoryManager();
    manager.search.mockReturnValue([{ id: 'h1' }]);

    registerHistoryHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('history.search', { query: 'urch', limit: 10 })) as {
      entries: unknown[];
    };

    expect(manager.search).toHaveBeenCalledWith('urch', 10);
    expect(result.entries).toHaveLength(1);
  });

  it('history.list should forward limit and offset', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockHistoryManager();
    manager.list.mockReturnValue([{ id: 'h1' }]);

    registerHistoryHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('history.list', { limit: 20, offset: 5 })) as unknown[];

    expect(manager.list).toHaveBeenCalledWith(20, 5);
    expect(result).toHaveLength(1);
  });

  it('history.delete should forward id and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockHistoryManager();

    registerHistoryHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('history.delete', { id: 'h1' })) as {
      ok: boolean;
      id: string;
    };

    expect(manager.delete).toHaveBeenCalledWith('h1');
    expect(result).toEqual({ ok: true, id: 'h1' });
  });

  it('history.clear should forward clear and return deleted count', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockHistoryManager();
    manager.clear.mockReturnValue(42);

    registerHistoryHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('history.clear', {})) as {
      ok: boolean;
      deleted: number;
    };

    expect(manager.clear).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, deleted: 42 });
  });
});
