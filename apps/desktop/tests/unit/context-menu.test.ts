/**
 * 右键菜单模块单元测试
 *
 * 验证：
 * 1. buildMenuTemplate——复制/粘贴/保存网页三项 + 分隔线，按 editFlags 置灰、内部页禁用保存
 * 2. sanitizeFilename——Windows 非法字符清洗与空串回退
 * 3. saveCurrentPage——默认目录 <数据目录>/saved-pages/、取消、补扩展名、savePage('HTMLComplete')
 * 4. installTabContextMenu——对新建与存量 tab 的 webContents 挂接 context-menu 监听
 * 5. handleContextMenu——弹出坐标按 offset 补偿、复制/粘贴/保存动作分发、内部页禁止保存
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildMenuTemplate,
  sanitizeFilename,
  saveCurrentPage,
  installTabContextMenu,
  handleContextMenu,
  type ContextMenuTemplateItem,
  type ContextMenuTabInfo,
} from '../../src/main/context-menu';
import { TabManager } from '../../src/main/tabs/tab-manager';
import type { BrowserViewLike, WebContentsLike } from '../../src/main/tabs/types';

/**
 * 菜单运行时共享 mock（vi.hoisted：必须在 vi.mock factory 之前初始化）。
 * showSaveDialog / buildFromTemplate / fromWebContents 供各测试用例配置返回值与捕获模板。
 */
const contextMenuRuntime = vi.hoisted(() => {
  const runtime: {
    showSaveDialog: ReturnType<typeof vi.fn>;
    lastTemplate: ContextMenuTemplateItem[] | null;
    lastPopup: { x: number; y: number } | null;
    ownerWindow: unknown;
  } = {
    showSaveDialog: vi.fn(),
    lastTemplate: null,
    lastPopup: null,
    ownerWindow: null,
  };
  return runtime;
});

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: ContextMenuTemplateItem[]) => {
      contextMenuRuntime.lastTemplate = template;
      return {
        popup: (opts: { x?: number; y?: number }) => {
          contextMenuRuntime.lastPopup = { x: opts.x ?? 0, y: opts.y ?? 0 };
        },
      };
    },
  },
  dialog: {
    showSaveDialog: (...args: unknown[]) =>
      contextMenuRuntime.showSaveDialog(...args) as Promise<unknown>,
  },
  BrowserWindow: {
    fromWebContents: () => contextMenuRuntime.ownerWindow,
  },
}));

/** 创建 mock WebContents（context-menu 监听记录 + copy/paste/savePage mock）。 */
function createMockWebContents(): WebContentsLike & {
  _contextMenuListeners: ((...args: unknown[]) => void)[];
  copy: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  savePage: ReturnType<typeof vi.fn>;
  _emitContextMenu: (params: Record<string, unknown>) => void;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const contextMenuListeners: ((...args: unknown[]) => void)[] = [];
  return {
    loadURL: (url: string) => {
      void url;
      return Promise.resolve();
    },
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    canGoBack: () => false,
    canGoForward: () => false,
    destroy: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      if (event === 'context-menu') contextMenuListeners.push(handler);
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
    },
    executeJavaScript: vi.fn().mockResolvedValue(null),
    getURL: vi.fn().mockReturnValue('about:blank'),
    copy: vi.fn(),
    paste: vi.fn(),
    savePage: vi.fn().mockResolvedValue(undefined),
    get _contextMenuListeners() {
      return contextMenuListeners;
    },
    _emitContextMenu: (params: Record<string, unknown>) => {
      contextMenuListeners.forEach((fn) => fn({}, params));
    },
  };
}

/** 创建 mock BrowserView。 */
function createMockBrowserView(): BrowserViewLike {
  const webContents = createMockWebContents();
  return { webContents, setBounds: vi.fn() };
}

/** 收集菜单项的 label / enabled。 */
function resolveItems(items: ContextMenuTemplateItem[]): {
  labels: string[];
  enabled: Record<string, boolean>;
} {
  const labels: string[] = [];
  const enabled: Record<string, boolean> = {};
  for (const item of items) {
    if ('type' in item) {
      labels.push('---');
    } else {
      labels.push(item.label);
      enabled[item.label] = item.enabled;
    }
  }
  return { labels, enabled };
}

/** 触发菜单模板中的 click（按 label 定位）。 */
function clickItem(items: ContextMenuTemplateItem[], label: string): void {
  const item = items.find((i) => 'label' in i && i.label === label);
  expect(item).toBeDefined();
  if (item && 'label' in item) item.click?.();
}

