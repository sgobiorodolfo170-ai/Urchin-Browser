/**
 * Import IPC Handler 娉ㄥ唽鍗曞厓娴嬭瘯
 *
 * 楠岃瘉 import.detectBrowsers / bookmarksFromFile / bookmarksFromBrowser 涓変釜閫氶亾锛? * - 鍏ㄩ儴 I/O 缁忎緷璧栨敞鍏?mock锛岄獙璇佽皟搴︿笌缁撴灉缁撴瀯
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

import { registerImportHandlers } from '../../src/main/import/register-handlers';
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

describe('registerImportHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('import.detectBrowsers should return injected browser list', async () => {
    const ipcMain = createMockIpcMain();
    const browsers = [
      {
        id: 'chrome:C:\\Chrome',
        kind: 'chrome' as const,
        displayName: 'Google Chrome',
        profileName: 'Default',
        profileDir: 'C:\\Chrome',
        bookmarksSource: 'chromium-json' as const,
      },
    ];
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create: vi.fn() } as never,
      detectBrowsers: () => browsers,
    });

    const result = (await ipcMain.invoke('import.detectBrowsers', {})) as {
      browsers: typeof browsers;
    };

    expect(result.browsers).toEqual(browsers);
  });

  it('import.bookmarksFromFile should parse + import and return summary', async () => {
    const ipcMain = createMockIpcMain();
    const create = vi.fn().mockImplementation((opts: { title: string }) => ({
      id: `id-${opts.title}`,
      title: opts.title,
    }));
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create } as never,
      showOpenDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: ['C:\\bookmarks.html'],
      }),
      getWindowFromSender: () => undefined,
      readFileText: vi
        .fn()
        .mockResolvedValue('<DL><p><DT><A HREF="https://a.example/">A</A></DL><p>'),
      parseBookmarksHtml: vi.fn().mockReturnValue({
        title: 'root',
        children: [{ title: 'A', url: 'https://a.example/' }],
      }),
    });

    const result = (await ipcMain.invoke('import.bookmarksFromFile', {})) as {
      canceled: boolean;
      summary: { folders: number; bookmarks: number; skipped: number; rootFolderId: string };
    };

    expect(result.canceled).toBe(false);
    // 鏍规枃浠跺す + 1 涔︾
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.summary.bookmarks).toBe(1);
    expect(result.summary.folders).toBe(1);
    expect(result.summary.rootFolderId).toMatch(/^id-/);
  });

  it('import.bookmarksFromFile should return canceled when dialog canceled', async () => {
    const ipcMain = createMockIpcMain();
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create: vi.fn() } as never,
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
      getWindowFromSender: () => undefined,
    });

    const result = (await ipcMain.invoke('import.bookmarksFromFile', {})) as {
      canceled: boolean;
      summary: unknown;
    };

    expect(result.canceled).toBe(true);
    expect(result.summary).toBeNull();
  });

  it('import.bookmarksFromBrowser should dispatch to chromium parser for chromium-json source', async () => {
    const ipcMain = createMockIpcMain();
    const create = vi
      .fn()
      .mockImplementation((opts: { title: string }) => ({ id: `id-${opts.title}` }));
    const parseChromium = vi.fn().mockReturnValue({
      title: 'root',
      children: [{ title: 'X', url: 'https://x.example/' }],
    });
    const parseFirefox = vi.fn();
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create } as never,
      detectBrowsers: () => [
        {
          id: 'chrome:C:\\P',
          kind: 'chrome' as const,
          displayName: 'Google Chrome',
          profileName: 'Default',
          profileDir: 'C:\\P',
          bookmarksSource: 'chromium-json' as const,
        },
      ],
      parseChromiumBookmarks: parseChromium,
      parseFirefoxPlaces: parseFirefox,
    });

    const result = (await ipcMain.invoke('import.bookmarksFromBrowser', {
      id: 'chrome:C:\\P',
    })) as {
      canceled: boolean;
      summary: { rootFolderTitle: string; bookmarks: number };
    };

    expect(parseChromium).toHaveBeenCalledWith('C:\\P');
    expect(parseFirefox).not.toHaveBeenCalled();
    expect(result.canceled).toBe(false);
    expect(result.summary.bookmarks).toBe(1);
    expect(result.summary.rootFolderTitle).toContain('Google Chrome');
  });

  it('import.bookmarksFromBrowser should throw when id not found', async () => {
    const ipcMain = createMockIpcMain();
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create: vi.fn() } as never,
      detectBrowsers: () => [],
    });

    await expect(
      ipcMain.invoke('import.bookmarksFromBrowser', { id: 'missing' }),
    ).rejects.toThrow();
  });
});
