/* eslint-disable @typescript-eslint/require-await -- 测试�?async mock 不需要真�?await */
/**
 * 快照导出：原�?清洗两种模式，MHTML/PDF/截图三条路径与临时文件清理�? */
import { describe, it, expect, vi } from 'vitest';
import {
  exportSnapshot,
  type SnapshotWebContents,
  type SnapshotExportDeps,
} from '../../../src/main/clipper/snapshot-export';
import type { ClipperStore } from '../../../src/main/clipper/store';

function makeStore(path: string): ClipperStore {
  return { reservePath: vi.fn(async () => path) } as unknown as ClipperStore;
}

function makeContents(overrides: Partial<SnapshotWebContents> = {}): SnapshotWebContents {
  const base = {
    savePage: vi.fn(async () => undefined),
    printToPDF: vi.fn(async () => Buffer.from('pdf')),
    executeJavaScript: vi.fn(async () => true),
  } as unknown as SnapshotWebContents;
  return { ...base, ...overrides };
}

describe('clipper snapshot export', () => {
  it('should export original MHTML via webContents.savePage', async () => {
    const contents = makeContents();
    const result = await exportSnapshot(
      { store: makeStore('/out/a.mhtml') },
      { tabWebContents: contents, format: 'mhtml', mode: 'original', noteName: 'a' },
    );
    expect(result.paths[0]).toBe('/out/a.mhtml');
    expect(contents.savePage).toHaveBeenCalledWith('/out/a.mhtml', 'MHTML');
  });

  it('should export original PDF and write buffer', async () => {
    const contents = makeContents();
    const writeFile = vi.fn(async () => undefined);
    const result = await exportSnapshot(
      { store: makeStore('/out/a.pdf'), writeFile },
      { tabWebContents: contents, format: 'pdf', mode: 'original', noteName: 'a' },
    );
    expect(result.paths[0]).toBe('/out/a.pdf');
    expect(contents.printToPDF).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith('/out/a.pdf', expect.any(Buffer));
  });

  it('should capture full page screenshot via CDP', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { width: 800, height: 2000 } };
      }
      return { data: Buffer.from('png').toString('base64') };
    });
    const contents = makeContents({
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand,
      },
    });
    const writeFile = vi.fn(async () => undefined);
    const result = await exportSnapshot(
      { store: makeStore('/out/a.png'), writeFile },
      { tabWebContents: contents, format: 'screenshot', mode: 'original', noteName: 'a' },
    );
    expect(result.paths[0]).toBe('/out/a.png');
    expect(writeFile).toHaveBeenCalledWith('/out/a.png', Buffer.from('png'));
  });

  it('should split tall screenshots into multiple files with warning', async () => {
    const sendCommand = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { width: 800, height: 32_000 } };
      }
      return { data: Buffer.from('png').toString('base64') };
    });
    const contents = makeContents({
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand,
      },
    });
    const reservePath = vi
      .fn()
      .mockResolvedValueOnce('/out/a.png')
      .mockResolvedValueOnce('/out/a-part2.png');
    const writeFile = vi.fn(async () => undefined);
    const result = await exportSnapshot(
      { store: { reservePath } as unknown as ClipperStore, writeFile },
      { tabWebContents: contents, format: 'screenshot', mode: 'original', noteName: 'a' },
    );
    expect(result.paths).toEqual(['/out/a.png', '/out/a-part2.png']);
    expect(result.warnings[0]).toContain('分段');
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('should build hidden window for clean snapshot and clean temp dir', async () => {
    const savePage = vi.fn(async () => undefined);
    const executeJavaScript = vi.fn(async () => true);
    const loadFile = vi.fn(async () => undefined);
    const destroy = vi.fn();
    const rm = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const createWindow = vi.fn(() => ({
      webContents: { savePage, executeJavaScript },
      loadFile,
      destroy,
      isDestroyed: () => false,
    })) as unknown as SnapshotExportDeps['createWindow'];
    const result = await exportSnapshot(
      {
        store: makeStore('/out/clean.mhtml'),
        createWindow,
        mkdtemp: vi.fn(
          async () => '/tmp/urchin-clipper-x',
        ) as unknown as SnapshotExportDeps['mkdtemp'],
        writeFile,
        rm,
      },
      {
        format: 'mhtml',
        mode: 'clean',
        noteName: 'clean',
        cleanedHtml: '<html><body>x</body></html>',
      },
    );
    expect(result.paths[0]).toBe('/out/clean.mhtml');
    expect(loadFile).toHaveBeenCalled();
    expect(executeJavaScript).toHaveBeenCalled();
    expect(savePage).toHaveBeenCalledWith('/out/clean.mhtml', 'MHTML');
    expect(destroy).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();
  });

  it('should reject clean snapshot without cleanedHtml', async () => {
    await expect(
      exportSnapshot(
        { store: makeStore('/out/x.mhtml') },
        { tabWebContents: makeContents(), format: 'mhtml', mode: 'clean', noteName: 'x' },
      ),
    ).rejects.toThrow('清洗快照缺少正文 HTML');
  });
});
