/**
 * M20 Update Service（dev.114 提前落地）· 应用自动更新主进程服务
 *
 * 依据：用户指令「设置页：更新按钮接入发布版更新路径。检测到有新版本时，
 * 可以点击更新按钮更新项目」（2026-10-19）· 02-架构设计 §1 进程模型
 * （更新检查属主进程职责）
 *
 * 设计理由（AGENTS.md §七 三级注释）：
 * - 更新源 = GitHub Releases dev 预发布通道：electron-builder 打包时把
 *   dev.yml 更新清单（版本号 + 安装包 sha512）随 release 上传，
 *   electron-updater 以 semver 比较 app.getVersion()（package-win.mjs 从
 *   CHANGELOG 盖章 0.1.0-dev.NNN）判断有无新版本。仓库 PUBLIC，无需 token。
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
 * 0.1.0-dev.NNN 的预发布段 "dev" → electron-builder 生成 dev.yml，
 * electron-updater 的 channel 必须同为 "dev" 才能选到该清单。
 */
export const UPDATE_CHANNEL = 'dev';

/** electron-updater UpdateInfo 的结构子集（只取 UI 要展示的字段）。 */
export interface UpdaterUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
}

/**
 * electron-updater AppUpdater 的结构子集（测试注入 mock 的契约）。
 * 真实对象经 defaultCreateUpdater 动态 import 后断言而来。
 */
export interface UpdaterHandle {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  channel: string | null;
  checkForUpdates(): Promise<{ updateInfo: UpdaterUpdateInfo } | null>;
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

  /** 懒初始化更新器：配置手动确认制 + 通道 + 事件桥（只执行一次）。 */
  async function ensureUpdater(): Promise<UpdaterHandle> {
    if (updater) return updater;
    updaterPromise ??= (async () => {
      const factory = options.createUpdater ?? defaultCreateUpdater;
      const created = await factory();
      // 手动确认制：检查不自动下载；已下载则退出时自动安装（不白费流量）。
      created.autoDownload = false;
      created.autoInstallOnAppQuit = true;
      // dev 预发布通道：app 版本含预发布段时 electron-updater 默认
      // allowPrerelease=true，这里显式固定（防止版本形态变化后行为漂移）。
      created.allowPrerelease = true;
      created.channel = UPDATE_CHANNEL;

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
      log.info('updater ready', {
        channel: UPDATE_CHANNEL,
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
        const result = await u.checkForUpdates();
        checkedAt = new Date().toISOString();
        if (result == null) {
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
