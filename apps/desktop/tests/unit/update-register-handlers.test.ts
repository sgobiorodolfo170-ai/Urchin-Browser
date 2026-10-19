/**
 * update 域 IPC Handler 注册单元测试（dev.114 提前落地）
 *
 * 验证 update.getState / check / download / install 四个通道：
 * - 四通道全部注册；check 使用加长 IPC 超时（GitHub 两跳网络，60s）
 * - getState / check / download 透传服务状态快照
 * - install 调用服务并返回 {ok: true}
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

import { registerUpdateHandlers } from '../../src/main/update/register-handlers';
import type { UpdateService } from '../../src/main/update/update-service';
import type { UpdateState } from '@urchin/ipc-contract';
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

const snapshot: UpdateState = {
  status: 'up-to-date',
  currentVersion: '0.1.0-dev.113',
};

function createMockService() {
  return {
    getState: vi.fn(() => snapshot),
    check: vi.fn(() => Promise.resolve(snapshot)),
    download: vi.fn(() => Promise.resolve(snapshot)),
    install: vi.fn(() => snapshot),
  } as unknown as UpdateService & {
    getState: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
  };
}

describe('registerUpdateHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capturedOpts.clear();
  });

  it('should register all four channels with extended timeout on check only', () => {
    const ipcMain = createMockIpcMain();
    registerUpdateHandlers(ipcMain as never, createMockService());

    // check = GitHub releases.atom + dev.yml 两跳网络，60s（> 默认 30s）；
    // 其余快操作保持默认（不传 opts）。
    expect(mocks.capturedOpts.get('update.check')?.timeoutMs).toBe(60_000);
    expect(mocks.capturedOpts.get('update.getState')).toBeUndefined();
    expect(mocks.capturedOpts.get('update.download')).toBeUndefined();
    expect(mocks.capturedOpts.get('update.install')).toBeUndefined();
  });

  it('should passthrough state snapshot for getState / check / download', async () => {
    const ipcMain = createMockIpcMain();
    const service = createMockService();
    registerUpdateHandlers(ipcMain as never, service);

    expect(await ipcMain.invoke('update.getState', {})).toEqual(snapshot);
    expect(await ipcMain.invoke('update.check', {})).toEqual(snapshot);
    expect(await ipcMain.invoke('update.download', {})).toEqual(snapshot);
    expect(service.getState).toHaveBeenCalledTimes(1);
    expect(service.check).toHaveBeenCalledTimes(1);
    expect(service.download).toHaveBeenCalledTimes(1);
  });

  it('should call install and return ok', async () => {
    const ipcMain = createMockIpcMain();
    const service = createMockService();
    registerUpdateHandlers(ipcMain as never, service);

    const res = (await ipcMain.invoke('update.install', {})) as { ok: boolean };
    expect(res).toEqual({ ok: true });
    expect(service.install).toHaveBeenCalledTimes(1);
  });
});