describe('buildMenuTemplate', () => {
  const actions = { copy: vi.fn(), paste: vi.fn(), save: vi.fn() };
  const externalTab: ContextMenuTabInfo = { url: 'https://example.com/page', title: '示例' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render copy / paste / save with separator', () => {
    const { labels } = resolveItems(buildMenuTemplate({}, externalTab, actions));
    expect(labels).toEqual(['复制', '粘贴', '---', '保存网页为…']);
  });

  it('should disable copy when editFlags.canCopy is false', () => {
    const { enabled } = resolveItems(
      buildMenuTemplate({ editFlags: { canCopy: false, canPaste: true } }, externalTab, actions),
    );
    expect(enabled['复制']).toBe(false);
    expect(enabled['粘贴']).toBe(true);
  });

  it('should disable paste when editFlags.canPaste is false', () => {
    const { enabled } = resolveItems(
      buildMenuTemplate({ editFlags: { canCopy: true, canPaste: false } }, externalTab, actions),
    );
    expect(enabled['粘贴']).toBe(false);
  });

  it('should keep copy/paste enabled when editFlags missing (test mock compatibility)', () => {
    const { enabled } = resolveItems(buildMenuTemplate({}, externalTab, actions));
    expect(enabled['复制']).toBe(true);
    expect(enabled['粘贴']).toBe(true);
  });

  it('should disable save for urchin:// internal pages', () => {
    const internalTab: ContextMenuTabInfo = { url: 'urchin://newtab', title: '新标签页' };
    const { enabled } = resolveItems(buildMenuTemplate({}, internalTab, actions));
    expect(enabled['保存网页为…']).toBe(false);
  });

  it('should keep save enabled when tab is undefined', () => {
    const { enabled } = resolveItems(buildMenuTemplate({}, undefined, actions));
    expect(enabled['保存网页为…']).toBe(true);
  });

  it('should invoke action callbacks on click', () => {
    const items = buildMenuTemplate({}, externalTab, actions);
    clickItem(items, '复制');
    clickItem(items, '粘贴');
    clickItem(items, '保存网页为…');
    expect(actions.copy).toHaveBeenCalledTimes(1);
    expect(actions.paste).toHaveBeenCalledTimes(1);
    expect(actions.save).toHaveBeenCalledTimes(1);
  });
});

describe('sanitizeFilename', () => {
  it('should strip Windows-illegal characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('should strip illegal chars to underscores (valid filename)', () => {
    expect(sanitizeFilename('***')).toBe('___');
  });

  it('should fall back to default name for whitespace-only result', () => {
    expect(sanitizeFilename('   ', 'page')).toBe('page');
  });
});

describe('saveCurrentPage', () => {
  const testTab: ContextMenuTabInfo = { url: 'https://example.com', title: '示例标题' };

  function createDeps() {
    return {
      getDataDir: () => 'C:\\urchin-data',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    contextMenuRuntime.ownerWindow = null;
  });

  it('should default to <dataDir>/saved-pages (independent of download dir)', async () => {
    const wc = createMockWebContents();

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\urchin-data\\saved-pages\\示例标题.html',
    });

    await saveCurrentPage(wc as never, testTab, createDeps());

    expect(contextMenuRuntime.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'C:\\urchin-data\\saved-pages\\示例标题.html',
      }),
    );
  });

  it('should pass owner window when available', async () => {
    const wc = createMockWebContents();
    const owner = { isDestroyed: () => false };
    contextMenuRuntime.ownerWindow = owner;

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\saved\\示例标题.html',
    });

    await saveCurrentPage(wc as never, testTab, createDeps());

    expect(contextMenuRuntime.showSaveDialog).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ defaultPath: 'C:\\urchin-data\\saved-pages\\示例标题.html' }),
    );
  });

  it('should return saved:false and not save when dialog canceled', async () => {
    const wc = createMockWebContents();

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: true,
      filePath: null,
    });

    const result = await saveCurrentPage(wc as never, testTab, createDeps());

    expect(result).toEqual({ saved: false });
    expect(wc.savePage).not.toHaveBeenCalled();
  });

  it('should append .html when user stripped the extension', async () => {
    const wc = createMockWebContents();

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\saves\\page',
    });

    const result = await saveCurrentPage(wc as never, testTab, createDeps());

    expect(wc.savePage).toHaveBeenCalledWith('C:\\saves\\page.html', 'HTMLComplete');
    expect(result).toEqual({ saved: true, path: 'C:\\saves\\page.html' });
  });

  it('should keep existing extension untouched', async () => {
    const wc = createMockWebContents();

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\saves\\page.htm',
    });

    await saveCurrentPage(wc as never, testTab, createDeps());

    expect(wc.savePage).toHaveBeenCalledWith('C:\\saves\\page.htm', 'HTMLComplete');
  });
});

