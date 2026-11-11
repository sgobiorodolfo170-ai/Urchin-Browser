/**
 * 文件关联 IPC handler（file-association.*）单元测试
 *
 * 验证：
 * 1. getStatus：按 Capabilities\FileAssociations 汇总三组已登记数 + 应用级登记
 *    是否指向当前 exe（2 次 reg.exe 查询，与扩展名数量无关）
 * 2. register：写入应用级 + 扩展名条目（不含 `.ext` 默认值）、只写勾选项、
 *    空选择/未知分组 → VALIDATION、reg.exe 失败 → INTERNAL
 * 3. unregister：幂等删除（只删本应用项）
 * 4. setDefaultBrowser / openSettings：写能力键并唤起系统设置页
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({
  shell: { openExternal },
}));
openExternal.mockResolvedValue(undefined);

import { registerFileAssociationHandlers } from '../../src/main/file-association/register-handlers';
import type { FileAssociationHandlersDeps } from '../../src/main/file-association/register-handlers';

interface RegCall {
  command: string;
  args: string[];
  cb: (err: Error | null, out: string) => void;
}

/** mock regExec：记录调用，按回调行为脚本响应。 */
function createMockReg(script: (cb: RegCall['cb'], args: string[]) => void): {
  calls: RegCall[];
  exec: (...a: unknown[]) => void;
} {
  const calls: RegCall[] = [];
  const exec = (...args: unknown[]) => {
    const [command, argv, , cb] = args as [string, string[], object, RegCall['cb']];
    calls.push({ command, args: argv, cb });
    script(cb, argv);
  };
  return { calls, exec };
}

