/**
 * M20 Update Service（dev.114 提前落地，dev.115 双通道治理）· 应用自动更新主进程服务
 *
 * 依据：用户指令「设置页：更新按钮接入发布版更新路径。检测到有新版本时，
 * 可以点击更新按钮更新项目」（2026-10-19）· 02-架构设计 §1 进程模型
 * （更新检查属主进程职责）· ADR-012 发布通道与版本号治理
 *
 * 设计理由（AGENTS.md §七 三级注释）：
 * - 双通道：dev 预发布版本（X.Y.Z-dev.NNN）走 dev 通道 + dev.yml；正式版走
 *   latest 通道 + latest.yml。通道由 app.getVersion() 的版本形态派生，不依赖
 *   安装包内 app-update.yml 的静态值，避免打包通道与运行时判断漂移。
 * - dev → stable 迁移：electron-updater 6.8.9 的 GitHubProvider 在 channel=dev
 *   时只匹配 dev tag，不会选中 stable。因此 dev 版本先查 dev，无更新时再切
 *   latest 查 stable；首个 stable 发布前 /releases/latest 404 静默视为最新。
 * - 防降级：electron-updater 设置 channel 会自动把 allowDowngrade 置 true；
 *   每次切通道后显式设回 false，防止 0.3.0-dev.x 被降级到 0.2.0 stable。
 * - 懒加载：electron-updater 及其依赖只在第一次检查更新时 dynamic import，
 *   不给启动路径增加任何开销（与 dev.113 启动优化结论一致）。
 * - 手动确认制：autoDownload=false（检查时不偷偷下载 363MB 安装包），下载与
 *   安装在用户点击后进行；autoInstallOnAppQuit=true——已下载后即使用户不点
 *   「重启并安装」，正常退出应用时也会完成安装，避免下载白费。
 * - 全量注入（currentVersion/isPackaged/notify/createUpdater）：本文件不
 *   import electron，单测无需 mock electron 运行时；打包态由 index.ts 传入
 *   app.isPackaged。
 * - 开发态整体 disabled：E2E / 开发运行不触网；electron-updater 在未打包环境
 *   本身也不可用（readonly app-update.yml）。
 *
 * 第三方依赖：electron-updater ^6.8.9（MIT，Electron 生态标准更新库，与
 * electron-builder 26 同族）。本文件只用其稳定 API + 事件；类型级不 import
 * （结构子集 UpdaterHandle 对接，interop 容错见 defaultCreateUpdater）。
 */
import { createLogger } from '@urchin/logger';
import { IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import type { UpdateProgress, UpdateState, UpdateStatus } from '@urchin/ipc-contract';

const log = createLogger('update-service');

/** 状态变化推送通道（设置页 window.urchin.on('update:event') 订阅）。 */
export const UPDATE_EVENT_CHANNEL = 'update:event';

/**
 * 更新通道名。
 * - dev：X.Y.Z-dev.NNN 的预发布段 → electron-builder 生成 dev.yml；
 * - latest：正式版 → electron-builder 生成 latest.yml。
 */
export const DEV_CHANNEL = 'dev';
export const STABLE_CHANNEL = 'latest';

/** electron-updater UpdateInfo 的结构子集（只取 UI 要展示的字段）。 */
export interface UpdaterUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
}

/** electron-updater UpdateCheckResult 的结构子集（isUpdateAvailable 是判定真源）。 */
export interface UpdaterCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: UpdaterUpdateInfo;
}

/** 版本对应的通道配置。 */
export interface UpdateChannelInfo {
  channel: string;
  allowPrerelease: boolean;
}

/**
 * 从当前版本派生更新通道。
 * 预发布段首段即通道（dev.115 → dev；beta.1 → beta）；正式版 → latest。
 * 不读取 app-update.yml：运行时的通道语义以实际安装版本为准。
 */
export function resolveUpdateChannel(version: string): UpdateChannelInfo {
  const match = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?/.exec(version);
  const prerelease = match?.[1];
  if (!prerelease) {
    return { channel: STABLE_CHANNEL, allowPrerelease: false };
  }
  return {
    channel: prerelease.split('.')[0] ?? DEV_CHANNEL,
    allowPrerelease: true,
  };
}

/**
 * electron-updater AppUpdater 的结构子集（测试注入 mock 的契约）。
 * 真实对象经 defaultCreateUpdater 动态 import 后断言而来。
 */
