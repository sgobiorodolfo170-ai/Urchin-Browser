/**
 * 编辑器草稿域 + 文件写入通道单元测试
 *
 * 验证：
 * 1. editor.saveDraft：草稿写入 <draftsDir>/<key>（key 白名单校验由 zod schema 执行）
 * 2. editor.cleanupDraft：存在删除返回 removed:true；不存在返回 false
 * 3. sweepDrafts：清扫目录下全部残留（启动时调用），目录本身保留
 * 4. file.write：覆盖写入并返回 bytesWritten；目标不可写 → 错误 payload
 * 5. file.saveAs：取消 → path:null；选定 → defaultPath 带净化文件名、写入成功返回 path；
 *    选定路径缺扩展名时补默认扩展名
 *
 * mock 策略：fs 与 dialog 经 deps 依赖注入（与 file-handlers.test.ts 一致）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockShowSaveDialog = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: (...args: unknown[]) => mockShowSaveDialog(...args) as unknown,
  },
}));

import { registerEditorHandlers, sweepDrafts } from '../../src/main/files/editor-handlers';
import { registerFileHandlers } from '../../src/main/files/register-handlers';

/** 构造内存版 fs 依赖（记录写入/删除调用）。 */
function makeFsMocks(initialFiles: Map<string, string> = new Map<string, string>()) {
  const written: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const writeFile = (path: string, content: string) => {
    written.push({ path, content });
    initialFiles.set(path, content);
    return Promise.resolve();
  };
  const unlink = (path: string) => {
    if (!initialFiles.has(path)) {
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    }
    removed.push(path);
    initialFiles.delete(path);
    return Promise.resolve();
  };
  const readdir = () =>
    Promise.resolve([...initialFiles.keys()].map((p) => p.split(/[\\/]/).pop() ?? p));
  const rm = (target: string) => {
    removed.push(target);
    for (const p of [...initialFiles.keys()]) {
      if (p.startsWith(target)) initialFiles.delete(p);
    }
    return Promise.resolve();
  };
  const access = (path: string) =>
    initialFiles.has(path) ? Promise.resolve() : Promise.reject(new Error('ENOENT'));
  return { initialFiles, written, removed, writeFile, unlink, readdir, rm, access };
}

/** 捕获注册的 wrapped handler。 */
function capture(
  register: (deps: Record<string, unknown>) => void,
  deps: Record<string, unknown>,
): Map<string, (event: unknown, req: unknown) => Promise<unknown>> {
  const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
  register({
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
      removeHandler: () => undefined,
    },
    ...deps,
  });
  return handlers;
}

async function call(
  handlers: Map<string, (event: unknown, req: unknown) => Promise<unknown>>,
  channel: string,
  req: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({ sender: {} }, req);
}

const DRAFTS_DIR = 'C:\\data\\editor-drafts';

describe('editor.saveDraft / editor.cleanupDraft', () => {
  let fs: ReturnType<typeof makeFsMocks>;
  let handlers: Map<string, (event: unknown, req: unknown) => Promise<unknown>>;

  beforeEach(() => {
    fs = makeFsMocks();
    handlers = capture((d) => registerEditorHandlers(d as never), {
      draftsDir: DRAFTS_DIR,
      writeFile: fs.writeFile,
      unlink: fs.unlink,
      readdir: fs.readdir,
      rm: fs.rm,
    });
  });

  it('should write draft into drafts dir keyed by draft key', async () => {
    const res = (await call(handlers, 'editor.saveDraft', {
      key: 'notes-md-1a2b3c4d',
      content: '# draft',
    })) as { draftPath: string };

    expect(res.draftPath).toBe(`${DRAFTS_DIR}\\notes-md-1a2b3c4d`);
    expect(fs.written[0]).toEqual({ path: res.draftPath, content: '# draft' });
  });

  it('should reject path-like draft key (zod VALIDATION)', async () => {
    const res = await call(handlers, 'editor.saveDraft', {
      key: '..\\evil',
      content: 'x',
    });
    expect(res).toMatchObject({ code: 'VALIDATION' });
  });

  it('should report removed:true for existing draft and false for missing', async () => {
    await call(handlers, 'editor.saveDraft', { key: 'k1', content: 'x' });

    expect(await call(handlers, 'editor.cleanupDraft', { key: 'k1' })).toEqual({ removed: true });
    expect(await call(handlers, 'editor.cleanupDraft', { key: 'missing' })).toEqual({
      removed: false,
    });
    expect(fs.removed).toContain(`${DRAFTS_DIR}\\k1`);
  });
});

