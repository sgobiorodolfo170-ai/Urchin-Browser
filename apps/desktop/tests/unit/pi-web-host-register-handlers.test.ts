/**
 * piWebHost 域 IPC Handler 注册单元测试（阶段 2）
 *
 * 验证 piWebHost.launch / status / stop 三个通道：
 * - launch：成功返回 {ok, url, port}；launcher 抛错转为 IpcError(INTERNAL)
 * - launch：注册时使用加长 IPC 超时（>默认 30s，dev.111 同训的死路径修复）
 * - status：透传 launcher 状态快照
 * - stop / dispose：分别代理 launcher.stop / launcher.dispose
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

import { registerPiWebHostHandlers } from '../../src/main/pi-web-host/register-handlers';
import { IpcError } from '@urchin/ipc-contract';
import type {
  PiWebHostLauncher,
  PiWebHostStatusSnapshot,
} from '../../src/main/pi-web-host/launcher';
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

function createMockLauncher(status: PiWebHostStatusSnapshot = { state: 'stopped' }) {
  return {
    launch: vi.fn(() => Promise.resolve('http://127.0.0.1:47002/?token=tok')),
    status: vi.fn(() => status),
    stop: vi.fn(() => Promise.resolve(undefined)),
    dispose: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as PiWebHostLauncher & {
    launch: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

const READY_URL = 'http://127.0.0.1:47002/?token=tok';

describe('registerPiWebHostHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedOpts.clear();
  });

  it('piWebHost.launch should register with extended IPC timeout (override 30s default)', () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    registerPiWebHostHandlers(ipcMain as never, launcher);

    // 90s = 启动器上限 60s + 余量；必须 > 60s，否则负载下 IPC 先超时、
    // 渲染层放弃自动开标签（dev.111 同训）
    expect(mocks.capturedOpts.get('piWebHost.launch')?.timeoutMs).toBeGreaterThan(60_000);
    // 快操作保持默认 30s（不传 opts）
    expect(mocks.capturedOpts.get('piWebHost.status')).toBeUndefined();
    expect(mocks.capturedOpts.get('piWebHost.stop')).toBeUndefined();
  });

  it('piWebHost.launch should return ok with url and port', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    registerPiWebHostHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWebHost.launch', {})) as {
      ok: boolean;
      url: string;
      port: number;
    };
    expect(res.ok).toBe(true);
    expect(res.url).toBe(READY_URL);
    expect(res.port).toBe(47002);
    expect(launcher.launch).toHaveBeenCalledTimes(1);
  });

  it('piWebHost.launch should wrap launcher failure into IpcError(INTERNAL)', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    launcher.launch.mockRejectedValue(new Error('pi-web-host 启动超时（60s）'));
    registerPiWebHostHandlers(ipcMain as never, launcher);

    const err: unknown = await ipcMain.invoke('piWebHost.launch', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).code).toBe('INTERNAL');
    expect((err as IpcError).message).toContain('启动超时');
  });

  it('piWebHost.status should pass through launcher snapshot', async () => {
    const ipcMain = createMockIpcMain();
    const snapshot: PiWebHostStatusSnapshot = {
      state: 'running',
      url: READY_URL,
      port: 47002,
      pid: 7890,
    };
    const launcher = createMockLauncher(snapshot);
    registerPiWebHostHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWebHost.status', {})) as PiWebHostStatusSnapshot;
    expect(res).toEqual(snapshot);
  });

  it('piWebHost.stop should call launcher.stop and return ok; dispose calls launcher.dispose', async () => {
    const ipcMain = createMockIpcMain();
    const launcher = createMockLauncher();
    const { dispose } = registerPiWebHostHandlers(ipcMain as never, launcher);

    const res = (await ipcMain.invoke('piWebHost.stop', {})) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(launcher.stop).toHaveBeenCalledTimes(1);

    dispose();
    expect(launcher.dispose).toHaveBeenCalledTimes(1);
  });
});
