/**
 * piWeb 域 IPC Handler 注册单元测试
 *
 * 验证 piWeb.launch / status / stop 三个通道：
 * - launch：成功返回 {ok, url, port}；launcher 抛错转为 IpcError(INTERNAL)
 * - status：透传 launcher 状态快照
 * - stop：调用 launcher.stop 并返回 {ok}
 * - dispose：调用 launcher.dispose
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@urchin/ipc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@urchin/ipc-contract')>();
  return {
    ...actual,
    registerHandler: (
      ipcMain: { handle: (channel: string, fn: unknown) => void },
      channel: string,
      fn: (req: unknown, ctx: unknown) => unknown,
    ) => {
      ipcMain.handle(channel, (event: unknown, rawReq: unknown) => fn(rawReq, { event }));
    },
  };
});

import { registerPiWebHandlers } from '../../src/main/pi-web/register-handlers';
import { IpcError } from '@urchin/ipc-contract';
import type { PiWebLauncher, PiWebStatusSnapshot } from '../../src/main/pi-web/launcher';
import type { IpcMainInvokeEvent } from 'electron';

function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    async invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null } as never, req);
    },
  };
}

function createMockLauncher(status: PiWebStatusSnapshot = { state: 'stopped' }) {
  return {
    launch: vi.fn(() => Promise.resolve(45001)),
    status: vi.fn(() => status),
    stop: vi.fn(() => Promise.resolve(undefined)),
    dispose: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as PiWebLauncher & {
    launch: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

describe('registerPiWebHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('piWeb.launch should return ok with url and port', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    registerPiWebHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWeb.launch', {})) as {
      ok: boolean;
      url: string;
      port: number;
    };
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://127.0.0.1:45001');
    expect(res.port).toBe(45001);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it('piWeb.launch should wrap launcher failure into IpcError', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    launcher.launch.mockRejectedValue(new Error('健康检查超时'));
    registerPiWebHandlers(ipcMain as never, launcher);

    const err: unknown = await ipcMain.invoke('piWeb.launch', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('INTERNAL');
    expect((err as IpcError).message).toContain('健康检查超时');
  });

  it('piWeb.status should pass through launcher snapshot', async () => {
    const ipcMain = createMockIpcMain();
    const snapshot: PiWebStatusSnapshot = {
      state: 'running',
      url: 'http://127.0.0.1:45001',
      port: 45001,
      pid: 1234,
    };
    const launcher = createMockLauncher(snapshot);
    registerPiWebHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWeb.status', {})) as PiWebStatusSnapshot;
    expect(res).toEqual(snapshot);
  });

  it('piWeb.stop should call launcher.stop and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    const { dispose } = registerPiWebHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWeb.stop', {})) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(launcher.stop).toHaveBeenCalledTimes(1);

    // dispose：app 退出清理路径
    dispose();
    expect(launcher.dispose).toHaveBeenCalledTimes(1);
  });
});