export interface UpdaterHandle {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  checkForUpdates(): Promise<UpdaterCheckResult | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface UpdateServiceOptions {
  /** 当前安装版本（app.getVersion()，如 0.1.0-dev.113）。 */
  currentVersion: string;
  /** 是否打包态（false → 全部操作 disabled；app.isPackaged）。 */
  isPackaged: boolean;
  /** 状态快照广播（index.ts 接到 `update:event` 推送；progress 更新也会触发）。 */
  notify: (state: UpdateState) => void;
  /** 更新器工厂（默认真实 electron-updater；测试注入 mock）。 */
  createUpdater?: () => Promise<UpdaterHandle>;
}

export interface UpdateService {
  /** 读取当前状态快照（纯读，无副作用）。 */
  getState(): UpdateState;
  /** 检查更新（幂等：进行中/已下载/安装中时返回当前快照，不重复触网）。 */
  check(): Promise<UpdateState>;
  /** 开始下载（仅 available / downloading 可进入；进度经 notify 推送）。 */
  download(): Promise<UpdateState>;
  /** 退出应用并安装（仅 downloaded 可进入；同步返回，退出在 setImmediate 后）。 */
  install(): UpdateState;
}

/** 默认更新器工厂：动态 import electron-updater（懒加载 + CJS interop 容错）。 */
async function defaultCreateUpdater(): Promise<UpdaterHandle> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: UpdaterHandle;
    default?: { autoUpdater?: UpdaterHandle };
  };
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!updater) {
    throw new Error('electron-updater autoUpdater 导出缺失（模块 interop 失败）');
  }
  return updater;
}

