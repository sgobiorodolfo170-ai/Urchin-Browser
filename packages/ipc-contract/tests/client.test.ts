/**
 * typedInvoke 客户端单元测试。
 */
import { describe, it, expect } from 'vitest';
import { createTypedInvoke, IpcErrorCode } from '../src/index';

function createMockRenderer() {
  const invocations: { channel: string; req: unknown }[] = [];
  let nextResponse: unknown = undefined;
  return {
    invoke(channel: string, req: unknown): Promise<unknown> {
      invocations.push({ channel, req });
      return Promise.resolve(nextResponse);
    },
    setNextResponse(v: unknown) {
      nextResponse = v;
    },
    invocations,
  };
}

describe('typedInvoke', () => {
  it('should send typed req and parse res', async () => {
    const renderer = createMockRenderer();
    renderer.setNextResponse({
      tab: {
        id: 1,
        windowId: 1,
        url: 'https://x',
        title: '',
        active: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        indexInWindow: 0,
      },
    });
    const invoke = createTypedInvoke(renderer);

    const result = await invoke('tab.create', { windowId: 1, url: 'https://x' });
    expect(result.tab.id).toBe(1);
    expect(renderer.invocations[0]?.channel).toBe('tab.create');
  });

  it('should throw IpcError when Main returns error payload', async () => {
    const renderer = createMockRenderer();
    renderer.setNextResponse({
      code: IpcErrorCode.NOT_FOUND,
      message: 'tab not found',
      channel: 'tab.close',
      retryable: false,
    });
    const invoke = createTypedInvoke(renderer);

    await expect(invoke('tab.close', { tabId: 999 })).rejects.toMatchObject({
      code: IpcErrorCode.NOT_FOUND,
      message: 'tab not found',
    });
  });

  it('should throw when res fails validation', async () => {
    const renderer = createMockRenderer();
    renderer.setNextResponse({ tab: { id: 'bad' } });
    const invoke = createTypedInvoke(renderer);

    // req { windowId: 1 } 合法（url/active 有默认值），mock 返回非法 res 触发出参校验失败
    await expect(invoke('tab.create', { windowId: 1 })).rejects.toThrow();
  });

  it('should throw when req fails validation', async () => {
    const renderer = createMockRenderer();
    const invoke = createTypedInvoke(renderer);

    await expect(
      // @ts-expect-error 故意传错类型测试运行时校验
      invoke('tab.create', { windowId: 'bad' }),
    ).rejects.toThrow();
  });
});
