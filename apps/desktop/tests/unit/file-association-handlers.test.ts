/**
 * 文件关联 IPC handler（file-association.*）单元测试
 *
 * 验证：
 * 1. file-association.getStatus：返回三分组状态（注册数/总数/清单），
 *    经 mock regExec 判定已注册扩展名
 * 2. file-association.register：调用 reg.exe add 写入全部条目（注入 mock 计数）
 * 3. file-association.register：未知分组 → VALIDATION 错误
 * 4. file-association.register：reg.exe 失败 → INTERNAL 错误
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock electron：仅类型（register-handlers 不直接调用 electron API）──
vi.mock('electron', () => ({}));

import { registerFileAssociationHandlers } from '../../src/main/file-association/register-handlers';

interface RegCall {
  command: string;
  args: string[];
  cb: (err: Error | null, out: string) => void;
}

/** mock regExec：记录调用，按回调行为脚本响应。 */
function createMockReg(script: (cb: RegCall['cb']) => void): {
  calls: RegCall[];
  exec: (...a: unknown[]) => void;
} {
  const calls: RegCall[] = [];
  const exec = (...args: unknown[]) => {
    const [command, argv, , cb] = args as [string, string[], object, RegCall['cb']];
    calls.push({ command, args: argv, cb });
    script(cb);
  };
  return { calls, exec };
}

/** 捕获 registerHandler 注册的 wrapped handler。 */
function captureHandlers(exec: (...a: unknown[]) => void) {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('file-association.register', () => {
  it('should write registry entries for media group', async () => {
    const mock = createMockReg((cb) => cb(null, 'The operation completed successfully.'));
    const handlers = captureHandlers(mock.exec);

    const res = await call(handlers, 'file-association.register', { group: 'media' });

    expect(res).toMatchObject({ ok: true });
    const regRes = res as { ok: boolean; count: number };
    expect(regRes.count).toBeGreaterThan(0);
    expect(mock.calls.length).toBeGreaterThan(0);
    expect(mock.calls.every((c) => c.command === 'reg.exe' && c.args[0] === 'add')).toBe(true);
    // 覆盖 .mp3 与 .mp4（音视频分组代表）
    const argStrings = mock.calls.map((c) => c.args.join(' '));
    expect(argStrings.some((s) => s.includes('Software\\Classes\\.mp3'))).toBe(true);
    expect(argStrings.some((s) => s.includes('Software\\Classes\\.mp4'))).toBe(true);
    // open 命令含 exe 路径 + "%1"
    const command = argStrings.find((s) => s.includes('shell\\open\\command'));
    expect(command).toContain('"C:\\apps\\urchin.exe" "%1"');
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

describe('file-association.getStatus', () => {
  it('should report registered counts based on reg.exe query results', async () => {
    // query 成功且输出含 ProgID 才计为已注册
    const mock = createMockReg((cb) => cb(null, '    UrchinBrowser.mp3    REG_SZ    1'));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.getStatus', {})) as {
      groups: Record<string, { registered: number; total: number }>;
    };

    expect(res.groups.media).toBeDefined();
    expect(res.groups.media?.total).toBeGreaterThan(0);
    expect(res.groups.documents).toBeDefined();
    expect(res.groups.images).toBeDefined();
    // query 调用存在
    expect(mock.calls.some((c) => c.args[0] === 'query')).toBe(true);
  });

  it('should report 0 registered when query fails (key missing)', async () => {
    const mock = createMockReg((cb) => cb(new Error('file not found'), ''));
    const handlers = captureHandlers(mock.exec);

    const res = (await call(handlers, 'file-association.getStatus', {})) as {
      groups: Record<string, { registered: number }>;
    };

    for (const group of Object.values(res.groups)) {
      expect(group.registered).toBe(0);
    }
  });
});