/** 捕获 registerHandler 注册的 wrapped handler。 */
function captureHandlers(
  exec: (...a: unknown[]) => void,
  extra: Partial<FileAssociationHandlersDeps> = {},
) {
  const handlers = new Map<string, (event: unknown, req: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
    removeHandler: () => undefined,
  };
  registerFileAssociationHandlers({
    ipcMain: ipcMain as never,
    exePath: 'C:\\apps\\urchin.exe',
    regExec: exec,
    ...extra,
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

const CAPABILITIES_STDOUT = [
  'HKEY_CURRENT_USER\\Software\\Clients\\StartMenuInternet\\UrchinBrowser\\Capabilities\\FileAssociations',
  '    .mp3    REG_SZ    UrchinBrowser.mp3',
  '    .mp4    REG_SZ    UrchinBrowser.mp4',
  '    .png    REG_SZ    UrchinBrowser.png',
  '',
].join('\r\n');

/** 状态查询脚本：Capabilities 返回扩展名清单，Applications 返回 open 命令。 */
function statusScript(command: string, cb: RegCall['cb']): void {
  if (command.includes('Applications')) {
    cb(null, `    (默认)    REG_SZ    "C:\\apps\\urchin.exe" "%1"`);
    return;
  }
  cb(null, CAPABILITIES_STDOUT);
}

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
});

describe('file-association.register', () => {
  it('should write app-level and extension entries for the media group', async () => {
    const mock = createMockReg((cb) => cb(null, 'The operation completed successfully.'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', { group: 'media' });

    expect(res).toMatchObject({ ok: true });
    const regRes = res as { ok: boolean; count: number };
    expect(regRes.count).toBeGreaterThan(0);
    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls.every((c) => c.command === 'reg.exe' && c.args[0] === 'add')).toBe(true);
    const argStrings = mock.calls.map((c) => c.args.join(' '));
    // 应用级登记（一次写全）
    expect(argStrings.some((s) => s.includes('Applications\\urchin.exe'))).toBe(true);
    // 扩展名 ProgID + OpenWithProgids + Capabilities 候选
    expect(argStrings.some((s) => s.includes('Classes\\UrchinBrowser.mp3'))).toBe(true);
    expect(argStrings.some((s) => s.includes('.mp3\\OpenWithProgids'))).toBe(true);
    expect(argStrings.some((s) => s.includes('Capabilities\\FileAssociations'))).toBe(true);
    // open 命令含 exe 路径 + "%1"
    const command = argStrings.find((s) => s.includes('shell\\open\\command'));
    expect(command).toContain('"C:\\apps\\urchin.exe" "%1"');
  });

  it('should NOT rewrite the .ext default value', async () => {
    // 回归：旧模型写 `add HKCU\Software\Classes\.mp3 /ve /d UrchinBrowser.mp3`，
    // 等于静默劫持系统关联且不可回滚。
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    await call(handlers, 'file-association.register', { group: 'media' });

    for (const ext of ['mp3', 'mp4', 'wav', 'flac']) {
      const wroteDefault = mock.calls.some(
        (c) => c.args[1] === `HKCU\\Software\\Classes\\.${ext}` && c.args.includes('/ve'),
      );
      expect(wroteDefault).toBe(false);
    }
  });

  it('should register only checked extensions', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', {
      group: 'media',
      extensions: ['mp3'],
    });

    expect(res).toMatchObject({ ok: true, count: 1 });
    const argStrings = mock.calls.map((c) => c.args.join(' '));
    expect(argStrings.some((s) => s.includes('Classes\\UrchinBrowser.mp3'))).toBe(true);
    expect(argStrings.some((s) => s.includes('Classes\\UrchinBrowser.mp4'))).toBe(false);
  });

  it('should reject empty selection with VALIDATION error', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', {
      group: 'media',
      extensions: [],
    });

    expect(res).toMatchObject({ code: 'VALIDATION' });
    expect(mock.calls.length).toBe(0);
  });

  it('should reject unknown group with VALIDATION error', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', { group: 'unknown' });

    expect(res).toMatchObject({ code: 'VALIDATION' });
    expect(mock.calls.length).toBe(0);
  });

  it('should return INTERNAL error when reg.exe fails', async () => {
    const mock = createMockReg((cb) => cb(new Error('Access denied'), ''));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', { group: 'images' });

    expect(res).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('file-association.unregister', () => {
  it('should delete only this app native values for the given group', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.unregister', {
      scope: 'extensions',
      group: 'images',
    })) as { ok: boolean; removed: number; attempted: number };

    expect(res.ok).toBe(true);
    expect(res.attempted).toBeGreaterThan(0);
    const argStrings = mock.calls.map((c) => c.args.join(' '));
    expect(argStrings.some((s) => s.startsWith('delete'))).toBe(true);
    // ProgID 键整体删除
    expect(
      argStrings.some((s) => s.includes('delete HKCU\\Software\\Classes\\UrchinBrowser.png')),
    ).toBe(true);
    // 不删除整个 .png 键（那是别的应用的登记）
    expect(argStrings.some((s) => s === 'delete HKCU\\Software\\Classes\\.png /f')).toBe(false);
  });

  it('should treat missing keys as success (idempotent cleanup)', async () => {
    // reg.exe 对不存在的键返回错误，清理流程不应因此中断或报错
    const mock = createMockReg((cb) => cb(new Error('unable to find'), ''));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.unregister', {
      scope: 'extensions',
      group: 'images',
    })) as { ok: boolean; removed: number };

    expect(res.ok).toBe(true);
    expect(res.removed).toBe(0);
  });

  it('should clear app-level entries when scope=app', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    await call(handlers, 'file-association.unregister', { scope: 'app' });

    const argStrings = mock.calls.map((c) => c.args.join(' '));
    expect(argStrings.some((s) => s.includes('Applications\\urchin.exe'))).toBe(true);
    expect(argStrings.some((s) => s.includes('StartMenuInternet\\UrchinBrowser'))).toBe(true);
  });
});

