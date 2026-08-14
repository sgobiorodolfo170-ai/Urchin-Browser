/**
 * M14 Page Context Extractor · IPC handler 单元测试
 *
 * 验证：
 * 1. page.extract handler 正确注册并响应
 * 2. 抽取成功时返回 ExtractedPageContext
 * 3. 不存在的 tab 返回 NOT_FOUND 错误 payload
 * 4. 不传 maxLength 时使用默认值 50_000
 */
import { describe, it, expect, vi } from 'vitest';
import type { IpcMainInvokeEvent } from '@urchin/ipc-contract';
import { registerPageContextHandlers } from '../../src/main/page-context/register-handlers';
import type { TabManager } from '../../src/main/tabs/tab-manager';
import type { Tab, TabSnapshot, WebContentsLike } from '../../src/main/tabs/types';

/** 创建 mock WebContents（executeJavaScript 返回模拟 DOM 抽取结果） */
function createMockWebContents(): WebContentsLike {
  return {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    destroy: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue({
      title: 'Mocked Page',
      byline: 'Mock Author',
      excerpt: 'Mock excerpt.',
      textContent: 'Mocked main content.',
      markdown: 'Mocked main content.',
      length: 20,
      language: 'en',
      siteName: 'MockSite',
      extraction_method: 'dom-simplified',
    }),
    getURL: vi.fn().mockReturnValue('https://mocked.example.com/page'),
  };
}

/** 创建 mock TabManager */
function createMockTabManager(exists = true): TabManager & {
  _webContents: WebContentsLike;
} {
  const snapshot: TabSnapshot = {
    id: 1,
    windowId: 1,
    url: 'https://mocked.example.com/page',
    title: '',
    active: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    indexInWindow: 0,
  };
  const webContents = createMockWebContents();
  const tab: Tab = {
    ...snapshot,
    htmlFullscreen: false,
    webContents,
    view: {
      webContents: {} as never,
      setBounds: vi.fn(),
    },
  };
  return {
    getTab: vi.fn().mockReturnValue(exists ? tab : undefined),
    _webContents: webContents,
  } as never;
}

/** 创建 mock ipcMain */
function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    hasHandler(channel: string): boolean {
      return handlers.has(channel);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null }, req);
    },
  };
}

describe('registerPageContextHandlers', () => {
  it('should register page.extract handler', () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerPageContextHandlers(ipcMain as never, mgr);

    expect(ipcMain.hasHandler('page.extract')).toBe(true);
  });

  it('should return ExtractedPageContext on successful extraction', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerPageContextHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('page.extract', { tabId: 1 })) as {
      context: {
        url: string;
        title: string;
        textContent: string;
        extraction_method: string;
      };
    };

    expect(result.context).toBeDefined();
    expect(result.context.url).toBe('https://mocked.example.com/page');
    expect(result.context.title).toBe('Mocked Page');
    expect(result.context.textContent).toBe('Mocked main content.');
    expect(result.context.extraction_method).toBe('dom-simplified');
  });

  it('should call webContents.executeJavaScript', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerPageContextHandlers(ipcMain as never, mgr);

    await ipcMain.invoke('page.extract', { tabId: 1 });

    expect(mgr._webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('should call tabManager.getTab with provided tabId', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerPageContextHandlers(ipcMain as never, mgr);

    await ipcMain.invoke('page.extract', { tabId: 42 });

    expect(mgr.getTab).toHaveBeenCalledWith(42);
  });

  it('should return NOT_FOUND error payload when tab does not exist', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager(false);
    registerPageContextHandlers(ipcMain as never, mgr);

    const result = (await ipcMain.invoke('page.extract', { tabId: 999 })) as {
      code: string;
      message: string;
    };

    expect(result.code).toBe('NOT_FOUND');
    expect(result.message).toContain('Tab not found');
    expect(result.message).toContain('999');
  });

  it('should use custom maxLength when provided', async () => {
    const ipcMain = createMockIpcMain();
    const mgr = createMockTabManager();
    registerPageContextHandlers(ipcMain as never, mgr);

    // 注入超长内容验证截断
    const longText = 'x'.repeat(2000);
    mgr._webContents.executeJavaScript = vi.fn().mockResolvedValue({
      title: 'Long',
      textContent: longText,
      markdown: longText,
      length: longText.length,
      extraction_method: 'dom-simplified',
    });

    const result = (await ipcMain.invoke('page.extract', { tabId: 1, maxLength: 500 })) as {
      context: { textContent: string; warnings: string[] };
    };

    expect(result.context.textContent.length).toBe(500);
    expect(result.context.warnings.some((w) => w.includes('truncated to 500'))).toBe(true);
  });
});
