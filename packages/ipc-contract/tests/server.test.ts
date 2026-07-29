/**
 * registerHandler 单元测试。
 * 用 mock ipcMain 验证：入参校验、出参校验、超时、异常装箱。
 */
import { describe, it, expect } from 'vitest';
import { registerHandler, IpcError, IpcErrorCode, type IpcMainInvokeEvent } from '../src/index';

/** Mock ipcMain 实现。event 类型与 IpcMainLike.handle 对齐（IpcMainInvokeEvent）。 */
function createMockIpcMain() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>>();
  return {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, req: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
    invoke(channel: string, req: unknown): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) return Promise.reject(new Error(`no handler for ${channel}`));
      // mock event.sender 满足 IpcMainInvokeEvent 最小契约
      return fn({ sender: null }, req);
    },
  };
}

describe('registerHandler', () => {
  it('should parse req and res successfully', async () => {
    const ipcMain = createMockIpcMain();
    registerHandler(ipcMain, 'tab.create', (req) =>
      Promise.resolve({
        tab: {
          id: 1,
          windowId: req.windowId,
          url: req.url,
          title: '',
          active: true,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          crashed: false,
          indexInWindow: 0,
        },
      }),
    );

    const result = (await ipcMain.invoke('tab.create', { windowId: 1, url: 'https://x' })) as {
      tab: { id: number };
    };
    expect(result.tab.id).toBe(1);
  });

  it('should return VALIDATION error for bad req', async () => {
    const ipcMain = createMockIpcMain();
    // handler 故意返回不完整 res；此处验证 req 校验失败，handler 实际不会执行到返回。
    // as never 表明：明知违反静态类型，用于测试运行时校验逻辑。
    registerHandler(ipcMain, 'tab.create', () => Promise.resolve({ tab: {} } as never));

    const result = (await ipcMain.invoke('tab.create', {})) as { code: string; message: string };
    expect(result.code).toBe(IpcErrorCode.VALIDATION);
    expect(result.message).toContain('入参校验失败');
  });

  it('should return INTERNAL error when handler throws', async () => {
    const ipcMain = createMockIpcMain();
    registerHandler(ipcMain, 'tab.create', () => {
      throw new Error('boom');
    });

    const result = (await ipcMain.invoke('tab.create', { windowId: 1 })) as {
      code: string;
      message: string;
    };
    expect(result.code).toBe(IpcErrorCode.INTERNAL);
    expect(result.message).toBe('boom');
  });

  it('should return INTERNAL error when res fails validation', async () => {
    const ipcMain = createMockIpcMain();
    // handler 故意返回类型错误的 res，验证运行时出参校验。as never 绕过静态检查。
    registerHandler(ipcMain, 'tab.create', () =>
      Promise.resolve({ tab: { id: 'not-a-number' } } as never),
    );

    const result = (await ipcMain.invoke('tab.create', { windowId: 1 })) as {
      code: string;
      message: string;
    };
    expect(result.code).toBe(IpcErrorCode.INTERNAL);
    expect(result.message).toContain('出参校验失败');
  });

  it('should return TIMEOUT error when handler exceeds timeout', async () => {
    const ipcMain = createMockIpcMain();
    // handler 返回不完整 res 无所谓，此用例验证超时，handler 不会执行到返回。
    registerHandler(
      ipcMain,
      'tab.create',
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { tab: { id: 1, windowId: 1, url: 'https://x' } } as never;
      },
      { timeoutMs: 50 },
    );

    const result = (await ipcMain.invoke('tab.create', { windowId: 1 })) as {
      code: string;
      retryable: boolean;
    };
    expect(result.code).toBe(IpcErrorCode.TIMEOUT);
    expect(result.retryable).toBe(true);
  });

  it('should propagate IpcError thrown by handler', async () => {
    const ipcMain = createMockIpcMain();
    registerHandler(ipcMain, 'tab.close', () => {
      throw new IpcError(IpcErrorCode.NOT_FOUND, 'tab not found', { channel: 'tab.close' });
    });

    const result = (await ipcMain.invoke('tab.close', { tabId: 999 })) as {
      code: string;
      message: string;
      channel: string;
    };
    expect(result.code).toBe(IpcErrorCode.NOT_FOUND);
    expect(result.message).toBe('tab not found');
    expect(result.channel).toBe('tab.close');
  });

  it('should support unregister', async () => {
    const ipcMain = createMockIpcMain();
    const reg = registerHandler(ipcMain, 'tab.list', () => Promise.resolve({ tabs: [] }));
    await expect(ipcMain.invoke('tab.list', {})).resolves.toMatchObject({ tabs: [] });
    reg.unregister();
    await expect(ipcMain.invoke('tab.list', {})).rejects.toThrow('no handler');
  });
});
