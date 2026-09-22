/**
 * GenOffice Home 宿主适配（home-handlers）单元测试（阶段 4.6）
 *
 * 覆盖：最近/星标读写与分页、打开路径与浏览（含 recent 记录）、文件夹浏览/
 * 新建/改名/删除/移动（含冲突策略）、新建文档动作、主题/语言/偏好转发、
 * 集成与账号中性桩、未知方法兜底。
 *
 * mock 策略：electron（dialog/shell/webContents/app/clipboard）模块级 mock；
 * 文件系统使用真实临时目录（与 folder 语义强相关，mock 反而失真）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  trashItem: vi.fn(),
  showItemInFolder: vi.fn(),
  openExternal: vi.fn(),
  writeText: vi.fn(),
  getAllWebContents: vi.fn(() => [] as unknown[]),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0-test' },
  clipboard: { writeText: mocks.writeText },
  dialog: { showOpenDialog: mocks.showOpenDialog, showMessageBox: mocks.showMessageBox },
  shell: {
    trashItem: mocks.trashItem,
    showItemInFolder: mocks.showItemInFolder,
    openExternal: mocks.openExternal,
  },
  webContents: { getAllWebContents: mocks.getAllWebContents },
}));

import { registerGenOfficeHomeHandlers } from '../../src/main/genoffice/home-handlers';
import { GenOfficeHomeStore } from '../../src/main/genoffice/home-store';
import { createAiPanelPrefsStore } from '../../src/main/genoffice/host-channels';

type HomeCall = (method: string, ...args: unknown[]) => Promise<unknown>;

interface Harness {
  call: HomeCall;
  store: GenOfficeHomeStore;
  deps: {
    openLocalPath: ReturnType<typeof vi.fn>;
    openBlankDocument: ReturnType<typeof vi.fn>;
    writeBlankPdf: ReturnType<typeof vi.fn>;
    setLanguage: ReturnType<typeof vi.fn>;
    setTheme: ReturnType<typeof vi.fn>;
  };
}

let root: string;
let harness: Harness;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'urchin-genoffice-home-'));
  mocks.showOpenDialog.mockReset();
  mocks.trashItem.mockReset().mockResolvedValue(undefined);

  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  };
  const store = new GenOfficeHomeStore(join(root, 'genoffice-home.json'));
  const deps = {
    openLocalPath: vi.fn().mockReturnValue(true),
    openBlankDocument: vi.fn().mockReturnValue(true),
    writeBlankPdf: vi.fn().mockResolvedValue(undefined),
    setLanguage: vi.fn(),
    setTheme: vi.fn(),
  };
  registerGenOfficeHomeHandlers({
    ipcMain: ipcMain as never,
    store,
    documentsRoot: join(root, 'documents'),
    getTheme: () => 'light',
    setTheme: deps.setTheme,
    getVersion: () => '0.1.0-test',
    aiPanelPrefs: createAiPanelPrefsStore(),
    openLocalPath: deps.openLocalPath,
    openBlankDocument: deps.openBlankDocument,
    writeBlankPdf: deps.writeBlankPdf,
    setLanguage: deps.setLanguage,
  });
  harness = {
    call: async (method, ...args) => {
      const fn = handlers.get('genoffice:home');
      if (!fn) throw new Error('handler not registered');
      return fn({}, { method, args });
    },
    store,
    deps,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('registerGenOfficeHomeHandlers', () => {
  it('should open a path, record it as recent, and page recents', async () => {
    const file = join(root, 'note.md');
    writeFileSync(file, '# hi');

    await harness.call('openPath', file);
    expect(harness.deps.openLocalPath).toHaveBeenCalledWith(file);

    const page = (await harness.call('recents', { limit: 10 })) as {
      entries: { path: string; name: string; ext: string }[];
      total: number;
      totalAll: number;
    };
    expect(page.totalAll).toBe(1);
    expect(page.entries[0]).toMatchObject({ path: file, name: 'note.md', ext: 'md' });
  });

  it('should browse files through the dialog and open each selection', async () => {
    const a = join(root, 'a.docx');
    const b = join(root, 'b.pdf');
    writeFileSync(a, 'x');
    writeFileSync(b, 'x');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [a, b] });

    await harness.call('browse');

    expect(harness.deps.openLocalPath).toHaveBeenCalledTimes(2);
    const page = (await harness.call('recents', {})) as { entries: unknown[] };
    expect(page.entries).toHaveLength(2);
  });

  it('should list folders and supported files under the documents root', async () => {
    const documents = join(root, 'documents');
    mkdirSync(join(documents, 'sub'), { recursive: true });
    writeFileSync(join(documents, 'doc.md'), 'x');
    writeFileSync(join(documents, 'image.png'), 'x');

    const listing = (await harness.call('listFolder', documents)) as {
      folders: { name: string; hasSubfolders: boolean }[];
      files: { name: string }[];
    };
    expect(listing.folders.map((f) => f.name)).toEqual(['sub']);
    // png 属 image（可列），md 属 markdown
    expect(listing.files.map((f) => f.name).sort()).toEqual(['doc.md', 'image.png']);
  });

  it('should create/rename/delete folders and move paths with conflict policy', async () => {
    const documents = join(root, 'documents');
    mkdirSync(documents, { recursive: true });

    const created = (await harness.call('createFolder', documents, 'proj')) as {
      ok: boolean;
      path: string;
    };
    expect(created.ok).toBe(true);

    const renamed = (await harness.call('renameFolder', created.path, 'proj2')) as {
      ok: boolean;
      path: string;
    };
    expect(renamed.ok).toBe(true);
    expect(renamed.path.endsWith('proj2')).toBe(true);

    // 移动：目标存在 + keepBoth → 唯一名；skip → conflicts
    const src = join(root, 'move.md');
    writeFileSync(src, 'x');
    writeFileSync(join(documents, 'move.md'), 'y');
    const skip = (await harness.call('movePaths', [src], documents, 'skip')) as {
      moved: unknown[];
      conflicts: string[];
    };
    expect(skip.moved).toHaveLength(0);
    expect(skip.conflicts).toEqual([src]);

    const keepBoth = (await harness.call('movePaths', [src], documents, 'keepBoth')) as {
      moved: { to: string }[];
    };
    expect(keepBoth.moved).toHaveLength(1);
    expect(keepBoth.moved[0]!.to).not.toBe(join(documents, 'move.md'));

    await harness.call('deleteFolder', renamed.path);
    expect(mocks.trashItem).toHaveBeenCalledWith(renamed.path);
  });

  it('should rename files and keep the store in sync', async () => {
    const file = join(root, 'old.md');
    writeFileSync(file, 'x');
    await harness.call('openPath', file);

    const result = (await harness.call('renameFile', file, 'new.md')) as {
      ok: boolean;
      path: string;
    };
    expect(result.ok).toBe(true);

    const page = (await harness.call('recents', {})) as { entries: { path: string }[] };
    expect(page.entries[0]?.path).toBe(result.path);
  });

  it('should create a blank pdf in the default folder and open it', async () => {
    const documents = join(root, 'documents');
    await harness.call('newPdf');

    expect(harness.deps.writeBlankPdf).toHaveBeenCalledTimes(1);
    const target = harness.deps.writeBlankPdf.mock.calls[0]![0] as string;
    expect(target.startsWith(documents)).toBe(true);
    expect(target.endsWith('.pdf')).toBe(true);
    expect(harness.deps.openLocalPath).toHaveBeenCalledWith(target);
  });

  it('should route blank document kinds and ignore unsupported ones', async () => {
    await harness.call('newDoc');
    await harness.call('newMarkdown');
    await harness.call('newHtml');
    const blankCalls = harness.deps.openBlankDocument.mock.calls as unknown as [string][];
    expect(blankCalls.map((c) => c[0])).toEqual(['docs', 'markdown', 'html']);

    await expect(harness.call('newSheet')).resolves.toBeNull();
    await expect(harness.call('newSlide')).resolves.toBeNull();
    expect(harness.deps.openBlankDocument).toHaveBeenCalledTimes(3);
    // 未接入类型给用户明确提示（而非静默无反应）
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('should reject path-traversal names in rename/create', async () => {
    const file = join(root, 'safe.md');
    writeFileSync(file, 'x');
    const renamed = (await harness.call('renameFile', file, '..\\evil.md')) as { ok: boolean };
    expect(renamed.ok).toBe(false);

    const folder = (await harness.call('createFolder', root, 'a/b')) as { ok: boolean };
    expect(folder.ok).toBe(false);

    const renamedFolder = (await harness.call('renameFolder', join(root, 'documents'), '..')) as {
      ok: boolean;
    };
    expect(renamedFolder.ok).toBe(false);
  });

  it('should broadcast app:language-changed on setLanguage', async () => {
    const send = vi.fn();
    mocks.getAllWebContents.mockReturnValue([{ send }]);
    await harness.call('setLanguage', 'en');
    expect(send).toHaveBeenCalledWith('app:language-changed', 'en');
    mocks.getAllWebContents.mockReturnValue([]);
  });

  it('should forward theme, language and AI panel prefs', async () => {
    expect(await harness.call('getTheme')).toBe('light');
    await harness.call('setTheme', 'dark');
    expect(harness.deps.setTheme).toHaveBeenCalledWith('dark');

    await harness.call('setLanguage', 'en');
    expect(harness.deps.setLanguage).toHaveBeenCalledWith('en');
    expect(await harness.call('getLanguage')).toBe('en');

    const prefs = (await harness.call('setAiPanelPrefs', { side: 'right' })) as { side: string };
    expect(prefs.side).toBe('right');
  });

  it('should return neutral stubs for mcp/integrations', async () => {
    expect(await harness.call('starPromptShouldShow')).toEqual({ show: false, docOpens: 0 });
    const mcp = (await harness.call('getMcpStatus')) as { running: boolean; enabled: boolean };
    expect(mcp.running).toBe(false);
    expect(mcp.enabled).toBe(false);
    const integrations = (await harness.call('integrations.status')) as { agents: unknown[] };
    expect(integrations.agents).toEqual([]);
    await harness.call('integrations.copyText', 'hello');
    expect(mocks.writeText).toHaveBeenCalledWith('hello');
    // 遥测：不上报但回显开关状态（避免 UI 开关卡住）
    expect(await harness.call('setAnalyticsEnabled', true)).toBe(true);
    expect(await harness.call('getAnalyticsEnabled')).toBe(false);
  });

  it('should return null for unknown methods', async () => {
    await expect(harness.call('nope')).resolves.toBeNull();
  });
});