describe('installTabContextMenu', () => {
  function createTabManager(): TabManager {
    return new TabManager(() => createMockBrowserView());
  }

  function createDeps() {
    return { getDataDir: () => 'C:\\data' };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should attach context-menu listener to existing tabs at install time', () => {
    const tabManager = createTabManager();
    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;

    expect(wc._contextMenuListeners).toHaveLength(0);
    installTabContextMenu(tabManager, createDeps());
    expect(wc._contextMenuListeners).toHaveLength(1);
  });

  it('should attach listener to tabs created after install', () => {
    const tabManager = createTabManager();
    installTabContextMenu(tabManager, createDeps());

    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;
    expect(wc._contextMenuListeners).toHaveLength(1);
  });

  it('should execute copy/paste on the tab webContents via menu click', () => {
    const tabManager = createTabManager();
    installTabContextMenu(tabManager, createDeps());
    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;

    wc._emitContextMenu({ x: 10, y: 20, editFlags: { canCopy: true, canPaste: true } });

    const items = contextMenuRuntime.lastTemplate;
    expect(items).not.toBeNull();
    clickItem(items!, '复制');
    clickItem(items!, '粘贴');
    expect(wc.copy).toHaveBeenCalledTimes(1);
    expect(wc.paste).toHaveBeenCalledTimes(1);
  });

  it('should compensate popup coordinates by BrowserView offset', () => {
    const tabManager = new TabManager(() => ({
      webContents: createMockWebContents(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 44, y: 0, width: 900, height: 700 }),
    }));
    installTabContextMenu(tabManager, createDeps());
    const tab = tabManager.create({ windowId: 1, url: 'https://example.com' });
    const wc = tab.webContents as unknown as ReturnType<typeof createMockWebContents>;

    contextMenuRuntime.lastPopup = null;
    wc._emitContextMenu({ x: 100, y: 200, editFlags: { canCopy: true, canPaste: true } });

    expect(contextMenuRuntime.lastPopup).toEqual({ x: 144, y: 200 });
  });
});

describe('handleContextMenu', () => {
  const deps = { getDataDir: () => 'C:\\data' };

  beforeEach(() => {
    vi.clearAllMocks();
    contextMenuRuntime.ownerWindow = null;
  });

  it('should popup menu with params coordinates when no offset', () => {
    const wc = createMockWebContents();

    handleContextMenu(
      wc as never,
      { x: 50, y: 60, editFlags: { canCopy: true, canPaste: true } } as never,
      undefined,
      deps,
    );

    expect(contextMenuRuntime.lastPopup).toEqual({ x: 50, y: 60 });
  });

  it('should add offset to popup coordinates', () => {
    const wc = createMockWebContents();

    handleContextMenu(
      wc as never,
      { x: 50, y: 60, editFlags: { canCopy: true, canPaste: true } } as never,
      undefined,
      deps,
      { x: 44, y: 10 },
    );

    expect(contextMenuRuntime.lastPopup).toEqual({ x: 94, y: 70 });
  });

  it('should execute copy / paste on click', () => {
    const wc = createMockWebContents();
    const tabInfo: ContextMenuTabInfo = { url: 'https://example.com', title: '示例' };

    handleContextMenu(
      wc as never,
      { x: 0, y: 0, editFlags: { canCopy: true, canPaste: true } } as never,
      tabInfo,
      deps,
    );

    const items = contextMenuRuntime.lastTemplate;
    expect(items).not.toBeNull();
    clickItem(items!, '复制');
    clickItem(items!, '粘贴');
    expect(wc.copy).toHaveBeenCalledTimes(1);
    expect(wc.paste).toHaveBeenCalledTimes(1);
  });

  it('should not save for urchin:// internal pages even when save clicked', () => {
    const wc = createMockWebContents();
    const internalTab: ContextMenuTabInfo = { url: 'urchin://newtab', title: '新标签页' };

    handleContextMenu(
      wc as never,
      { x: 0, y: 0, editFlags: { canCopy: true, canPaste: true } } as never,
      internalTab,
      deps,
    );

    const items = contextMenuRuntime.lastTemplate;
    expect(items).not.toBeNull();
    clickItem(items!, '保存网页为…');
    expect(contextMenuRuntime.showSaveDialog).not.toHaveBeenCalled();
    expect(wc.savePage).not.toHaveBeenCalled();
  });

  it('should save for external pages when save clicked', async () => {
    const wc = createMockWebContents();
    const externalTab: ContextMenuTabInfo = { url: 'https://example.com', title: '示例' };

    contextMenuRuntime.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:\\saved\\示例.html',
    });

    handleContextMenu(
      wc as never,
      { x: 0, y: 0, editFlags: { canCopy: true, canPaste: true } } as never,
      externalTab,
      deps,
    );

    const items = contextMenuRuntime.lastTemplate;
    expect(items).not.toBeNull();
    clickItem(items!, '保存网页为…');
    // 保存为异步流程（对话框 → savePage），等待微任务完成后再断言
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wc.savePage).toHaveBeenCalledWith('C:\\saved\\示例.html', 'HTMLComplete');
  });
});
