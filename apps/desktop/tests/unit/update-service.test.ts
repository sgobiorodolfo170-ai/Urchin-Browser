/**
 * M20 Update Service 单元测试（dev.114 提前落地，dev.115 双通道治理）
 *
 * 覆盖状态机全路径：
 * - disabled：未打包态 check/download/install 的守卫行为（不触网、不初始化更新器）
 * - 通道派生：dev 版本 → dev/prerelease；stable 版本 → latest/release
 * - check：dev 有更新 → available（不查 stable）；dev 无更新 → 查 stable；
 *   stable 404 → up-to-date（不闪 error）；无更新 → up-to-date；失败 → error
 * - 防降级：每次切通道后 allowDowngrade=false
 * - download：状态守卫（非 available 抛 IpcError STATE）→ downloading（进度推送）
 *   → downloaded（事件路径 + 兜底路径）
 * - install：状态守卫 → installing + quitAndInstall(false, true)（可见安装向导 + 装完拉起）
 * - 懒加载单例：多次操作只初始化一次更新器；初始化失败允许重试
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createUpdateService,
  resolveUpdateChannel,
  type UpdaterCheckResult,
  type UpdaterHandle,
  type UpdateServiceOptions,
} from '../../src/main/update/update-service';
import type { AtomGitRelease } from '../../src/main/update/update-source';
import { IpcError } from '@urchin/ipc-contract';
import type { UpdateState } from '@urchin/ipc-contract';

/** 构造 electron-updater 真实形状的「无更新」结果。 */
function noUpdate(version = '0.1.0-dev.113'): UpdaterCheckResult {
  return { isUpdateAvailable: false, updateInfo: { version } };
}

/** 构造 electron-updater 真实形状的「有更新」结果。 */
function updateAvailable(
  version: string,
  releaseName?: string,
  releaseNotes?: string,
): UpdaterCheckResult {
  return { isUpdateAvailable: true, updateInfo: { version, releaseName, releaseNotes } };
}