describe('file-association.setDefaultBrowser', () => {
  it('should write browser capability keys and open system settings', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.setDefaultBrowser', {});

    expect(res).toMatchObject({ ok: true, openedSettings: true });
    expect(openExternal).toHaveBeenCalledWith(
      'ms-settings:defaultapps?registeredAppUser=UrchinBrowser',
    );
    const argStrings = mock.calls.map((c) => c.args.join(' '));
    expect(argStrings.some((s) => s.includes('RegisteredApplications'))).toBe(true);
    expect(argStrings.some((s) => s.includes('URLAssociations'))).toBe(true);
    expect(argStrings.some((s) => s.includes('UrchinHTML'))).toBe(true);
  });

  it('should fall back to the overview page when the app-specific URI fails', async () => {
    openExternal.mockClear();
    openExternal.mockRejectedValueOnce(new Error('unsupported uri')).mockResolvedValue(undefined);
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.setDefaultBrowser', {});

    expect(res).toMatchObject({ ok: true, openedSettings: true });
    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      'ms-settings:defaultapps?registeredAppUser=UrchinBrowser',
    );
    expect(openExternal).toHaveBeenNthCalledWith(2, 'ms-settings:defaultapps');
  });
});

describe('file-association.openSettings', () => {
  it('should open the default apps page without writing the registry', async () => {
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.openSettings', {});

    expect(res).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith(
      'ms-settings:defaultapps?registeredAppUser=UrchinBrowser',
    );
    expect(mock.calls.length).toBe(0);
  });

  it('should report ok:false when every URI fails', async () => {
    openExternal.mockRejectedValue(new Error('no settings app'));
    const mock = createMockReg((cb) => cb(null, 'ok'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.openSettings', {});

    expect(res).toEqual({ ok: false });
  });
});

describe('file-association.getStatus', () => {
  it('should aggregate registered counts from Capabilities\\FileAssociations', async () => {
    const mock = createMockReg((cb, args) => statusScript(args.join(' '), cb));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.getStatus', {})) as {
      groups: Record<string, { registered: number; total: number; extensions: string[] }>;
      exePath: string;
      devMode: boolean;
      appRegistered: boolean;
      exeMatches: boolean;
    };

    // 3 个已登记 + 20 个文档 + 10 个图片 = 33 个 ...
    expect(res.groups.media?.registered).toBe(2); // mp3 / mp4（wav 等未登记）
    expect(res.groups.images?.registered).toBe(1); // png
    expect(res.groups.documents?.registered).toBe(0);
    expect(res.groups.media?.total).toBeGreaterThan(0);
    expect(res.exePath).toBe('C:\\apps\\urchin.exe');
    expect(res.devMode).toBe(false);
    expect(res.appRegistered).toBe(true);
    expect(res.exeMatches).toBe(true);
    // 2 次 query（Capabilities + Applications），与扩展名数量无关
    expect(mock.calls.filter((c) => c.args[0] === 'query')).toHaveLength(2);
  });

  it('should report 0 registered when query fails (key missing)', async () => {
    const mock = createMockReg((cb) => cb(new Error('file not found'), ''));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.getStatus', {})) as {
      groups: Record<string, { registered: number }>;
      appRegistered: boolean;
      exeMatches: boolean;
    };

    for (const group of Object.values(res.groups)) {
      expect(group.registered).toBe(0);
    }
    expect(res.appRegistered).toBe(false);
    expect(res.exeMatches).toBe(false);
  });

  it('should flag stale registrations pointing at another exe', async () => {
    const mock = createMockReg((cb, args) => {
      if (args.join(' ').includes('Applications')) {
        cb(null, `    (默认)    REG_SZ    "D:\\old\\urchin.exe" "%1"`);
        return;
      }
      cb(null, CAPABILITIES_STDOUT);
    });
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.getStatus', {})) as {
      appRegistered: boolean;
      exeMatches: boolean;
    };

    expect(res.appRegistered).toBe(true);
    expect(res.exeMatches).toBe(false);
  });

  it('should expose devMode when launch args are present', async () => {
    const mock = createMockReg((cb, args) => statusScript(args.join(' '), cb));
    const handlers = captureHandlers(mock.exec, { launchArgs: ['C:\\app'] });

    const res = (await call(handlers, 'file-association.getStatus', {})) as { devMode: boolean };

    expect(res.devMode).toBe(true);
  });
});
