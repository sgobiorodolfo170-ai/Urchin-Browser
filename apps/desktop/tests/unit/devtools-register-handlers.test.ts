/**
 * devtools 域 IPC Handler 注册单元测试（M15）。
 *
 * 验证（实施规划 §10.1）：
 * - attach/detach/status 透传 manager 返回
 * - network.list / console.list 透传
 * - evaluate 透传 awaitPromise 参数与异步结果
 * - clear 推送 cleared 事件（manager 内部已测，此处验证 handler 接线）
 *
 * 风格对齐 deepseek-harness-register-handlers.test.ts（mock registerHandler）。
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

import { registerDevtoolsHandlers } from '../../src/main/devtools/register-handlers';
import type { DevtoolsManager } from '../../src/main/devtools/devtools-manager';
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

function createMockManager() {
  return {
    attach: vi.fn((tabId: number) => ({ state: 'attached', target: { tabId, title: 'X' } })),
    detach: vi.fn(() => ({ ok: true as const })),
    status: vi.fn(() => ({ state: 'attached' })),
    listNetwork: vi.fn(() => ({ entries: [], dropped: 0 })),
    clearNetwork: vi.fn(() => ({ ok: true as const })),
    listConsole: vi.fn(() => ({ entries: [], dropped: 0 })),
    clearConsole: vi.fn(() => ({ ok: true as const })),
    evaluate: vi.fn(() => Promise.resolve({ ok: true, result: 42 })),
    dispose: vi.fn(),
  } as unknown as DevtoolsManager & {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    listNetwork: ReturnType<typeof vi.fn>;
    clearNetwork: ReturnType<typeof vi.fn>;
    listConsole: ReturnType<typeof vi.fn>;
    clearConsole: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
  };
}

describe('registerDevtoolsHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should route devtools.attach to manager.attach', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    const res = await ipcMain.invoke('devtools.attach', { tabId: 1 });
    expect(manager.attach).toHaveBeenCalledWith(1);
    expect(res).toEqual({ state: 'attached', target: { tabId: 1, title: 'X' } });
  });

  it('should route devtools.detach to manager.detach', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    const res = (await ipcMain.invoke('devtools.detach', { tabId: 2 })) as { ok: boolean };
    expect(manager.detach).toHaveBeenCalledWith(2);
    expect(res.ok).toBe(true);
  });

  it('should route devtools.status to manager.status', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    await ipcMain.invoke('devtools.status', { tabId: 3 });
    expect(manager.status).toHaveBeenCalledWith(3);
  });

  it('should route devtools.network.list to manager.listNetwork', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    const res = (await ipcMain.invoke('devtools.network.list', { tabId: 4 })) as {
      entries: unknown[];
      dropped: number;
    };
    expect(manager.listNetwork).toHaveBeenCalledWith(4);
    expect(res.entries).toEqual([]);
    expect(res.dropped).toBe(0);
  });

  it('should route devtools.network.clear to manager.clearNetwork', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    await ipcMain.invoke('devtools.network.clear', { tabId: 5 });
    expect(manager.clearNetwork).toHaveBeenCalledWith(5);
  });

  it('should route devtools.console.list to manager.listConsole', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    await ipcMain.invoke('devtools.console.list', { tabId: 6 });
    expect(manager.listConsole).toHaveBeenCalledWith(6);
  });

  it('should route devtools.console.clear to manager.clearConsole', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    await ipcMain.invoke('devtools.console.clear', { tabId: 7 });
    expect(manager.clearConsole).toHaveBeenCalledWith(7);
  });

  it('should route devtools.evaluate with awaitPromise', async () => {
    const ipcMain = createMockIpcMain();
    const manager = createMockManager();
    registerDevtoolsHandlers(ipcMain as never, manager);
    const res = (await ipcMain.invoke('devtools.evaluate', {
      tabId: 8,
      expression: 'fetch("/x")',
      awaitPromise: true,
    })) as { ok: boolean; result: number };
    expect(manager.evaluate).toHaveBeenCalledWith(8, 'fetch("/x")', true);
    expect(res.ok).toBe(true);
    expect(res.result).toBe(42);
  });
});
