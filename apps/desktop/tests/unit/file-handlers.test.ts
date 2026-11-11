/**
 * 本地文件域 IPC handler（file.stat / file.read / file.open）单元测试
 *
 * 验证：
 * 1. file.stat：返回元数据（名称/大小/扩展名/MIME/kind）；目录返回 isDir:true
 * 2. file.stat：文件不存在 → NOT_FOUND
 * 3. file.read：返回 UTF-8 内容 + truncated/totalSize/readBytes
 * 4. file.read：超过 maxBytes → 只读前 maxBytes 字节（有界读取，请求长度不超过上限）
 *    并标记 truncated=true，不再抛 FILE_TOO_LARGE
 * 5. file.read：文件不存在/不可读/目录 → NOT_FOUND
 * 6. file.open：文件选择（openFile）；取消返回 null
 * 7. file.dir：目录在前排序 / stat 失败跳过 / 目录不存在 NOT_FOUND
 *
 * mock 策略：fs 的 stat/open/readdir 经 deps 依赖注入（vitest jsdom 下
 * node 内置模块导出无法 mock/spy，与 settings-manager 注入 mock 持久层一致）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock electron：BrowserWindow + dialog ──
const mockShowOpenDialog = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})),
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => mockShowOpenDialog(...args) as unknown,
  },
}));

import { registerFileHandlers } from '../../src/main/files/register-handlers';

/** mock ipcMain，捕获 registerHandler 注册的 wrapped handler 并返回。 */
function captureHandlers(): Map<string, (event: unknown, req: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: () => undefined,
  };
  registerFileHandlers({ ipcMain: ipcMain as never });
  return handlers;
}

/** 带注入 fs mock 注册 handler。 */
function captureHandlersWithFs(mocks: {
  stat?: (path: string) => Promise<unknown>;
  open?: (path: string, flags: string) => Promise<unknown>;
  readdir?: (path: string) => Promise<unknown>;
}): Map<string, (event: unknown, req: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: () => undefined,
  };
  registerFileHandlers({
    ipcMain: ipcMain as never,
    stat: mocks.stat as never,
    open: mocks.open as never,
    readdir: mocks.readdir as never,
  });
  return handlers;
}

/**
 * 构造 mock 的 fs.promises.open：FileHandle.read 从内存 Buffer 按位置读取
 * （与真实顺序读语义一致），并记录每次请求的 length——用于断言「有界读取」
 * （请求长度永不超过读取上限，杜绝整读大文件）。
 */
function makeOpenMock(fileBytes: Buffer, requested: { lengths: number[] }) {
  return (_path: string, _flags: string) => {
    void _flags;
    const handle = {
      read: (buf: Buffer, offset: number, length: number, position: number) => {
        requested.lengths.push(length);
        const end = Math.min(position + length, fileBytes.length);
        const src = fileBytes.subarray(Math.min(position, fileBytes.length), end);
        src.copy(buf, offset);
        return Promise.resolve({ bytesRead: src.length, buffer: buf });
      },
      close: () => Promise.resolve(),
    };
    return Promise.resolve(handle);
  };
}

/** 调用 wrapped handler（带入参校验），返回出参或错误 payload。 */
async function callHandler(
  handlers: Map<string, (event: unknown, req: unknown) => Promise<unknown>>,
  channel: string,
  req: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, req);
}

beforeEach(() => {
  mockShowOpenDialog.mockReset();
});

describe('file.stat', () => {
  it('should return file metadata with kind classification', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 2048 }),
    });

    const res = await callHandler(handlers, 'file.stat', { path: 'C:\\music\\song.mp3' });

    expect(res).toMatchObject({
      name: 'song.mp3',
      size: 2048,
      ext: 'mp3',
      mimeType: 'audio/mpeg',
      kind: 'audio',
    });
  });

  it('should return NOT_FOUND when file does not exist', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.reject(new Error('ENOENT')),
    });

    const res = await callHandler(handlers, 'file.stat', { path: 'C:\\missing.mp3' });

    expect(res).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should return isDir=true for directory path', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => false, size: 0 }),
    });

    const res = await callHandler(handlers, 'file.stat', { path: 'C:\\folder' });

    expect(res).toMatchObject({ isDir: true, kind: 'binary', size: 0 });
  });

  it('should return isDir=false for regular file', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 10 }),
    });

    const res = await callHandler(handlers, 'file.stat', { path: 'C:\\a.txt' });

    expect(res).toMatchObject({ isDir: false, kind: 'text' });
  });
});