/** 可手动触发事件的 mock 更新器（真实 AppUpdater 的 EventEmitter 子集）。 */
function createMockUpdater(overrides: Partial<UpdaterHandle> = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const updater: UpdaterHandle = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: null,
    checkForUpdates: vi.fn(() => Promise.resolve(noUpdate())),
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

/** 按调用顺序返回结果的 checkForUpdates mock；Error 表示该次调用失败。 */
function sequenceCheck(...results: (UpdaterCheckResult | Error)[]) {
  let index = 0;
  return vi.fn(() => {
    const next = results[Math.min(index, results.length - 1)];
    index++;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? null);
  });
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

describe('resolveUpdateChannel', () => {
  it('should derive dev channel for prerelease versions', () => {
    expect(resolveUpdateChannel('0.2.0-dev.115')).toEqual({
      channel: 'dev',
      allowPrerelease: true,
    });
    expect(resolveUpdateChannel('1.0.0-beta.1')).toEqual({
      channel: 'beta',
      allowPrerelease: true,
    });
  });

  it('should derive latest channel for stable versions', () => {
    expect(resolveUpdateChannel('0.2.0')).toEqual({
      channel: 'latest',
      allowPrerelease: false,
    });
  });
});

describe('createUpdateService', () => {
  it('should report disabled and block all actions when not packaged', async () => {
    const { service, createUpdater } = setup({ isPackaged: false });

    expect(service.getState().status).toBe('disabled');
    expect((await service.check()).status).toBe('disabled');
    expect(createUpdater).not.toHaveBeenCalled();
    expect(() => service.download()).toThrow(IpcError);
    expect(() => service.install()).toThrow(IpcError);
  });

  it('should configure manual-confirm mode and keep dev channel when dev update exists', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: sequenceCheck(updateAvailable('0.1.0-dev.114')),
    });
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.channel).toBe('dev');
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('should not report an update when isUpdateAvailable is false for the same version', async () => {
    // 回归：electron-updater 无更新时返回非 null 的 { isUpdateAvailable: false }；
    // dev.114 曾误判为 available，测试 mock 返回 null 掩盖了该行为。
    const { updater } = createMockUpdater({
      checkForUpdates: sequenceCheck(noUpdate('0.1.0-dev.113')),
    });
    const { service, createUpdater } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('up-to-date');
    expect(state.latestVersion).toBeUndefined();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); // dev + stable fallback
  });

  it('should fall back to stable when dev has no update', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: sequenceCheck(
        noUpdate('0.1.0-dev.113'),
        updateAvailable('0.2.0', 'Urchin Browser v0.2.0', '正式版说明'),
      ),
    });
    const { service, createUpdater, events } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state).toMatchObject({
      status: 'available',
      currentVersion: '0.1.0-dev.113',
      latestVersion: '0.2.0',
      releaseName: 'Urchin Browser v0.2.0',
      releaseNotes: '正式版说明',
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.channel).toBe('latest');
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(events.map((e) => e.status)).toEqual(['checking', 'available']);
  });

  it('should treat missing stable release as up-to-date and suppress error event', async () => {
    const { updater, emit } = createMockUpdater();
    let calls = 0;
    updater.checkForUpdates = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve(noUpdate('0.1.0-dev.113'));
      // 首个 stable 发布前 GitHub /releases/latest 404；electron-updater 先发
      // error 事件再拒绝，应被两段检查抑制，不把 UI 打成 error。
      const error = new Error('ERR_UPDATER_LATEST_VERSION_NOT_FOUND');
      emit('error', error);
      return Promise.reject(error);
    });
    const { service, createUpdater, events } = setup();
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('up-to-date');
    expect(state.error).toBeUndefined();
    expect(events.some((e) => e.status === 'error')).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('should only query latest channel for stable current version', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: sequenceCheck(updateAvailable('0.1.1')),
    });
    const { service, createUpdater } = setup({ currentVersion: '0.1.0' });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(state.latestVersion).toBe('0.1.1');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.channel).toBe('latest');
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it('should return up-to-date for stable current version without update', async () => {
    const { updater } = createMockUpdater();
    const { service, createUpdater } = setup({ currentVersion: '0.2.0' });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('up-to-date');
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.channel).toBe('latest');
  });

  it('should return available state with release info when update exists', async () => {
    const { updater } = createMockUpdater({
      checkForUpdates: sequenceCheck(
        updateAvailable('0.1.0-dev.114', 'Urchin Browser v0.1.0-dev.114', '更新说明'),
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
      checkForUpdates: sequenceCheck(updateAvailable('0.1.0-dev.114')),
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
      checkForUpdates: sequenceCheck(updateAvailable('0.1.0-dev.114')),
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
      checkForUpdates: sequenceCheck(updateAvailable('0.1.0-dev.114')),
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
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});

describe('createUpdateService · 国内优先更新源', () => {
  const stableRelease: AtomGitRelease = {
    tag_name: 'v0.3.1',
    prerelease: false,
    created_at: '2026-11-18T10:00:00+08:00',
    assets: [{ name: 'latest.yml' }, { name: 'Urchin-Browser-0.3.1-x64.exe' }],
  };
  const devRelease: AtomGitRelease = {
    tag_name: 'v0.3.1-dev.2',
    prerelease: true,
    created_at: '2026-11-18T12:00:00+08:00',
    assets: [{ name: 'dev.yml' }, { name: 'Urchin-Browser-0.3.1-dev.2-x64.exe' }],
  };

  it('should use the domestic feed first when it has an update', async () => {
    const setFeedURL = vi.fn();
    const resetFeedURL = vi.fn();
    const { updater } = createMockUpdater({
      setFeedURL,
      resetFeedURL,
      checkForUpdates: sequenceCheck(updateAvailable('0.3.1')),
    });
    const fetchDomesticReleases = vi.fn(() => Promise.resolve([stableRelease]));
    const { service, createUpdater } = setup({
      currentVersion: '0.3.0',
      preferDomestic: true,
      fetchDomesticReleases,
    });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(state.latestVersion).toBe('0.3.1');
    expect(setFeedURL).toHaveBeenCalledWith(
      'https://atomgit.com/daichuanmu/Urchin-Browser/releases/download/v0.3.1',
    );
    expect(resetFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('should fall back to GitHub when the domestic mirror has no update', async () => {
    const setFeedURL = vi.fn();
    const resetFeedURL = vi.fn();
    const { updater } = createMockUpdater({
      setFeedURL,
      resetFeedURL,
      checkForUpdates: sequenceCheck(noUpdate('0.3.0'), updateAvailable('0.3.2')),
    });
    const fetchDomesticReleases = vi.fn(() => Promise.resolve([stableRelease]));
    const { service, createUpdater } = setup({
      currentVersion: '0.3.0',
      preferDomestic: true,
      fetchDomesticReleases,
    });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(state.latestVersion).toBe('0.3.2');
    expect(setFeedURL).toHaveBeenCalledTimes(1);
    expect(resetFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('should fall back to GitHub when the domestic feed check fails', async () => {
    const resetFeedURL = vi.fn();
    const { updater } = createMockUpdater({
      setFeedURL: vi.fn(),
      resetFeedURL,
      checkForUpdates: sequenceCheck(new Error('AtomGit 502'), updateAvailable('0.3.2')),
    });
    const { service, createUpdater } = setup({
      currentVersion: '0.3.0',
      preferDomestic: true,
      fetchDomesticReleases: () => Promise.resolve([stableRelease]),
    });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(resetFeedURL).toHaveBeenCalledTimes(1);
  });

  it('should use GitHub directly when the domestic release lookup fails', async () => {
    const setFeedURL = vi.fn();
    const { updater } = createMockUpdater({ setFeedURL });
    const { service, createUpdater } = setup({
      currentVersion: '0.3.0',
      preferDomestic: true,
      fetchDomesticReleases: () => Promise.reject(new Error('timeout')),
    });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('up-to-date');
    expect(setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('should keep the GitHub-only path when domestic preference is off', async () => {
    const fetchDomesticReleases = vi.fn(() => Promise.resolve([stableRelease]));
    const setFeedURL = vi.fn();
    const { updater } = createMockUpdater({ setFeedURL });
    const { service, createUpdater } = setup({
      currentVersion: '0.3.0',
      preferDomestic: false,
      fetchDomesticReleases,
    });
    createUpdater.mockResolvedValue(updater);

    await service.check();

    expect(fetchDomesticReleases).not.toHaveBeenCalled();
    expect(setFeedURL).not.toHaveBeenCalled();
  });

  it('should pick the domestic prerelease feed for dev builds', async () => {
    const setFeedURL = vi.fn();
    const { updater } = createMockUpdater({
      setFeedURL,
      resetFeedURL: vi.fn(),
      checkForUpdates: sequenceCheck(updateAvailable('0.3.1-dev.2')),
    });
    const { service, createUpdater } = setup({
      currentVersion: '0.3.1-dev.1',
      preferDomestic: true,
      fetchDomesticReleases: () => Promise.resolve([devRelease, stableRelease]),
    });
    createUpdater.mockResolvedValue(updater);

    const state = await service.check();

    expect(state.status).toBe('available');
    expect(setFeedURL).toHaveBeenCalledWith(
      'https://atomgit.com/daichuanmu/Urchin-Browser/releases/download/v0.3.1-dev.2',
    );
  });
});
