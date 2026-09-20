/**
 * GenOffice 集成装配单元测试（阶段 2）
 *
 * 验证：
 * 1. 产物不可用：available=false；genoffice 伪地址回落 file-viewer
 * 2. 产物可用：initGenOfficeEmbed 收到 renderer/preload 路径；available=true
 * 3. resolveTabCreate：genoffice 地址 → 预构建 view；创建异常 → 回落
 * 4. dirty 旁路：kind:dirty-changed → TabManager.setDirty
 * 5. guardTabClose：仅 genoffice 标签走编辑器守卫，取消时返回 false
 * 6. confirmWindowClose：逐个脏编辑器确认，任一取消即中止
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import { createGenOfficeIntegration } from '../../src/main/genoffice/integration';
import type { GenOfficeArtifacts } from '../../src/main/genoffice/paths';

vi.mock('../../src/main/genoffice/loader', () => ({
  loadGenOfficeEmbed: vi.fn(),
  getGenOfficeSchemePrivileges: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/main/genoffice/paths', () => ({
  resolveGenOfficeArtifacts: vi.fn(),
  // 阶段 4.6：shell Home 常量/解析（集成层 import 需要）
  GENOFFICE_HOME_URL: 'urchin://genoffice-home',
  resolveShellRendererRoot: vi.fn().mockReturnValue(null),
}));

import { loadGenOfficeEmbed } from '../../src/main/genoffice/loader';
import { resolveGenOfficeArtifacts } from '../../src/main/genoffice/paths';
import { buildGenOfficeUrl } from '../../src/main/genoffice/url';

const mockedLoad = vi.mocked(loadGenOfficeEmbed);
const mockedArtifacts = vi.mocked(resolveGenOfficeArtifacts);

function makeArtifacts(): GenOfficeArtifacts {
  return {
    embedPath: 'C:\\vendor\\embed.js',
    rendererRoots: { markdown: 'C:\\vendor\\markdown\\renderer' },
    preloads: { markdown: 'C:\\vendor\\markdown\\preload.js' },
  };
}

function makeEmbedApi(viewResult: unknown = { kind: 'genoffice-view' }) {
  return {
    GENOFFICE_SCHEME_PRIVILEGES: [],
    initGenOfficeEmbed: vi.fn(),
    initGenOfficeAi: vi.fn(),
    createGenOfficeView: vi.fn().mockReturnValue(viewResult),
    genOfficeIsDirty: vi.fn().mockResolvedValue(false),
    requestGenOfficeClose: vi.fn().mockResolvedValue(true),
  };
}

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  dirty: boolean;
  viewKind: string;
  genofficeKind?: string;
  webContents: { id: number };
}

function makeDeps(tabs: FakeTab[]) {
  const ipcHandlers = new Map<string, (event: unknown, req: unknown) => unknown>();
  const ipcListeners = new Map<string, ((event: unknown, dirty: unknown) => void)[]>();
  const tabListeners = new Map<string, ((snapshot: unknown) => void)[]>();
  const setDirty = vi.fn((tabId: number, dirty: boolean) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) tab.dirty = dirty;
  });
  const deps = {
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
        ipcHandlers.set(channel, fn);
      },
      on: (channel: string, fn: (event: unknown, dirty: unknown) => void) => {
        const arr = ipcListeners.get(channel) ?? [];
        arr.push(fn);
        ipcListeners.set(channel, arr);
      },
    } as unknown as IpcMain,
    tabManager: {
      query: vi.fn((info: { windowId?: number }) =>
        tabs.filter((t) => info.windowId === undefined || t.windowId === info.windowId),
      ),
      getTab: vi.fn((id: number) => tabs.find((t) => t.id === id)),
      getTabByWebContents: vi.fn((wc: unknown) => tabs.find((t) => t.webContents === wc)),
      setDirty,
      on: (event: string, listener: (snapshot: unknown) => void) => {
        const arr = tabListeners.get(event) ?? [];
        arr.push(listener);
        tabListeners.set(event, arr);
      },
      off: vi.fn(),
    } as never,
    windowManager: {
      getWindow: vi.fn(() => ({ browserWindow: { id: 'win' } })),
    } as never,
    getTheme: () => 'light',
    createHomeView: vi.fn().mockReturnValue(null),
  };
  const emitTab = (event: string, snapshot: unknown): void => {
    (tabListeners.get(event) ?? []).forEach((fn) => fn(snapshot));
  };
  return { deps, ipcHandlers, ipcListeners, setDirty, emitTab };
}

describe('createGenOfficeIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should stay unavailable and fall back to file-viewer when artifacts are missing', () => {
    mockedArtifacts.mockReturnValue(null);
    mockedLoad.mockReturnValue(null);
    const { deps } = makeDeps([]);

    const integration = createGenOfficeIntegration(deps);
    integration.install();

    expect(integration.available).toBe(false);
    const resolved = integration.resolveTabCreate(buildGenOfficeUrl('markdown', 'C:\\a.md'));
    expect(resolved.viewKind).toBe('browser');
    expect(resolved.url).toBe('urchin://file-viewer/?path=C%3A%5Ca.md');
  });

  it('should init the embed with renderer roots and preloads when available', () => {
    const api = makeEmbedApi();
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const { deps, ipcHandlers, ipcListeners } = makeDeps([]);

    const integration = createGenOfficeIntegration(deps);
    integration.install();

    expect(integration.available).toBe(true);
    expect(integration.aiAvailable).toBe(true);
    expect(api.initGenOfficeEmbed).toHaveBeenCalledWith({
      rendererRoots: { markdown: 'C:\\vendor\\markdown\\renderer' },
      preloads: { markdown: 'C:\\vendor\\markdown\\preload.js' },
    });
    // 阶段 3：GenOffice 原生 AI 通道注册
    expect(api.initGenOfficeAi).toHaveBeenCalledTimes(1);
    // 宿主通道已注册
    expect(ipcHandlers.has('app:get-theme')).toBe(true);
    // dirty 旁路已挂
    expect(ipcListeners.has('markdown:dirty-changed')).toBe(true);
  });

  it('should create a genoffice view for genoffice urls and fall back on creation failure', () => {
    const api = makeEmbedApi({ kind: 'view' });
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const { deps } = makeDeps([]);
    const integration = createGenOfficeIntegration(deps);
    integration.install();

    const ok = integration.resolveTabCreate(buildGenOfficeUrl('markdown', 'C:\\a.md'));
    expect(ok).toMatchObject({
      viewKind: 'genoffice',
      genofficeKind: 'markdown',
      view: { kind: 'view' },
    });

    api.createGenOfficeView.mockImplementation(() => {
      throw new Error('boom');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = integration.resolveTabCreate(buildGenOfficeUrl('markdown', 'C:\\a.md'));
    expect(failed.viewKind).toBe('browser');
    expect(failed.url).toBe('urchin://file-viewer/?path=C%3A%5Ca.md');
    errSpy.mockRestore();
  });

  it('should degrade AI availability but keep editor views when ai init throws', () => {
    const api = makeEmbedApi();
    api.initGenOfficeAi.mockImplementation(() => {
      throw new Error('ai boom');
    });
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = makeDeps([]);

    const integration = createGenOfficeIntegration(deps);
    integration.install();

    expect(integration.aiAvailable).toBe(false);
    expect(integration.available).toBe(true);
    errSpy.mockRestore();
  });

  it('should create the shell Home view for genoffice-home urls, with React fallback', () => {
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(makeEmbedApi());
    const homeView = { kind: 'home-view' };
    const { deps } = makeDeps([]);
    deps.createHomeView.mockReturnValue(homeView);

    const integration = createGenOfficeIntegration(deps);
    integration.install();

    const resolved = integration.resolveTabCreate('urchin://genoffice-home');
    expect(resolved).toMatchObject({
      url: 'urchin://genoffice-home',
      viewKind: 'genoffice',
      genofficeKind: 'shell',
      view: homeView,
    });

    // shell 产物缺失（createHomeView 返回 null）→ 浏览器标签渲染 React 保底页
    deps.createHomeView.mockReturnValue(null);
    expect(integration.resolveTabCreate('urchin://genoffice-home')).toEqual({
      url: 'urchin://genoffice-home',
      viewKind: 'browser',
    });
  });

  it('should skip the close guard for shell Home tabs', async () => {
    const api = makeEmbedApi();
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const shellTab: FakeTab = {
      id: 11,
      windowId: 1,
      url: 'urchin://genoffice-home',
      dirty: false,
      viewKind: 'genoffice',
      genofficeKind: 'shell',
      webContents: { id: 11 },
    };
    const { deps } = makeDeps([shellTab]);
    const integration = createGenOfficeIntegration(deps);
    integration.install();

    await expect(integration.guardTabClose(11)).resolves.toBe(true);
    expect(api.requestGenOfficeClose).not.toHaveBeenCalled();
  });

  it('should fall back to file:// for html and to the viewer for other kinds', () => {
    mockedArtifacts.mockReturnValue(null);
    mockedLoad.mockReturnValue(null);
    const { deps } = makeDeps([]);

    const integration = createGenOfficeIntegration(deps);
    integration.install();

    const html = integration.resolveTabCreate(buildGenOfficeUrl('html', 'C:\\a b\\page.html'));
    expect(html.viewKind).toBe('browser');
    expect(html.url).toBe('file:///C:/a%20b/page.html');

    const docx = integration.resolveTabCreate(buildGenOfficeUrl('docs', 'C:\\a b\\doc.docx'));
    expect(docx.viewKind).toBe('browser');
    expect(docx.url).toBe('urchin://file-viewer/?path=C%3A%5Ca%20b%5Cdoc.docx');
  });

  it('should poll docs dirtiness through genOfficeIsDirty and mirror it to the tab', async () => {
    vi.useFakeTimers();
    try {
      const api = makeEmbedApi();
      api.genOfficeIsDirty = vi.fn().mockResolvedValue(true);
      mockedArtifacts.mockReturnValue(makeArtifacts());
      mockedLoad.mockReturnValue(api);
      const tab: FakeTab = {
        id: 9,
        windowId: 1,
        url: 'urchin://genoffice/?kind=docs&path=C%3A%5Ca.docx',
        dirty: false,
        viewKind: 'genoffice',
        genofficeKind: 'docs',
        webContents: { id: 99 },
      };
      const { deps, setDirty, emitTab } = makeDeps([tab]);
      const integration = createGenOfficeIntegration(deps);
      integration.install();

      emitTab('created', { id: tab.id, windowId: 1 });
      await vi.advanceTimersByTimeAsync(2000);

      expect(api.genOfficeIsDirty).toHaveBeenCalledWith('docs', tab.webContents);
      expect(setDirty).toHaveBeenCalledWith(9, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should mirror kind:dirty-changed to TabManager.setDirty', () => {
    const api = makeEmbedApi();
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const tab: FakeTab = {
      id: 7,
      windowId: 1,
      url: 'urchin://genoffice/?kind=markdown&path=C%3A%5Ca.md',
      dirty: false,
      viewKind: 'genoffice',
      genofficeKind: 'markdown',
      webContents: { id: 42 },
    };
    const { deps, ipcListeners, setDirty } = makeDeps([tab]);
    const integration = createGenOfficeIntegration(deps);
    integration.install();

    const listeners = ipcListeners.get('markdown:dirty-changed') ?? [];
    listeners.forEach((fn) => fn({ sender: tab.webContents }, true));

    expect(setDirty).toHaveBeenCalledWith(7, true);
  });

  it('should only guard genoffice tabs and propagate cancel', async () => {
    const api = makeEmbedApi();
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const genTab: FakeTab = {
      id: 1,
      windowId: 1,
      url: 'urchin://genoffice/?kind=markdown&path=x',
      dirty: true,
      viewKind: 'genoffice',
      genofficeKind: 'markdown',
      webContents: { id: 1 },
    };
    const webTab: FakeTab = {
      id: 2,
      windowId: 1,
      url: 'https://example.com',
      dirty: false,
      viewKind: 'browser',
      webContents: { id: 2 },
    };
    const { deps } = makeDeps([genTab, webTab]);
    const integration = createGenOfficeIntegration(deps);
    integration.install();

    await expect(integration.guardTabClose(2)).resolves.toBe(true);
    expect(api.requestGenOfficeClose).not.toHaveBeenCalled();

    api.requestGenOfficeClose.mockResolvedValueOnce(false);
    await expect(integration.guardTabClose(1)).resolves.toBe(false);
    expect(api.requestGenOfficeClose).toHaveBeenCalledWith(
      'markdown',
      genTab.webContents,
      expect.anything(),
    );
  });

  it('should stop window close confirmation on the first cancel', async () => {
    const api = makeEmbedApi();
    mockedArtifacts.mockReturnValue(makeArtifacts());
    mockedLoad.mockReturnValue(api);
    const tabA: FakeTab = {
      id: 1,
      windowId: 1,
      url: 'a',
      dirty: true,
      viewKind: 'genoffice',
      genofficeKind: 'markdown',
      webContents: { id: 1 },
    };
    const tabB: FakeTab = {
      id: 2,
      windowId: 1,
      url: 'b',
      dirty: true,
      viewKind: 'genoffice',
      genofficeKind: 'markdown',
      webContents: { id: 2 },
    };
    tabA.url = 'urchin://genoffice/?kind=markdown&path=a';
    tabB.url = 'urchin://genoffice/?kind=markdown&path=b';
    const { deps } = makeDeps([tabA, tabB]);
    const integration = createGenOfficeIntegration(deps);
    integration.install();

    api.requestGenOfficeClose.mockResolvedValueOnce(false);
    await expect(integration.confirmWindowClose(1)).resolves.toBe(false);
    expect(api.requestGenOfficeClose).toHaveBeenCalledTimes(1);

    api.requestGenOfficeClose.mockReset().mockResolvedValue(true);
    await expect(integration.confirmWindowClose(1)).resolves.toBe(true);
    expect(api.requestGenOfficeClose).toHaveBeenCalledTimes(2);
  });
});