/** 错误装箱为可读字符串（electron-updater 的 ErrnoException 也走 message）。 */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 非空字符串透传（releaseName / releaseNotes 可能是空串或结构化数组）。 */
function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 创建更新服务（闭包状态机；应用生命周期内单例）。 */
export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  let status: UpdateStatus = options.isPackaged ? 'idle' : 'disabled';
  let latestVersion: string | undefined;
  let releaseName: string | undefined;
  let releaseNotes: string | undefined;
  let progress: UpdateProgress | undefined;
  let error: string | undefined;
  let checkedAt: string | undefined;

  let updater: UpdaterHandle | null = null;
  let updaterPromise: Promise<UpdaterHandle> | null = null;
  // 两段检查期间 dev/stable 切换是预期行为；抑制 electron-updater 的 error
  // 事件，避免「dev 无更新 → stable 404」在 UI 上闪一次错误。
  let suppressErrorEvent = false;

  function snapshot(): UpdateState {
    return {
      status,
      currentVersion: options.currentVersion,
      latestVersion,
      releaseName,
      releaseNotes,
      progress,
      error,
      checkedAt,
    };
  }

  function emit(): void {
    options.notify(snapshot());
  }

  /** 读取当前状态（经函数读出，避开 TS 对闭包变量跨回调的陈旧收窄）。 */
  function currentStatus(): UpdateStatus {
    return status;
  }

  /** 变更状态并广播；返回快照便于 handler 直接作为响应。 */
  function setStatus(next: UpdateStatus): UpdateState {
    status = next;
    const snap = snapshot();
    log.info('update state', { status: next });
    emit();
    return snap;
  }

  /**
   * 应用通道配置。
   * 顺序不可交换：channel setter 会把 allowDowngrade 置 true，
   * 必须最后显式设回 false（防止 dev → stable 迁移时反向降级）。
   */
  function applyChannel(target: UpdaterHandle, info: UpdateChannelInfo): void {
    target.allowPrerelease = info.allowPrerelease;
    target.channel = info.channel;
    target.allowDowngrade = false;
  }

  /** 懒初始化更新器：配置手动确认制 + 事件桥（只执行一次）。 */
  async function ensureUpdater(): Promise<UpdaterHandle> {
    if (updater) return updater;
    updaterPromise ??= (async () => {
      const factory = options.createUpdater ?? defaultCreateUpdater;
      const created = await factory();
      // 手动确认制：检查不自动下载；已下载则退出时自动安装（不白费流量）。
      created.autoDownload = false;
      created.autoInstallOnAppQuit = true;

      created.on('download-progress', (p) => {
        const raw = p as Partial<UpdateProgress> | undefined;
        progress = {
          percent: raw?.percent ?? 0,
          transferred: raw?.transferred ?? 0,
          total: raw?.total ?? 0,
          bytesPerSecond: raw?.bytesPerSecond ?? 0,
        };
        if (status === 'downloading') emit();
      });
      created.on('update-downloaded', () => {
        if (status === 'downloading') setStatus('downloaded');
      });
      created.on('error', (e) => {
        // 两段检查的失败由 check() 的 Promise 路径统一处理；事件只作兜底，
        // 避免 dev→stable 的回退尝试在 UI 上闪错误。
        if (suppressErrorEvent) {
          log.info('updater error event suppressed during check', { error: toMessage(e) });
          return;
        }
        // 仅当有操作在进行中才落 error 态；check/download 的失败也有
        // Promise 拒绝路径（各自 catch 处理），此处兜底异步事件。
        if (status === 'checking' || status === 'downloading') {
          error = toMessage(e);
          checkedAt = new Date().toISOString();
          log.warn('updater error event', { error });
          setStatus('error');
        }
      });

      updater = created;
      const channelInfo = resolveUpdateChannel(options.currentVersion);
      log.info('updater ready', {
        channel: channelInfo.channel,
        allowPrerelease: channelInfo.allowPrerelease,
        currentVersion: options.currentVersion,
      });
      return created;
    })().catch((e: unknown) => {
      updaterPromise = null; // 失败允许下次重试初始化
      throw e;
    });
    return updaterPromise;
  }

  function check(): Promise<UpdateState> {
    // 不可并发检查；已下载/安装中不重查（避免丢掉 downloaded 态）；开发态直返。
    if (
      status === 'checking' ||
      status === 'downloading' ||
      status === 'downloaded' ||
      status === 'installing' ||
      status === 'disabled'
    ) {
      return Promise.resolve(snapshot());
    }
    setStatus('checking');
    return (async () => {
      try {
        const u = await ensureUpdater();
        const currentChannel = resolveUpdateChannel(options.currentVersion);
        let result: UpdaterCheckResult | null = null;

        // dev→stable 的两段检查是预期流程，抑制期间的 error 事件；
        // download 等后续操作不受影响（此时 suppressErrorEvent 已复位）。
        suppressErrorEvent = true;
        try {
          applyChannel(u, currentChannel);
          log.info('check channel', {
            channel: currentChannel.channel,
            allowPrerelease: currentChannel.allowPrerelease,
          });
          result = await u.checkForUpdates();

          if (!result?.isUpdateAvailable && currentChannel.allowPrerelease) {
            // dev 已确认无更新：再查 stable。允许 dev 用户迁移到正式版；
            // 首个 stable 发布前 /releases/latest 404，静默视为「暂无 stable」。
            log.info('no dev update; fallback to stable channel');
            applyChannel(u, { channel: STABLE_CHANNEL, allowPrerelease: false });
            try {
              result = await u.checkForUpdates();
            } catch (stableError) {
              log.info('stable channel unavailable; treat as up-to-date', {
                error: toMessage(stableError),
              });
              result = null;
            }
          }
        } finally {
          suppressErrorEvent = false;
        }

        checkedAt = new Date().toISOString();
        if (!result?.isUpdateAvailable) {
          // 无更新：清掉上一轮的新版本信息
          latestVersion = undefined;
          releaseName = undefined;
          releaseNotes = undefined;
          error = undefined;
          return setStatus('up-to-date');
        }
        const info = result.updateInfo;
        latestVersion = info.version;
        releaseName = pickString(info.releaseName);
        releaseNotes = pickString(info.releaseNotes);
        error = undefined;
        log.info('update available', { latestVersion });
        return setStatus('available');
      } catch (e) {
        error = toMessage(e);
        checkedAt = new Date().toISOString();
        log.warn('update check failed', { error });
        return setStatus('error');
      }
    })();
  }

  function download(): Promise<UpdateState> {
    if (status === 'downloading' || status === 'downloaded') {
      return Promise.resolve(snapshot());
    }
    if (status !== 'available') {
      throw new IpcError(IpcErrorCode.STATE, `当前状态不可下载更新（${status}）`, {
        channel: 'update.download',
      });
    }
    progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
    setStatus('downloading');
    return (async () => {
      try {
        const u = await ensureUpdater();
        await u.downloadUpdate();
        // 正常路径由 update-downloaded 事件置 downloaded；这里兜底事件缺失
        // （currentStatus 经函数读出——status 已被 setStatus/事件回调改写，
        // 直接比较会命中 TS 对闭包变量的陈旧收窄）。
        if (currentStatus() === 'downloading') setStatus('downloaded');
        return snapshot();
      } catch (e) {
        error = toMessage(e);
        log.warn('update download failed', { error });
        return setStatus('error');
      }
    })();
  }

  function install(): UpdateState {
    if (status !== 'downloaded') {
      throw new IpcError(IpcErrorCode.STATE, `当前状态不可安装更新（${status}）`, {
        channel: 'update.install',
      });
    }
    const snap = setStatus('installing');
    // setImmediate：先让 IPC 响应返回渲染层，再 quitAndInstall 触发退出安装
    // （isSilent=true 静默装、isForceRunAfter=true 装完自动拉起应用；
    // NSIS non-oneClick 沿用上次安装目录）。
    setImmediate(() => {
      try {
        updater?.quitAndInstall(true, true);
      } catch (e) {
        log.error('quitAndInstall failed', { error: toMessage(e) });
      }
    });
    return snap;
  }

  return { getState: snapshot, check, download, install };
}