describe('file.read', () => {
  it('should return utf8 content with truncation metadata for small file', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 5 }),
      open: makeOpenMock(Buffer.from('hello', 'utf8'), { lengths: [] }),
    });

    const res = await callHandler(handlers, 'file.read', { path: 'C:\\doc.txt' });

    expect(res).toEqual({ content: 'hello', truncated: false, totalSize: 5, readBytes: 5 });
  });

  it('should read only first maxBytes bytes and mark truncated for oversized file', async () => {
    const requested = { lengths: [] as number[] };
    const big = Buffer.alloc(1000, 0x61); // 1000 × 'a'
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 1000 }),
      open: makeOpenMock(big, requested),
    });

    const res = (await callHandler(handlers, 'file.read', {
      path: 'C:\\big.txt',
      maxBytes: 100,
    })) as { content: string; truncated: boolean; totalSize: number; readBytes: number };

    // 有界读取：单次请求长度不超过 maxBytes（旧实现会先整读 1000 字节再拒载）
    expect(requested.lengths.every((n) => n <= 100)).toBe(true);
    expect(requested.lengths.reduce((a, b) => a + b, 0)).toBe(100);
    expect(res.truncated).toBe(true);
    expect(res.totalSize).toBe(1000);
    expect(res.readBytes).toBe(100);
    expect(res.content).toBe('a'.repeat(100));
  });

  it('should apply default 5MB limit for larger files', async () => {
    const requested = { lengths: [] as number[] };
    const big = Buffer.alloc(6 * 1024 * 1024, 0x62);
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 6 * 1024 * 1024 }),
      open: makeOpenMock(big, requested),
    });

    const res = (await callHandler(handlers, 'file.read', { path: 'C:\\big.log' })) as {
      truncated: boolean;
      readBytes: number;
    };

    expect(res.truncated).toBe(true);
    expect(res.readBytes).toBe(5 * 1024 * 1024);
  });

  it('should return NOT_FOUND when file does not exist', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.reject(new Error('ENOENT')),
    });

    const res = await callHandler(handlers, 'file.read', { path: 'C:\\missing.txt' });

    expect(res).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should return NOT_FOUND for directory path', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => false, size: 0 }),
    });

    const res = await callHandler(handlers, 'file.read', { path: 'C:\\folder' });

    expect(res).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('should return NOT_FOUND when open fails (e.g. EACCES)', async () => {
    const handlers = captureHandlersWithFs({
      stat: () => Promise.resolve({ isFile: () => true, size: 10 }),
      open: () => Promise.reject(new Error('EACCES')),
    });

    const res = await callHandler(handlers, 'file.read', { path: 'C:\\locked.txt' });

    expect(res).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('file.open', () => {
  it('should open file-only dialog (openFile)', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:\\doc.pdf'] });
    const handlers = captureHandlers();

    const res = await callHandler(handlers, 'file.open', {});

    expect(mockShowOpenDialog).toHaveBeenCalledWith(expect.anything(), {
      title: '打开文件',
      properties: ['openFile'],
    });
    expect(res).toEqual({ path: 'C:\\doc.pdf' });
  });

  it('should return null path when user cancels', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handlers = captureHandlers();

    const res = await callHandler(handlers, 'file.open', {});

    expect(res).toEqual({ path: null });
  });
});

