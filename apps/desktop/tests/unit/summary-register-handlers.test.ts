/**
 * Summary IPC Handler 注册单元测试
 *
 * 验证：
 * 1. summary.listTree：转发 summaryManager.listTree
 * 2. summary.run：
 *    - tab 不存在 → NOT_FOUND
 *    - 非 http(s) URL → STATE
 *    - 提取空结果 → INTERNAL
 *    - 正常流程：extract → format → save，返回保存结果
 * 3. summary.open：无窗口 → INTERNAL；有窗口 → 创建 tab 打开 file://
 * 4. summary.delete：转发 deleteDocument
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const summaryMocks = vi.hoisted(() => ({
  extractPageContent: vi.fn(),
  formatDocument: vi.fn(),
}));

vi.mock('@urchin/summary-agent', () => ({
  extractPageContent: summaryMocks.extractPageContent,
  formatDocument: summaryMocks.formatDocument,
}));

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

import { registerSummaryHandlers } from '../../src/main/summary/register-handlers';
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

function createMockSummaryManager() {
  return {
    listTree: vi.fn(),
    saveDocument: vi.fn(),
    deleteDocument: vi.fn(),
    setSaveDirectory: vi.fn(),
    getSaveDirectory: vi.fn(),
  };
}

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    windowId: 1,
    url: 'https://urchin.dev',
    title: 'Urchin',
    active: true,
    webContents: {
      getURL: () => 'https://urchin.dev',
      executeJavaScript: vi.fn(),
    },
    ...overrides,
  };
}

function createMockTabManager(tab = makeTab()) {
  return {
    create: vi.fn().mockReturnValue(tab),
    getTab: vi.fn().mockReturnValue(tab),
  };
}

function createMockWindowManager() {
  return {
    getAllWindows: vi.fn().mockReturnValue([{ id: 1 }]),
  };
}

describe('registerSummaryHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryMocks.formatDocument.mockReturnValue('<html>formatted</html>');
  });

  it('summary.listTree should forward to summaryManager', async () => {
    const ipcMain = createMockIpcMain();
    const summaryManager = createMockSummaryManager();
    summaryManager.listTree.mockResolvedValue({
      tree: [{ type: 'directory', name: '2026-08', relativePath: '2026-08/', children: [] }],
      rootPath: 'C:\\UserData\\summaries',
    });
    const tabManager = createMockTabManager();
    const windowManager = createMockWindowManager();

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: summaryManager as never,
      tabManager: tabManager as never,
      windowManager: windowManager as never,
    });

    const result = (await ipcMain.invoke('summary.listTree', {})) as { tree: unknown[] };

    expect(summaryManager.listTree).toHaveBeenCalled();
    expect(result.tree).toHaveLength(1);
  });

  it('summary.run should throw NOT_FOUND when tab missing', async () => {
    const ipcMain = createMockIpcMain();
    const tabManager = createMockTabManager();
    tabManager.getTab.mockReturnValue(undefined);

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: createMockSummaryManager() as never,
      tabManager: tabManager as never,
      windowManager: createMockWindowManager() as never,
    });

    await expect(ipcMain.invoke('summary.run', { tabId: 99 })).rejects.toThrow(/not found/i);
  });

  it('summary.run should throw STATE for non-http url', async () => {
    const ipcMain = createMockIpcMain();
    const tabManager = createMockTabManager(
      makeTab({ webContents: { getURL: () => 'file:///x.html' } }),
    );

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: createMockSummaryManager() as never,
      tabManager: tabManager as never,
      windowManager: createMockWindowManager() as never,
    });

    await expect(ipcMain.invoke('summary.run', { tabId: 1 })).rejects.toThrow(
      /cannot extract non-http/i,
    );
  });

  it('summary.run should throw INTERNAL on empty extraction', async () => {
    const ipcMain = createMockIpcMain();
    summaryMocks.extractPageContent.mockResolvedValue({
      extracted: false,
      title: '',
      contentHtml: '',
    });

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: createMockSummaryManager() as never,
      tabManager: createMockTabManager() as never,
      windowManager: createMockWindowManager() as never,
    });

    await expect(ipcMain.invoke('summary.run', { tabId: 1 })).rejects.toThrow(/failed to extract/i);
  });

  it('summary.run should extract, format and save document', async () => {
    const ipcMain = createMockIpcMain();
    const summaryManager = createMockSummaryManager();
    summaryManager.saveDocument.mockResolvedValue({
      filePath: 'C:\\UserData\\summaries\\2026-08\\2026-08-01_x.html',
      relativePath: '2026-08/2026-08-01_x.html',
      documentTitle: 'Title',
    });
    summaryMocks.extractPageContent.mockResolvedValue({
      extracted: true,
      title: 'Title',
      contentHtml: '<p>hi</p>',
      contentText: 'hi',
    });

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: summaryManager as never,
      tabManager: createMockTabManager() as never,
      windowManager: createMockWindowManager() as never,
    });

    const result = (await ipcMain.invoke('summary.run', { tabId: 1 })) as {
      relativePath: string;
    };

    expect(summaryMocks.extractPageContent).toHaveBeenCalledWith(expect.any(Function));
    expect(summaryMocks.formatDocument).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Title', contentHtml: '<p>hi</p>' }),
    );
    expect(summaryManager.saveDocument).toHaveBeenCalledWith('<html>formatted</html>', 'Title');
    expect(result.relativePath).toBe('2026-08/2026-08-01_x.html');
  });

  it('summary.open should throw INTERNAL when no window', async () => {
    const ipcMain = createMockIpcMain();
    const windowManager = createMockWindowManager();
    windowManager.getAllWindows.mockReturnValue([]);

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: createMockSummaryManager() as never,
      tabManager: createMockTabManager() as never,
      windowManager: windowManager as never,
    });

    await expect(ipcMain.invoke('summary.open', { absolutePath: 'C:\\x.html' })).rejects.toThrow(
      /no browser window/i,
    );
  });

  it('summary.open should create tab with file url', async () => {
    const ipcMain = createMockIpcMain();
    const tabManager = createMockTabManager(makeTab({ id: 7 }));
    const windowManager = createMockWindowManager();

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: createMockSummaryManager() as never,
      tabManager: tabManager as never,
      windowManager: windowManager as never,
    });

    const result = (await ipcMain.invoke('summary.open', {
      absolutePath: 'C:\\summaries\\2026-08\\x.html',
    })) as { ok: boolean; tabId: number };

    expect(tabManager.create).toHaveBeenCalledWith({
      windowId: 1,
      url: 'file:///C:/summaries/2026-08/x.html',
      active: true,
    });
    expect(result).toEqual({ ok: true, tabId: 7 });
  });

  it('summary.delete should forward to summaryManager', async () => {
    const ipcMain = createMockIpcMain();
    const summaryManager = createMockSummaryManager();
    summaryManager.deleteDocument.mockResolvedValue(undefined);

    registerSummaryHandlers({
      ipcMain: ipcMain as never,
      summaryManager: summaryManager as never,
      tabManager: createMockTabManager() as never,
      windowManager: createMockWindowManager() as never,
    });

    const result = (await ipcMain.invoke('summary.delete', {
      absolutePath: 'C:\\x.html',
    })) as { ok: boolean };

    expect(summaryManager.deleteDocument).toHaveBeenCalledWith('C:\\x.html');
    expect(result.ok).toBe(true);
  });
});
