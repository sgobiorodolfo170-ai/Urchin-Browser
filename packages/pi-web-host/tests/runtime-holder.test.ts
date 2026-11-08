/**
 * model-admin/runtime-holder.ts 单元测试
 *
 * 懒加载工厂：按 agentDir 缓存、并发复用、失败不永久缓存、reset 清空。
 * `@earendil-works/pi-coding-agent` 为 vendored 包（vitest 不可解析），
 * 用 vi.mock 提供 ModelRuntime.create 桩。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: { create: createMock },
}));

import { createLazyModelRuntimeFactory } from '../src/model-admin/runtime-holder';

beforeEach(() => {
  createMock.mockReset();
});

describe('createLazyModelRuntimeFactory', () => {
  it('should create one runtime per agentDir and reuse it', async () => {
    const runtime = { id: 'rt' };
    createMock.mockResolvedValue(runtime);
    const factory = createLazyModelRuntimeFactory();

    const a = factory('/data/a');
    const b = factory('/data/a');
    expect(a).toBe(b);
    await expect(a).resolves.toBe(runtime);
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0]?.[0] as { authPath: string; modelsPath: string };
    expect(call.authPath).toContain('auth.json');
    expect(call.modelsPath).toContain('models.json');
  });

  it('should keep separate runtimes for different agentDirs', async () => {
    createMock.mockImplementation(() => Promise.resolve({ id: createMock.mock.calls.length }));
    const factory = createLazyModelRuntimeFactory();

    await factory('/data/a');
    await factory('/data/b');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('should drop a rejected entry so the next call retries', async () => {
    createMock.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({ id: 'ok' });
    const factory = createLazyModelRuntimeFactory();

    await expect(factory('/data/a')).rejects.toThrow('disk full');
    await expect(factory('/data/a')).resolves.toEqual({ id: 'ok' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('should clear the cache on reset()', async () => {
    createMock.mockResolvedValue({ id: 'rt' });
    const factory = createLazyModelRuntimeFactory();

    await factory('/data/a');
    factory.reset();
    await factory('/data/a');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
