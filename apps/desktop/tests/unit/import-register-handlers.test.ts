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
        cookiesSupport: 'none' as const,
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
      summary: { folders: number; bookmarks: number; skipped: number };
    };

    expect(result.canceled).toBe(false);
    // 顶层书签直接入根（不再创建「导入自」文件夹）
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.summary.bookmarks).toBe(1);
    expect(result.summary.folders).toBe(0);
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
          cookiesSupport: 'full' as const,
        },
      ],
      parseChromiumBookmarks: parseChromium,
      parseFirefoxPlaces: parseFirefox,
    });

    const result = (await ipcMain.invoke('import.bookmarksFromBrowser', {
      id: 'chrome:C:\\P',
    })) as {
      canceled: boolean;
      summary: { folders: number; bookmarks: number };
    };

    expect(parseChromium).toHaveBeenCalledWith('C:\\P');
    expect(parseFirefox).not.toHaveBeenCalled();
    expect(result.canceled).toBe(false);
    expect(result.summary.bookmarks).toBe(1);
    expect(result.summary.folders).toBe(0);
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

  it('should import cookies when includeCookies=true and merge read/write counters', async () => {
    const ipcMain = createMockIpcMain();
    const create = vi
      .fn()
      .mockImplementation((opts: { title: string }) => ({ id: `id-${opts.title}` }));
    const readCookies = vi.fn().mockResolvedValue({
      cookies: [
        {
          host: '.example.com',
          path: '/',
          name: 'sid',
          value: 'v',
          secure: true,
          httpOnly: true,
          sameSite: 'lax' as const,
        },
      ],
      skipped: 2,
      encryptedSkipped: 3,
    });
    const saveCookies = vi.fn().mockResolvedValue({
      imported: 1,
      skipped: 0,
      failed: 0,
      encryptedSkipped: 0,
    });
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create } as never,
      detectBrowsers: () => [
        {
          id: 'firefox:C:\\F',
          kind: 'firefox' as const,
          displayName: 'Mozilla Firefox',
          profileName: 'default',
          profileDir: 'C:\\F',
          bookmarksSource: 'firefox-places' as const,
          cookiesSupport: 'full' as const,
        },
      ],
      parseChromiumBookmarks: vi.fn(),
      parseFirefoxPlaces: vi.fn().mockResolvedValue({
        title: 'root',
        children: [{ title: 'X', url: 'https://x.example/' }],
      }),
      readCookiesForBrowser: readCookies,
      saveCookies,
    });

    const result = (await ipcMain.invoke('import.bookmarksFromBrowser', {
      id: 'firefox:C:\\F',
      includeCookies: true,
    })) as {
      summary: { bookmarks: number };
      cookies: { imported: number; skipped: number; encryptedSkipped: number } | null;
    };

    expect(result.summary.bookmarks).toBe(1);
    expect(readCookies).toHaveBeenCalledTimes(1);
    expect(saveCookies).toHaveBeenCalledTimes(1);
    expect(result.cookies).toMatchObject({ imported: 1, skipped: 2, encryptedSkipped: 3 });
  });

  it('should skip cookie read when capability is none and return explanatory note', async () => {
    const ipcMain = createMockIpcMain();
    const readCookies = vi.fn();
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create: vi.fn(() => ({ id: 'x', title: 'x' })) } as never,
      detectBrowsers: () => [
        {
          id: 'chrome:C:\\C',
          kind: 'chrome' as const,
          displayName: 'Google Chrome',
          profileName: 'Default',
          profileDir: 'C:\\C',
          bookmarksSource: 'chromium-json' as const,
          cookiesSupport: 'none' as const,
          cookiesNote: '已启用应用级加密（ABE）',
        },
      ],
      parseChromiumBookmarks: vi.fn().mockReturnValue({
        title: 'root',
        children: [{ title: 'X', url: 'https://x.example/' }],
      }),
      readCookiesForBrowser: readCookies,
    });

    const result = (await ipcMain.invoke('import.bookmarksFromBrowser', {
      id: 'chrome:C:\\C',
      includeCookies: true,
    })) as {
      cookies: { imported: number; note?: string } | null;
    };

    expect(readCookies).not.toHaveBeenCalled();
    expect(result.cookies?.imported).toBe(0);
    expect(result.cookies?.note).toContain('ABE');
  });

  it('should keep bookmark import successful when cookie reading throws', async () => {
    const ipcMain = createMockIpcMain();
    registerImportHandlers({
      ipcMain: ipcMain as never,
      bookmarkManager: { create: vi.fn(() => ({ id: 'x', title: 'x' })) } as never,
      detectBrowsers: () => [
        {
          id: 'chrome:C:\\C',
          kind: 'chrome' as const,
          displayName: 'Google Chrome',
          profileName: 'Default',
          profileDir: 'C:\\C',
          bookmarksSource: 'chromium-json' as const,
          cookiesSupport: 'full' as const,
        },
      ],
      parseChromiumBookmarks: vi.fn().mockReturnValue({
        title: 'root',
        children: [{ title: 'X', url: 'https://x.example/' }],
      }),
      readCookiesForBrowser: vi.fn().mockRejectedValue(new Error('dpapi blocked')),
    });

    const result = (await ipcMain.invoke('import.bookmarksFromBrowser', {
      id: 'chrome:C:\\C',
      includeCookies: true,
    })) as {
      summary: { bookmarks: number };
      cookies: { imported: number; note?: string } | null;
    };

    expect(result.summary.bookmarks).toBe(1);
    expect(result.cookies?.imported).toBe(0);
    expect(result.cookies?.note).toContain('Cookie 导入失败');
  });
});
