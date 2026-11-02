/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment -- 测试用 async mock 与匹配器 */
/**
 * clipper IPC handlers：配置、快照、保存、复制、关闭与非法页面拒绝。
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerClipperHandlers,
  isClipableUrl,
} from '../../../src/main/clipper/register-handlers';
import type { ClipperStore } from '../../../src/main/clipper/store';

type Handler = (event: unknown, req: unknown) => Promise<unknown>;

function createHarness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: vi.fn(),
  };
  const settings = {
    get: vi.fn((key: string) => {
      const defaults: Record<string, unknown> = {
        'clipper.defaultFormat': 'markdown',
        'clipper.cleanSnapshot': true,
        'clipper.selectionPriority': true,
        'clipper.loadLazyContent': false,
        'clipper.localizeImages': false,
        'clipper.noteNameFormat': '{{title}}',
        'clipper.properties': 'title: {{title}}',
        'clipper.content': '{{content}}',
      };
      const overridesSettings = (overrides.settings as Record<string, unknown> | undefined) ?? {};
      return key in overridesSettings ? overridesSettings[key] : defaults[key];
    }),
  };
  const panel = { open: vi.fn(), close: vi.fn() };
  const store = {
    saveMarkdown: vi.fn(async () => '/data/documents/clipper/a.md'),
    reservePath: vi.fn(async () => '/data/documents/clipper/a.md'),
    writeMarkdownTo: vi.fn(async () => undefined),
  } as unknown as ClipperStore;
  const tabs = new Map<number, { id: number; url: string; webContents: unknown }>();
  tabs.set(1, { id: 1, url: 'https://example.com', webContents: { id: 1 } });
  tabs.set(2, { id: 2, url: 'urchin://settings', webContents: { id: 2 } });
  const tabManager = { getTab: (id: number) => tabs.get(id) };
  const saveSnapshot = vi.fn(async () => ({
    paths: ['/data/documents/clipper/a.mhtml'],
    warnings: [],
  }));
  const captureSnapshot = vi.fn(async () => ({
    url: 'https://example.com',
    title: 'Title',
    html: '<p>body</p>',
    selectionHtml: '',
    selectionText: '',
    signals: {
      copyBlocked: false,
      userSelectNone: false,
      hasCanvas: false,
      hasOpenShadow: false,
      hasClosedShadow: false,
      frameCount: 0,
      imageCount: 0,
      textLength: 4,
    },
  }));
  const closedShadowHtml = vi.fn(async () => '');
  const copyText = vi.fn();
  const openMhtmlFile = vi.fn();

  registerClipperHandlers({
    ipcMain: ipcMain as never,
    tabManager: tabManager as never,
    settings,
    panel,
    store,
    captureSnapshot,
    closedShadowHtml,
    shouldTryClosed: () => true,
    saveSnapshot,
    copyText,
    openMhtmlFile,
    getTheme: () => 'dark',
  });
  return {
    handlers,
    settings,
    panel,
    store,
    saveSnapshot,
    captureSnapshot,
    closedShadowHtml,
    copyText,
    openMhtmlFile,
  };
}

async function call(handlers: Map<string, Handler>, channel: string, req: unknown = {}) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return (await handler({}, req)) as Record<string, unknown>;
}

describe('clipper ipc handlers', () => {
  it('isClipableUrl should only accept http/https', () => {
    expect(isClipableUrl('https://a.test')).toBe(true);
    expect(isClipableUrl('http://a.test')).toBe(true);
    expect(isClipableUrl('file:///a')).toBe(false);
    expect(isClipableUrl('urchin://settings')).toBe(false);
  });

  it('should reject internal tab for open/page/saveSnapshot', async () => {
    const { handlers } = createHarness();
    await expect(call(handlers, 'clipper.open', { tabId: 2 })).resolves.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(call(handlers, 'clipper.page', { tabId: 2 })).resolves.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      call(handlers, 'clipper.saveSnapshot', {
        tabId: 2,
        format: 'mhtml',
        mode: 'original',
        noteName: 'x',
      }),
    ).resolves.toMatchObject({ code: 'VALIDATION' });
  });

  it('should open panel and return config', async () => {
    const { handlers, panel } = createHarness();
    await expect(call(handlers, 'clipper.open', { tabId: 1 })).resolves.toMatchObject({ ok: true });
    expect(panel.open).toHaveBeenCalledWith(1);
    const config = await call(handlers, 'clipper.config');
    expect(config).toMatchObject({
      theme: 'dark',
      defaultFormat: 'markdown',
      cleanSnapshot: true,
      localizeImages: false,
      saveDirLabel: 'documents/clipper',
    });
  });

  it('should return page snapshot and append closed shadow html', async () => {
    const { handlers, closedShadowHtml } = createHarness();
    closedShadowHtml.mockResolvedValue('<section closed>shadow</section>');
    const page = await call(handlers, 'clipper.page', { tabId: 1 });
    expect(page).toMatchObject({ url: 'https://example.com', title: 'Title' });
    expect(String(page.html)).toContain('shadow');
    expect(page.signals).toMatchObject({ hasClosedShadow: true });
  });

  it('should save markdown/snapshot, copy and close', async () => {
    const { handlers, store, saveSnapshot, copyText, panel } = createHarness();
    await expect(
      call(handlers, 'clipper.saveMarkdown', { noteName: 'x', markdown: 'body' }),
    ).resolves.toMatchObject({ path: '/data/documents/clipper/a.md', warnings: [] });
    expect(store.saveMarkdown).toHaveBeenCalled();

    await expect(
      call(handlers, 'clipper.saveSnapshot', {
        tabId: 1,
        format: 'mhtml',
        mode: 'clean',
        noteName: 'x',
        cleanedHtml: '<html></html>',
      }),
    ).resolves.toMatchObject({
      paths: ['/data/documents/clipper/a.mhtml'],
      warnings: [],
    });
    expect(saveSnapshot).toHaveBeenCalled();

    await expect(call(handlers, 'clipper.copy', { text: 'abc' })).resolves.toMatchObject({
      ok: true,
    });
    expect(copyText).toHaveBeenCalledWith('abc');

    await expect(call(handlers, 'clipper.close')).resolves.toMatchObject({ ok: true });
    expect(panel.close).toHaveBeenCalled();
  });

  it('should fall back to saveMarkdown when localizeImages is true but embedApi is unavailable', async () => {
    // settings 默认 localizeImages=false；此处覆盖为 true，但 harness 不注入 embedApi
    const { handlers, store } = createHarness({ settings: { 'clipper.localizeImages': true } });
    await expect(
      call(handlers, 'clipper.saveMarkdown', { noteName: 'x', markdown: 'body' }),
    ).resolves.toMatchObject({ path: '/data/documents/clipper/a.md', warnings: [] });
    expect(store.saveMarkdown).toHaveBeenCalled();
    expect(store.reservePath).not.toHaveBeenCalled();
  });

  it('should reject clean snapshot without cleanedHtml', async () => {
    const { handlers } = createHarness();
    await expect(
      call(handlers, 'clipper.saveSnapshot', {
        tabId: 1,
        format: 'pdf',
        mode: 'clean',
        noteName: 'x',
      }),
    ).resolves.toMatchObject({ code: 'VALIDATION' });
  });

  it('should allow clean snapshot without live tab, but require tab for original', async () => {
    const { handlers, saveSnapshot } = createHarness();
    await expect(
      call(handlers, 'clipper.saveSnapshot', {
        format: 'mhtml',
        mode: 'clean',
        noteName: 'x',
        cleanedHtml: '<html></html>',
      }),
    ).resolves.toMatchObject({ paths: ['/data/documents/clipper/a.mhtml'] });
    expect(saveSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ tabWebContents: expect.anything() }),
    );

    await expect(
      call(handlers, 'clipper.saveSnapshot', {
        format: 'mhtml',
        mode: 'original',
        noteName: 'x',
      }),
    ).resolves.toMatchObject({ code: 'VALIDATION' });
  });

  it('should route MHTML files through host viewer and validate input', async () => {
    const { handlers, openMhtmlFile } = createHarness();
    await expect(
      call(handlers, 'clipper.openMhtmlFile', { path: 'C:\\missing\\a.txt' }),
    ).resolves.toMatchObject({ code: 'VALIDATION' });
    await expect(
      call(handlers, 'clipper.openMhtmlFile', { path: 'C:\\missing\\a.mhtml' }),
    ).resolves.toMatchObject({ code: 'NOT_FOUND' });

    const dir = mkdtempSync(join(tmpdir(), 'urchin-clipper-mhtml-'));
    const file = join(dir, 'page.mhtml');
    writeFileSync(file, 'MIME-Version: 1.0\n', 'utf-8');
    try {
      await expect(call(handlers, 'clipper.openMhtmlFile', { path: file })).resolves.toMatchObject({
        ok: true,
      });
      expect(openMhtmlFile).toHaveBeenCalledWith(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
