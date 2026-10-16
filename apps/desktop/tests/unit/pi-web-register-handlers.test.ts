/**
 * piWeb 域 IPC Handler 注册单元测试
 *
 * 验证 piWeb.launch / status / stop 三个通道：
 * - launch：成功返回 {ok, url, port}；launcher 抛错转为 IpcError(INTERNAL)
 * - launch：注册时使用加长 IPC 超时（覆盖默认 30s，见 dev.111 死路径修复）
 * - status：透传 launcher 状态快照
 * - stop：调用 launcher.stop 并返回 {ok}
 * - dispose：调用 launcher.dispose
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 捕获 registerHandler 第 4 参（opts），用于断言 per-channel 超时覆盖。
// vi.hoisted：vi.mock 工厂在静态 import 执行期运行，普通模块级变量此时处于 TDZ。
const mocks = vi.hoisted(() => ({
  capturedOpts: new Map<string, { timeoutMs?: number } | undefined>(),
}));

vi.mock('@urchin/ipc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@urchin/ipc-contract')>();
  return {
    ...actual,
    registerHandler: (
      ipcMain: { handle: (channel: string, fn: unknown) => void },
      channel: string,
      fn: (req: unknown, ctx: unknown) => unknown,
      opts?: { timeoutMs?: number },
    ) => {
      mocks.capturedOpts.set(channel, opts);
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
    mocks.capturedOpts.clear();
  });

  it('piWeb.launch should register with extended IPC timeout (override 30s default)', () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    registerPiWebHandlers(ipcMain as never, launcher);

    // 90s = 健康检查上限 60s + 余量；必须 > 60s，否则负载下 IPC 先超时、
    // 渲染层放弃自动开标签（dev.111 修复的死路径）
    expect(mocks.capturedOpts.get('piWeb.launch')?.timeoutMs).toBe(90_000);
    // 快操作保持默认 30s（不传 opts）
    expect(mocks.capturedOpts.get('piWeb.status')).toBeUndefined();
    expect(mocks.capturedOpts.get('piWeb.stop')).toBeUndefined();
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