describe('sweepDrafts（启动清扫）', () => {
  it('should remove all entries inside drafts dir', async () => {
    const fs = makeFsMocks(
      new Map([
        [`${DRAFTS_DIR}\\a`, '1'],
        [`${DRAFTS_DIR}\\b`, '2'],
      ]),
    );
    await sweepDrafts(DRAFTS_DIR, { readdir: fs.readdir as never, rm: fs.rm as never });
    expect(fs.removed).toEqual([`${DRAFTS_DIR}\\a`, `${DRAFTS_DIR}\\b`]);
  });
});

describe('file.write', () => {
  it('should overwrite target and return bytesWritten', async () => {
    const fs = makeFsMocks();
    const handlers = capture((d) => registerFileHandlers(d as never), {
      writeFile: fs.writeFile,
      stat: () => Promise.resolve({ isFile: () => true, size: 5 }),
    });

    const res = (await call(handlers, 'file.write', {
      path: 'C:\\docs\\notes.md',
      content: 'hello',
    })) as { bytesWritten: number };

    expect(res).toEqual({ bytesWritten: 5 });
    expect(fs.written[0]).toEqual({ path: 'C:\\docs\\notes.md', content: 'hello' });
  });

  it('should return error payload when write fails', async () => {
    const handlers = capture((d) => registerFileHandlers(d as never), {
      writeFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
      stat: () => Promise.resolve({ isFile: () => true, size: 5 }),
    });

    const res = await call(handlers, 'file.write', {
      path: 'C:\\docs\\locked.md',
      content: 'x',
    });
    expect(res).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('file.saveAs', () => {
  beforeEach(() => {
    mockShowSaveDialog.mockReset();
  });

  function captureSaveAs(fsMocks: ReturnType<typeof makeFsMocks>) {
    return capture((d) => registerFileHandlers(d as never), {
      writeFile: fsMocks.writeFile,
      showSaveDialog: mockShowSaveDialog,
    });
  }

  it('should return path:null when user cancels', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const handlers = captureSaveAs(makeFsMocks());

    const res = await call(handlers, 'file.saveAs', { content: 'x', defaultName: 'a.md' });

    expect(res).toEqual({ path: null });
    expect(mockShowSaveDialog).toHaveBeenCalledTimes(1);
  });

  it('should write to chosen path with sanitized default name', async () => {
    mockShowSaveDialog.mockImplementation((_win: unknown, opts: { defaultPath: string }) => {
      // 记录对话框收到的 defaultPath（断言净化 + 目录拼接）
      (mockShowSaveDialog as unknown as { received: string }).received = opts.defaultPath;
      return Promise.resolve({ canceled: false, filePath: 'C:\\docs\\saved.md' });
    });
    const fs = makeFsMocks();
    const handlers = captureSaveAs(fs);

    const res = (await call(handlers, 'file.saveAs', {
      content: '# hi',
      defaultName: 'my:notes<md>.md',
    })) as { path: string };

    expect(res).toEqual({ path: 'C:\\docs\\saved.md' });
    const received = (mockShowSaveDialog as unknown as { received: string }).received;
    expect(received).not.toMatch(/[<>:]/);
    expect(received.endsWith('.md')).toBe(true);
    expect(fs.written[0]).toEqual({ path: 'C:\\docs\\saved.md', content: '# hi' });
  });

  it('should append default extension when chosen path lacks one', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: 'C:\\docs\\noext' });
    const fs = makeFsMocks();
    const handlers = captureSaveAs(fs);

    await call(handlers, 'file.saveAs', { content: 'x', defaultName: 'notes.txt' });

    expect(fs.written[0]?.path).toBe('C:\\docs\\noext.txt');
  });
});
