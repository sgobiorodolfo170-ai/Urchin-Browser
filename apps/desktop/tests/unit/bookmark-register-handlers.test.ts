/**
 * Bookmarks IPC Handler 注册单元测试
 *
 * 验证 bookmark.create / list / search / delete 四个通道：
 * - 转发到 BookmarkManager 对应方法
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

import { registerBookmarkHandlers } from '../../src/main/bookmarks/register-handlers';
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

function createMockBookmarkManager() {
  return {
    create: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
  };
}

describe('registerBookmarkHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bookmark.create should forward to manager and return bookmark', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockBookmarkManager();
    const bookmark = { id: 'b1', url: 'https://urchin.dev', title: 'Urchin', type: 'bookmark' };
    manager.create.mockReturnValue(bookmark);

    registerBookmarkHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('bookmark.create', {
      url: 'https://urchin.dev',
      title: 'Urchin',
      parentId: undefined,
      type: 'bookmark',
    })) as { bookmark: typeof bookmark };

    expect(manager.create).toHaveBeenCalledWith({
      url: 'https://urchin.dev',
      title: 'Urchin',
      parentId: undefined,
      type: 'bookmark',
    });
    expect(result.bookmark).toBe(bookmark);
  });

  it('bookmark.list should forward parentId and return bookmarks', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockBookmarkManager();
    manager.list.mockReturnValue([{ id: 'b1' }, { id: 'b2' }]);

    registerBookmarkHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('bookmark.list', { parentId: 'root' })) as {
      bookmarks: unknown[];
    };

    expect(manager.list).toHaveBeenCalledWith('root');
    expect(result.bookmarks).toHaveLength(2);
  });

  it('bookmark.search should forward query and limit', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockBookmarkManager();
    manager.search.mockReturnValue([{ id: 'b1' }]);

    registerBookmarkHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('bookmark.search', { query: 'urch', limit: 5 })) as {
      bookmarks: unknown[];
    };

    expect(manager.search).toHaveBeenCalledWith('urch', 5);
    expect(result.bookmarks).toHaveLength(1);
  });

  it('bookmark.delete should forward id and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockBookmarkManager();

    registerBookmarkHandlers(ipcMain as never, manager as never);

    const result = (await ipcMain.invoke('bookmark.delete', { id: 'b1' })) as {
      ok: boolean;
      id: string;
    };

    expect(manager.delete).toHaveBeenCalledWith('b1');
    expect(result).toEqual({ ok: true, id: 'b1' });
  });
});
