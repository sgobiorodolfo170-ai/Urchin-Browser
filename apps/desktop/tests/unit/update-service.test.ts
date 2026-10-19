/**
 * M20 Update Service 单元测试（dev.114 提前落地）
 *
 * 覆盖状态机全路径：
 * - disabled：未打包态 check/download/install 的守卫行为（不触网、不初始化更新器）
 * - check：无更新 → up-to-date；有更新 → available（版本/标题/说明透传）；失败 → error
 * - download：状态守卫（非 available 抛 IpcError STATE）→ downloading（进度推送）
 *   → downloaded（事件路径 + 兜底路径）
 * - install：状态守卫 → installing + quitAndInstall(true, true)（静默装 + 装完拉起）
 * - 懒加载单例：多次操作只初始化一次更新器；初始化失败允许重试
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createUpdateService,
  UPDATE_CHANNEL,
  type UpdaterHandle,
  type UpdateServiceOptions,
} from '../../src/main/update/update-service';
import { IpcError } from '@urchin/ipc-contract';
import type { UpdateState } from '@urchin/ipc-contract';

/** 可手动触发事件的 mock 更新器（真实 AppUpdater 的 EventEmitter 子集）。 */
function createMockUpdater(overrides: Partial<UpdaterHandle> = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const updater: UpdaterHandle = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    channel: null,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve(undefined)),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return updater;
    }),
    ...overrides,
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  return { updater, emit };
}

/** 组装服务 + 事件收集 + 更新器工厂 spy。 */
function setup(options: Partial<UpdateServiceOptions> = {}) {
  const events: UpdateState[] = [];
  const createUpdater = vi.fn<() => Promise<UpdaterHandle>>();
  const service = createUpdateService({
    currentVersion: '0.1.0-dev.113',
    isPackaged: true,
    notify: (s) => events.push(s),
    createUpdater,
    ...options,
  });
  return { service, events, createUpdater };
}

/** flush 到 setImmediate 队列（install 的 quitAndInstall 在 setImmediate 中调用）。 */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createUpdateService', () => {
  it('should report disabled and block all actions when not packaged', async () => {
    const { service, createUpdater } = setup({ isPackaged: false });

    expect(service.getState().status).toBe('disabled');
    expect((await service.check()).status).toBe('disabled');
    expect(createUpdater).not.toHaveBeenCalled();
    expect(() => service.download()).toThrow(IpcError);
    expect(() => service.install()).toThrow(IpcError);
  });

  it('should configure updater for dev channel and manual-confirm mode', async () => {
    const { updater } = createMockUpdater();
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('up-to-date');
    // 手动确认制 + dev 预发布通道（与 electron-builder 生成的 dev.yml 匹配）
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.channel).toBe(UPDATE_CHANNEL);
  });

  it('should return available state with release info when update exists', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: vi.fn(() =>
        Promise.resolve({
          updateInfo: {
            version: '0.1.0-dev.114',
            releaseName: 'Urchin Browser v0.1.0-dev.114',
            releaseNotes: '更新说明',
          },
        }),
      ),
    });
    const { service, createUpdater, events } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state).toMatchObject({
      status: 'available',
      currentVersion: '0.1.0-dev.113',
      latestVersion: '0.1.0-dev.114',
      releaseName: 'Urchin Browser v0.1.0-dev.114',
      releaseNotes: '更新说明',
    });
    expect(state.checkedAt).toBeTruthy();
    // 状态变化已广播（checking → available）
    expect(events.map((e) => e.status)).toEqual(['checking', 'available']);
  });

  it('should enter error state when check fails', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: vi.fn(() => Promise.reject(new Error('CHANNEL_FILE_NOT_FOUND: dev.yml'))),
    });
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('error');
    expect(state.error).toContain('CHANNEL_FILE_NOT_FOUND');
  });

  it('should enter error state when updater factory fails and allow retry', async () => {
    const { service, createUpdater } = setup();
    createUpdater.mockRejectedValue(new Error('module not found'));

    expect((await service.check()).status).toBe('error');
    // 初始化失败不缓存：下一次 check 会再试一次工厂
    await service.check();
    expect(createUpdater).toHaveBeenCalledTimes(2);
  });

  it('should reuse a single updater instance across operations (lazy singleton)', async () => {
    const { updater } = createMockUpdater();
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    await service.check();
    await service.check();

    expect(createUpdater).toHaveBeenCalledTimes(1);
  });

  it('should reject download unless an update is available', () => {
    const { service } = setup();
    expect(() => service.download()).toThrow(IpcError);
    let thrown: unknown;
    try {
      void service.download();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IpcError);
    expect((thrown as IpcError).code).toBe('STATE');
  });

  it('should stream progress while downloading and finish via update-downloaded event', async () => {
    let resolveDownload: (() => void) | undefined;
    const { updater, emit } = createMockUpdater({
      checkForUpdates: vi.fn(() => Promise.resolve({ updateInfo: { version: '0.1.0-dev.114' } })),
      downloadUpdate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = resolve;
          }),
      ),
    });
    const { service, createUpdater, events } = setup();
    createUpdater.mockResolvedValue(updater);

    await service.check();
    const downloading = service.download();
    await Promise.resolve(); // 让 ensureUpdater 完成，进入 downloadUpdate 挂起
    expect(service.getState().status).toBe('downloading');

    emit('download-progress', {
      percent: 42,
      transferred: 42_000,
      total: 100_000,
      bytesPerSecond: 1024,
    });
    expect(service.getState().progress).toEqual({
      percent: 42,
      transferred: 42_000,
      total: 100_000,
      bytesPerSecond: 1024,
    });
    expect(events.at(-1)?.status).toBe('downloading');

    // 事件路径：update-downloaded 先到，downloadUpdate 随后 resolve
    emit('update-downloaded');
    expect(service.getState().status).toBe('downloaded');
    resolveDownload?.();
    await downloading;
    expect(service.getState().status).toBe('downloaded');
  });

  it('should fall back to downloaded when downloadUpdate resolves without event', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: vi.fn(() => Promise.resolve({ updateInfo: { version: '0.1.0-dev.114' } })),
      downloadUpdate: vi.fn(() => Promise.resolve(undefined)),
    });
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    await service.check();
    const state = await service.download();

    expect(state.status).toBe('downloaded');
  });

  it('should reject install unless downloaded', () => {
    const { service } = setup();
    expect(() => service.install()).toThrow(IpcError);
  });

  it('should quit and install silently with force relaunch after downloaded', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: vi.fn(() => Promise.resolve({ updateInfo: { version: '0.1.0-dev.114' } })),
      downloadUpdate: vi.fn(() => Promise.resolve(undefined)),
    });
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    await service.check();
    await service.download();
    const state = service.install();

    expect(state.status).toBe('installing');
    expect(updater.quitAndInstall).not.toHaveBeenCalled(); // setImmediate 前不退出
    await flushImmediate();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