describe('file.dir', () => {
  it('should list entries with directories first then files, sorted', async () => {
    const statImpl = (p: string) =>
      Promise.resolve({
        isFile: () => !p.includes('folder'),
        isDirectory: () => p.includes('folder'),
        size: p.includes('b.txt') ? 20 : 10,
      });
    const handlers = captureHandlersWithFs({
      readdir: () => Promise.resolve(['b.txt', 'a-folder', 'a.txt', 'c-folder']),
      stat: statImpl,
    });

    const res = (await callHandler(handlers, 'file.dir', { path: 'C:\\docs' })) as {
      entries: readonly { name: string; isDir: boolean; kind: string }[];
    };

    expect(res.entries.map((e) => e.name)).toEqual(['a-folder', 'c-folder', 'a.txt', 'b.txt']);
    expect(res.entries[0]).toMatchObject({ isDir: true, kind: 'binary' });
    expect(res.entries[2]).toMatchObject({ isDir: false, kind: 'text', size: 10 });
  });

  it('should skip entries that fail to stat', async () => {
    const handlers = captureHandlersWithFs({
      readdir: () => Promise.resolve(['good.txt', 'ghost']),
      stat: (p: string) =>
        p.includes('ghost')
          ? Promise.reject(new Error('EACCES'))
          : Promise.resolve({ isFile: () => true, isDirectory: () => false, size: 5 }),
    });

    const res = (await callHandler(handlers, 'file.dir', { path: 'C:\\docs' })) as {
      entries: readonly { name: string }[];
    };

    expect(res.entries.map((e) => e.name)).toEqual(['good.txt']);
  });

  it('should return NOT_FOUND when directory does not exist', async () => {
    const handlers = captureHandlersWithFs({
      readdir: () => Promise.reject(new Error('ENOENT')),
    });

    const res = await callHandler(handlers, 'file.dir', { path: 'C:\\missing' });

    expect(res).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('file.openPath', () => {
  /** 注入 routeFilePath 的 handler 注册（渲染层统一打开入口）。 */
  function captureWithRoute(
    route: (windowId: number, path: string) => boolean | Promise<boolean>,
  ): Map<string, (event: unknown, req: unknown) => Promise<unknown>> {
    const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
      removeHandler: () => undefined,
    };
    registerFileHandlers({ ipcMain: ipcMain as never, routeFilePath: route });
    return handlers;
  }

  it('should delegate to the main-process router with window id and origin', async () => {
    const route = vi.fn(() => true);
    const handlers = captureWithRoute(route);

    const res = await callHandler(handlers, 'file.openPath', {
      path: 'C:\\a\\note.md',
      windowId: 3,
    });

    expect(res).toEqual({ ok: true });
    // origin 缺省按 external（外部入口：浏览器通道）
    expect(route).toHaveBeenCalledWith(3, 'C:\\a\\note.md', 'external');
  });

  it('should pass the genoffice origin through (GenOffice 主页入口)', async () => {
    const route = vi.fn(() => true);
    const handlers = captureWithRoute(route);

    await callHandler(handlers, 'file.openPath', {
      path: 'C:\\a\\note.md',
      windowId: 2,
      origin: 'genoffice',
    });

    expect(route).toHaveBeenCalledWith(2, 'C:\\a\\note.md', 'genoffice');
  });

  it('should report ok:false when the router rejects the path', async () => {
    const handlers = captureWithRoute(() => false);

    const res = await callHandler(handlers, 'file.openPath', {
      path: 'C:\\missing\\a.md',
      windowId: 1,
    });

    expect(res).toEqual({ ok: false });
  });

  it('should swallow router exceptions into ok:false', async () => {
    const handlers = captureWithRoute(() => Promise.reject(new Error('boom')));

    const res = await callHandler(handlers, 'file.openPath', {
      path: 'C:\\a\\b.md',
      windowId: 1,
    });

    expect(res).toEqual({ ok: false });
  });

  it('should return ok:false when the dependency is not injected', async () => {
    const handlers = captureHandlers();

    const res = await callHandler(handlers, 'file.openPath', {
      path: 'C:\\a\\b.md',
      windowId: 1,
    });

    expect(res).toEqual({ ok: false });
  });
});

describe('file.openExternal', () => {
  /** 带注入 openPath 的 handler 注册（默认实现走 electron shell）。 */
  function captureWithOpenPath(
    openPath: (path: string) => Promise<string>,
  ): Map<string, (event: unknown, req: unknown) => Promise<unknown>> {
    const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
      removeHandler: () => undefined,
    };
    registerFileHandlers({ ipcMain: ipcMain as never, openPath });
    return handlers;
  }

  it('should return ok:true when the OS opens the file', async () => {
    const openPath = vi.fn(() => Promise.resolve(''));
    const handlers = captureWithOpenPath(openPath);

    const res = await callHandler(handlers, 'file.openExternal', { path: 'C:\\a.mkv' });

    expect(res).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith('C:\\a.mkv');
  });

  it('should pass the OS error message through instead of throwing', async () => {
    // shell.openPath 用返回字符串表达失败（非异常）：没有关联应用时不能抛，
    // 渲染层要展示具体原因。
    const handlers = captureWithOpenPath(() => Promise.resolve('没有关联的应用'));

    const res = await callHandler(handlers, 'file.openExternal', { path: 'C:\\a.xyz' });

    expect(res).toEqual({ ok: false, error: '没有关联的应用' });
  });

  it('should catch thrown errors', async () => {
    const handlers = captureWithOpenPath(() => Promise.reject(new Error('boom')));

    const res = await callHandler(handlers, 'file.openExternal', { path: 'C:\\a.xyz' });

    expect(res).toEqual({ ok: false, error: 'boom' });
  });
});
