/**
 * Urchin Browser · 主进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / §6 启动顺序 / 04-模块全景 M1/M2/M17/M18
 * 职责（v0.1 W1-D3）：
 * 1. 初始化 WindowManager（M1 Window Lifecycle）
 * 2. 初始化 TabManager（M2 Tab Manager）
 * 3. 创建主窗口（M18 sandbox + contextIsolation + preload）
 * 4. 注册 IPC handlers（M17 tab + window 域）
 * 5. 应用生命周期事件（单实例锁 / activate / window-all-closed）
 *
 * 后续 wave 在此基础上叠加 M3/M5-M10/M23 完整实现。
 */
// Polyfill 必须在所有其他模块之前加载：undici 顶层 require node:worker_threads
// 并解构 markAsUncloneable（Node 22.3+ 才有），Electron 32/Node 20 缺失会导致启动崩溃。
import './polyfills/worker-threads-polyfill';
import { app, nativeTheme, screen, session, dialog } from 'electron';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createLogger } from '@urchin/logger';

import {
  PROVIDER_EVENT_CHANNEL,
  DEVTOOLS_TOGGLE_CHANNEL,
  type ProviderEvent,
} from '@urchin/ipc-contract';
import {
  WindowManager,
  createBrowserWindow,
  loadWindowState,
  trackWindowState,
  type CreateWindowOptions,
} from './windows';
import {
  TabManager,
  createBrowserView,
  installTabViewIntegration,
  getLayoutState,
  WINDOW_FRAME_WIDTH,
  type BrowserViewLike,
} from './tabs';
import { HistoryManager, type HistoryPersistence } from './history';
import { BookmarkManager, type BookmarkPersistence } from './bookmarks';
import { initStartupLog, markStartup } from './startup-log';
import { SettingsManager } from './settings';
import { DownloadManager } from './downloads';
import type { ProviderConfigStore } from './ai';
import { parseOpenArgs } from './file-association';
import { classifyFileKind } from './files';
import {
  buildDirViewerUrl,
  buildFileViewerUrl,
  buildGenOfficeUrl,
  isGenOfficeEditable,
  resolveOpenTarget,
} from '../shared/file-routing';
import { Orchestrator } from './orchestrator/orchestrator';
import { ProviderRegistry } from './orchestrator/provider-registry';
import { electronProcessFactory } from './orchestrator/electron-factory';
import {
  StorageLayer,
  loadSqliteFactory,
  ElectronSafeStorage,
  type DatabaseFactory,
} from './storage';
import { abortOnSqliteLoadFailure } from './bootstrap/native-module-guard';
import { registerUrchinSchemePrivileged, registerUrchinProtocol } from './protocol';
import { FaviconService } from './favicons/favicon-service';
import { getGenOfficeSchemePrivileges } from './genoffice/loader';
import { currentThemeBackground } from './theme';
import { BookmarkPanel } from './panel/bookmark-panel';
import { StatusBarOverlay, type StatusBarHostWindow } from './status-bar/status-bar-overlay';
import { StatusBarBall, type StatusBarBallHostWindow } from './status-bar/status-bar-ball';
import { SelectionCardOverlay } from './translate/selection-card-overlay';
import type { SelectionRect } from './translate/selection-rect';
import { TrayManager } from './tray';
import { displayNameForLocale } from '../shared/brand';
import {
  resolveDataLocation,
  setDataLocation,
  migrateLegacyPiData,
  PI_DIR_NAME,
} from './storage/data-location';
import { installWillDownload, installWillDownloadForSession } from './downloads/will-download';
import {
  WorkspaceRegistry,
  WorkspaceSessionManager,
  type WorkspacePersistence,
} from './workspaces';
import { createMhtmlView } from './clipper/mhtml-viewer';
import { installTabContextMenu, handleContextMenu } from './context-menu';
import { installZoomControl, applyZoomByDelta } from './zoom';
import { installDragInjection, type TransitDragData } from './transit/drag-injection';
import { resolvePortableUserData } from './portable';
import { installDevtoolsShortcuts } from './devtools';
import type { AppContext } from './bootstrap/app-context';
import { installEventLoopWatchdog } from './bootstrap/watchdog';
import { runCleanupAndExit } from './lifecycle/cleanup';
import { registerIpcHandlers } from './bootstrap/handlers';
import { installSignalHandlers } from './lifecycle/signals';
import { initLogFile } from './logs';

const log = createLogger('main');

// 品牌 exe 的 isPackaged 纠正（`pnpm start` 经 scripts/electron-binary.mjs 复制
// electron.exe → UrchinBrowser.exe 并注入应用图标，见该脚本注释）：
// Electron 以可执行文件名判定是否已打包（非 electron.exe 即 true）。改名后
// GenOffice 会去 process.resourcesPath/genoffice 找产物、数据目录等也会走打包
// 分支。dev 默认应用（process.defaultApp=true）下把字段纠正回 false，保持与
// 原 electron.exe 完全一致的运行时语义；真正打包的 exe（defaultApp=false）不受影响。
if (
  process.platform === 'win32' &&
  process.defaultApp &&
  basename(process.execPath).toLowerCase() !== 'electron.exe'
) {
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
}

/** 书签表行结构（SQLite 存储格式，snake_case） */
interface BookmarkRow {
  id: string;
  parent_id: string | null;
  url: string | null;
  title: string;
  favicon: string | null;
  type: string;
  position: number;
  created_at: number;
  updated_at: number;
}

/** 历史记录表行结构（SQLite 存储格式，snake_case） */
interface HistoryRow {
  id: number;
  url: string;
  title: string | null;
  favicon: string | null;
  visited_at: number;
  visit_count: number;
}

// E2E 测试隔离：若指定 URCHIN_TEST_USER_DATA，覆盖 userData 路径，确保每次测试使用全新 SQLite 数据库
// 必须在 any app.getPath('userData') 调用前执行
if (process.env.URCHIN_TEST_USER_DATA) {
  app.setPath('userData', process.env.URCHIN_TEST_USER_DATA);
}

// 便携版隔离（2026-08-19，DD 决策）：exe 同级存在 portable.dat 时，把 userData
// 重定向到 exe 旁的 userdata 目录——zip 分发到任意机器都是全新档案，不读取/不写
// 本机 %APPDATA% 既有用户数据。必须在 any app.getPath('userData') 调用前执行。
const portableUserData = resolvePortableUserData(process.execPath);
if (portableUserData) {
  app.setPath('userData', portableUserData);
}

// 启动耗时打点初始化（启动优化 B5 诊断）：<userData>/logs/startup.log，从本行起可打点
initStartupLog(app.getPath('userData'));
markStartup('main:boot');

// 单例锁：防止多实例打开（02-架构设计 §1.2）。
// 位置提前到数据目录解析/迁移、scheme 注册（含 GenOffice 嵌入包加载）与管理器构造之前——
// 重复双击时第二实例在完成这些重活前即退出，避免慢盘上再重走一遍完整冷启动。
// 必须在便携版 userData 重定向之后（单例锁按 userData 身份建立），且不依赖任何后续初始化。
// E2E 测试环境（PLAYWRIGHT）跳过单实例锁，避免与 Playwright loader 冲突
// dev.193 整改 R5：锁丢失时仅 app.quit() 不够——顶层同步代码与 whenReady 回调
// 仍会继续跑（startup.log 实测 7 次 lock-lost 的批次照样 window-created），
// 造成多实例争用同一 DSH_HOME / 随机端口。这里记录标志，并在 whenReady 入口二次拦截。
let singleInstanceLockAcquired = true;
if (!process.env.PLAYWRIGHT) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    singleInstanceLockAcquired = false;
    markStartup('main:lock-lost');
    app.quit();
  } else {
    markStartup('main:lock-acquired');
  }
}

// 数据目录解析（DD1 决策，提前到 app ready 前）：
// - dataDir = 用户个人数据目录（可配置，书签/历史/设置/摘要/截图/下载/网页保存）。
//   默认位置：开发模式 <软件根目录>/data（apps/desktop/data）；打包后软件根为只读
//   app.asar，默认改落 <userData>/data（修复新装机无指针时启动崩溃；data.directory
//   设置仍可改，指针落 userData/data-location.json，含迁移标记时本次启动先整体复制迁移）。
// - piDir   = pi(AI) 数据目录（固定 userData/pi，不可配置，与用户数据隔离）
// 顺序：先把旧 userData/data 中的 pi 数据挪入 userData/pi，再整体迁移默认目录，
// 避免旧 ai.db 被带进新默认数据目录（pi 隔离破坏）。
export const startupUserDataPath = app.getPath('userData');
migrateLegacyPiData(startupUserDataPath);
// 默认数据目录：打包后落 <userData>/data；开发模式落软件根目录 data（apps/desktop/data）。
// 测试可通过 URCHIN_TEST_DATA_DIR 覆盖（与 URCHIN_TEST_USER_DATA 配套），
// 让需要隔离设置库的 E2E 不再共享 apps/desktop/data（避免卡片模式等设置残留）。
const testDataDir = process.env.URCHIN_TEST_DATA_DIR;
const defaultDataRoot = testDataDir ?? (app.isPackaged ? startupUserDataPath : app.getAppPath());
// 当前生效的用户数据目录（DD1 决策；app ready 前解析，供截图等按数据目录
// 落盘的功能读取）。app.setPath('sessionData') 必须在 app ready 之前调用，
// 而 sessionData 目标依赖数据目录。启动后经 AppContext 传递（ctx.currentDataDir）。
const currentDataDir = resolveDataLocation(startupUserDataPath, defaultDataRoot);

// cookies 及网页存储（sessionData：cookies / localStorage / IndexedDB / service worker 等）
// 重定向到 <数据目录>/cookies（必须在 app ready 之前调用，否则不生效）。
// 注意：切换后旧 cookies 不会迁移（旧登录态失效，需重新登录一次）。
app.setPath('sessionData', join(currentDataDir, 'cookies'));
markStartup('main:data-dir');

// 运行日志落盘（2026-11-07 用户指令：设置 → 运行日志；位置跟随数据目录）。
// 放在数据目录解析之后、各管理器构造之前，使启动早期错误（协议注册、GenOffice
// 嵌入包加载等）也能进入日志文件。后续所有 createLogger 输出自动双写。
initLogFile(join(currentDataDir, 'logs'));

// 注册 urchin: scheme 为特权协议（必须在 app ready 之前）。
// 阶段 2：GenOffice 编辑器渲染页（genoffice-app:）等特权 scheme 由嵌入包导出，
// 经此并入同一次 registerSchemesAsPrivileged 调用（Electron 每进程仅允许一次）。
// 产物缺失时 getGenOfficeSchemePrivileges 返回空数组，浏览器本体不受影响。
// 调试/降级开关 URCHIN_DISABLE_GENOFFICE=1：整体跳过 GenOffice 集成（含嵌入包
// 加载），用于隔离「嵌入层影响启动内存/行为」类问题。
export const GENOFFICE_DISABLED = process.env.URCHIN_DISABLE_GENOFFICE === '1';
registerUrchinSchemePrivileged(GENOFFICE_DISABLED ? [] : getGenOfficeSchemePrivileges());
markStartup('main:scheme-privileged');

// GPU 硬件加速（2026-08-17 恢复）：
// 曾全局禁用（disableHardwareAcceleration）以规避 LiveKernelEvent 0x1CC
// （GPU 引擎超时 TDR → 桌面卡死，诱因：MuMu 虚拟适配器 + NVIDIA + Intel
// 三卡混合环境偶发选中异常 GPU 路径）。代价是所有网页走 SwiftShader CPU
// 软件渲染，打开重页面明显卡顿。经用户决策（2026-08-17）恢复硬件加速，
// 若 TDR 桌面卡死复发，再回到禁用方案或改用指定 GPU 后端（如 --use-angle=d3d11）。

// stdout/stderr 写失败兜底（2026-08-17 卡死根因修复）：
// 后台/管道启动时，若下游不读（或渲染进程 console 被 ELECTRON_ENABLE_LOGGING 灌入），
// 管道缓冲满 → 每次写触发 EPIPE 错误事件 → 错误风暴 → 主进程 100% CPU 卡死。
// 挂 error 监听吞掉 EPIPE，避免事件循环被错误事件占死。
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return; // 下游关闭，静默
  console.error('stdout error', err);
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return;
});

// 事件循环阻塞 watchdog（自 bootstrap/watchdog.ts，原位调用保持启动时序）
installEventLoopWatchdog();

/**
 * 全局 WindowManager 实例（M1）。
 *
 * 设计理由（AGENTS.md §七.2）：
 * 单例管理所有窗口，保证 windowId 分配的全局唯一性。
 * 通过工厂函数注入，使核心逻辑可测试。
 */
const windowManager = new WindowManager(createBrowserWindow);

/**
 * 全局 TabManager 实例（M2）。
 *
 * 设计理由（契约 D §2 / AGENTS.md §七.2）：
 * 单例管理所有 tab，保证 tabId 分配的全局唯一性。
 * 主进程是 Single Source of Truth，渲染层 store 只是镜像。
 * 通过工厂函数注入，使核心逻辑可测试。
 *
 * TP7 工作区：工厂按标签的工作区 id 解析 session（自定义工作区 = 持久化分区）。
 * ctx.workspaceSessions 在 whenReady 内初始化——首个标签在 whenReady 完成前不会创建，
 * 因此闭包运行时该绑定恒已就绪；未就绪兜底走默认 session。
 */
const tabManager = new TabManager((workspaceId) =>
  createBrowserView(
    workspaceId,
    ctx.workspaceSessions
      ? (id) => ctx.workspaceSessions.resolve(id)
      : () => session.defaultSession,
  ),
);

/**
 * 全局应用上下文：把 performCleanup / registerIpcHandlers 闭包引用的可变
 * 状态打包成显式对象（docs/refactor-plan-p2.md §1.2），后续拆分到独立文件
 * 时只移动函数体并传入 ctx。字段语义与初始化时序见 bootstrap/app-context.ts。
 *
 * ctx.historyManager 等 8 个字段原先为 `let x!: T`（确信赋值断言），在
 * whenReady 内才初始化；这里以同样的断言方式初始化，保持「使用方信任
 * 初始化顺序」的原语义不变。
 */
const ctx: AppContext = {
  windowManager,
  tabManager,
  currentDataDir,
  historyManager: undefined as unknown as HistoryManager,
  bookmarkManager: undefined as unknown as BookmarkManager,
  faviconService: undefined,
  settingsManager: undefined as unknown as SettingsManager,
  workspaceRegistry: undefined as unknown as WorkspaceRegistry,
  workspaceSessions: undefined as unknown as WorkspaceSessionManager,
  providerRegistry: undefined as unknown as ProviderRegistry,
  orchestrator: undefined as unknown as Orchestrator,
  providerConfigStore: undefined as unknown as ProviderConfigStore,
  tabViewIntegration: null,
  disposeContextMenu: null,
  disposeZoomControl: null,
  disposeDragInjection: null,
  disposeTranslateManager: null,
  translateManagerRef: null,
  disposeDevtoolsManager: null,
  disposeDevtoolsShortcuts: null,
  genofficeIntegration: null,
  genofficeHomeStore: null,
  bookmarkPanel: null,
  bookmarkPickerContext: null,
  statusBarOverlay: null,
  statusBarBall: null,
  selectionCardOverlay: null,
  trayManager: null,
  aiHandlersDispose: null,
  dshLauncher: null,
  unbindDshTabClose: null,
  piWebHostLauncher: null,
  storageLayer: null,
  mailContentStore: null,
  isCleaningUp: false,
  cleanupDone: false,
};

/**
 * 记录「最近打开」（GenOffice Home 的最近列表，单一存储 genoffice-home.json）。
 *
 * 范围：只有 GenOffice 能编辑的扩展名才记（`isGenOfficeEditable`，ADR-021 FA6/FA8）——
 * 脚本/配置类（.js/.sh/.ps1/.css…）虽然能在 GenOffice 源码视图里打开，但不进
 * 「最近」，否则列表会被临时脚本塞满。GenOffice 将来支持图片/音视频编辑器时，
 * 只需在能力表追加扩展名，这里自动跟随。
 *
 * 失败不阻塞打开（recents 属辅助信息）。
 */
function recordRecentIfEditable(path: string): void {
  if (!isGenOfficeEditable(path)) return;
  const store = ctx.genofficeHomeStore;
  if (!store) return;
  void store.recordRecent(path).catch(() => undefined);
}

/**
 * 打开本地文件（Windows 文件关联 / 命令行启动 / GenOffice Home 打开动作）。
 *
 * 路由口径见 [ADR-021](../../docs/decisions/ADR-021-打开文件职责划分.md) FA4：
 * **分界线是入口不是格式**——
 * - 外部入口（文件关联 / 命令行 / Ctrl+O / 拖放）：浏览器通道；
 *   唯一例外是 Office 三类（docx/pptx/xlsx）直进 GenOffice 编辑器；
 * - GenOffice 主页入口走 `openInGenOffice`（能力表驱动）。
 *
 * 通道：mhtml → 只读视图；html → file:// 网页标签；genoffice → 编辑器视图
 * （产物缺失自动回落 viewer）；其余 → 内置查看器（媒体/图片也在查看器内联
 * 渲染，file-resource 协议流式 + Range，可上/下一个切换、失败有外部打开出口）。
 *
 * @returns true = 已受理（含回落路径）；false = 路由异常（已记日志）
 */
export function routeLocalFile(windowId: number, path: string): boolean {
  try {
    const name = basename(path);
    const kind = classifyFileKind(name);
    const target = resolveOpenTarget(kind, name, 'external');

    if (target.channel === 'mhtml') {
      // MHTML：只读查看器（禁用 JS、无 preload），不进入 GenOffice 文本编辑器。
      const view = createMhtmlView(path, {
        openUrl: (targetUrl) => {
          if (/^https?:\/\//i.test(targetUrl)) {
            tabManager.create({ windowId, url: targetUrl, active: true });
          }
        },
        backgroundColor: currentThemeBackground(),
        autoLoad: false,
      });
      tabManager.create({
        windowId,
        url: pathToFileURL(path).toString(),
        active: true,
        // P2-7：createMhtmlView 返回真实 BrowserView，BrowserViewLike 已按
        // Electron 索引类型定义（等价 Pick），结构化直接赋值，无需逃逸。
        view,
      });
      log.info('open local mhtml (reader)', { path });
      return true;
    }

    if (target.channel === 'genoffice' && ctx.genofficeIntegration) {
      const resolved = ctx.genofficeIntegration.resolveTabCreate(
        buildGenOfficeUrl(target.app, path),
      );
      tabManager.create({
        windowId,
        url: resolved.url,
        active: true,
        ...(resolved.view
          ? { view: resolved.view as BrowserViewLike, viewKind: resolved.viewKind }
          : {}),
        ...(resolved.viewKind === 'genoffice' ? { genofficeKind: resolved.genofficeKind } : {}),
      });
      // resolveTabCreate 在产物缺失/创建失败时已回落到 viewer/file 地址——
      // 仍算「GenOffice 能编辑的格式」，recents 照记（用户预期的文档列表）。
      recordRecentIfEditable(path);
      log.info('open local file (genoffice)', { kind, path });
      return true;
    }

    if (target.channel === 'browser') {
      // html：作为普通网页在标签里直开（浏览器的本职），不进查看器内嵌 iframe
      // （相对资源解析有问题）。用 pathToFileURL 编码，文件名含 # / ? 不会被截断。
      tabManager.create({ windowId, url: pathToFileURL(path).toString(), active: true });
      recordRecentIfEditable(path);
      log.info('open local html as web page', { kind, path });
      return true;
    }

    // viewer（含 GenOffice 集成缺失时的回落）
    tabManager.create({ windowId, url: buildFileViewerUrl(path), active: true });
    recordRecentIfEditable(path);
    log.info('open local file (viewer)', { kind, path });
    return true;
  } catch (err) {
    log.warn('failed to open local file', { path, error: String(err) });
    return false;
  }
}

/**
 * 统一打开入口（渲染层 Ctrl+O / 侧栏按钮 / 拖放 → `file.openPath`）。
 *
 * 与 `routeLocalFile` 的分工：本函数先判目录（目录 → 目录浏览页），再交给
 * 文件路由；渲染层因此不需要自己 `file.stat` 判类型、也不需要拼标签 URL——
 * 路由只有主进程一份实现（ADR-021 FA5）。
 *
 * @returns true = 已受理；false = 路径不存在或路由异常
 */
export async function openLocalEntry(
  windowId: number,
  path: string,
  origin: 'external' | 'genoffice' = 'external',
): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      tabManager.create({ windowId, url: buildDirViewerUrl(path), active: true });
      log.info('open local directory', { path });
      return true;
    }
  } catch {
    // stat 失败（不存在/无权限）：交给路由走既有失败路径（记日志 + 返回 false）
  }
  return origin === 'genoffice' ? openInGenOffice(windowId, path) : routeLocalFile(windowId, path);
}

/**
 * 在 GenOffice 中打开（GenOffice 主页：文档目录 / 最近 / 收藏 / 「打开本地文件」）。
 *
 * 与 `routeLocalFile` 的差别是**能力表驱动**（ADR-021 FA5/FA7）：只要 GenOffice
 * 能编辑（md/pdf/html/txt/json/csv/docx/pptx/xlsx…）就进编辑器；其余
 * （图片/音视频/二进制/脚本）转交浏览器通道，做到「不拒绝、不静默」。
 *
 * @returns true = 已受理（含转交浏览器通道）
 */
export function openInGenOffice(windowId: number, path: string): boolean {
  try {
    const name = basename(path);
    const kind = classifyFileKind(name);
    const target = resolveOpenTarget(kind, name, 'genoffice');
    if (target.channel === 'genoffice' && ctx.genofficeIntegration) {
      const resolved = ctx.genofficeIntegration.resolveTabCreate(
        buildGenOfficeUrl(target.app, path),
      );
      if (resolved.viewKind === 'genoffice') {
        tabManager.create({
          windowId,
          url: resolved.url,
          active: true,
          ...(resolved.view ? { view: resolved.view as BrowserViewLike } : {}),
          viewKind: 'genoffice',
          ...(resolved.genofficeKind ? { genofficeKind: resolved.genofficeKind } : {}),
        });
        recordRecentIfEditable(path);
        log.info('open local file in genoffice (home)', { kind, path });
        return true;
      }
    }
    // GenOffice 打不开 / 产物缺失 / 未启用 → 浏览器通道（同一套外部路由）
    log.info('genoffice cannot open — handing over to browser channel', { kind, path });
    return routeLocalFile(windowId, path);
  } catch (err) {
    log.warn('failed to open local file in genoffice', { path, error: String(err) });
    return false;
  }
}

/**
 * 处理命令行打开请求（Windows 文件关联 / 默认浏览器启动，首启与第二实例共用）。
 *
 * - URL：首条复用当前激活标签（保持「热启动」语义），其余新开标签
 * - 文件：逐个 routeLocalFile（资源管理器多选文件一次启动 → 多标签）
 * - 失败：routeLocalFile 返回 false 时弹系统错误框——文件关联场景下用户
 *   没有浏览器窗口上下文，静默失败会表现为「双击没反应」
 *
 * appPath 必须传 `app.getAppPath()`：开发/生产模式由 `electron <appDir>` 启动，
 * argv[1] 是应用目录而不是用户文件（见 parseOpenArgs 注释）。
 *
 * @returns 已受理的请求数（0 = 命令行里没有可打开的内容）
 */
function openFromCommandLine(windowId: number, argv: readonly string[]): number {
  const { urls, files } = parseOpenArgs(argv, app.getAppPath());
  let opened = 0;

  urls.forEach((url, index) => {
    if (index === 0) {
      const active = tabManager.query({ windowId }).find((tab) => tab.active);
      if (active) {
        tabManager.loadUrl(active.id, url);
        opened += 1;
        return;
      }
    }
    tabManager.create({ windowId, url, active: true });
    opened += 1;
  });

  for (const file of files) {
    if (routeLocalFile(windowId, file)) {
      opened += 1;
    } else {
      // 失败可见化：文件关联启动时窗口可能刚创建，静默失败无法排查
      try {
        dialog.showErrorBox('无法打开文件', `无法用本浏览器打开该文件：\n${file}`);
      } catch {
        /* 对话框不可用时保持静默（已写日志） */
      }
    }
  }

  return opened;
}

/**
 * 托盘菜单「完全退出」（2026-11-10 用户需求）。
 *
 * 与窗口 X 一致：先对存在未保存内容的 GenOffice 编辑器逐窗口确认
 * （保存 / 不保存 / 取消），任一取消则保持驻留、不退出；全部通过后
 * app.quit() 走统一清理流程（before-quit → performCleanup）。
 */
async function requestQuitFromTray(): Promise<void> {
  const dirtyWindows = ctx.windowManager
    .getAllWindows()
    .filter((managed) =>
      ctx.tabManager
        .query({ windowId: managed.id })
        .some((tab) => tab.viewKind === 'genoffice' && tab.dirty),
    );
  if (dirtyWindows.length > 0 && ctx.genofficeIntegration) {
    // 先唤回主窗口：脏文档确认对话框以窗口为 parent，窗口隐藏时对话框可能
    // 不可见，用户会以为点击「完全退出」没反应。
    ctx.trayManager?.showMainWindow();
    for (const managed of dirtyWindows) {
      const ok = await ctx.genofficeIntegration.confirmWindowClose(managed.id);
      if (!ok) return;
    }
  }
  app.quit();
}

/**
 * 全局 DownloadManager 实例（M23）。
 * v0.1 W2 基础实现：下载项状态管理 + 进度跟踪。
 */
export const downloadManager = new DownloadManager();

/** 向主窗口渲染层发事件（划词结果卡等；窗口动态解析，无窗口时静默丢弃） */
export function sendToMainWindow(channel: string, payload: unknown): void {
  const entry = windowManager.getAllWindows()[0];
  try {
    entry?.browserWindow.webContents?.send(channel, payload);
  } catch (err) {
    log.warn('send to main window failed', { channel, error: String(err) });
  }
}

/**
 * 处理网页 dragstart 数据（路径 B / urchin://transit-drag 协议回调）。
 *
 * - text → 写 md 文档到 documents/<yyyyMMdd-HHmmss>.md，格式：选中文字 + 元信息
 * - link → 写 md 文档，格式：# {链接文本}\n\n{url}\n\n> 来源：{页面URL} | {时间}
 * - image/video → 不写 md，直接传 URL 到主窗口 transit:add
 *
 * md 文档生成后同样通过 sendToMainWindow('transit:add') 推送到主窗口中转区。
 */
function handleTransitDragData(
  data: TransitDragData,
  dataDir: string,
  send: (channel: string, payload: unknown) => void,
): void {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const isoTime = now.toISOString();

  if (data.kind === 'text' && data.text) {
    const docsDir = join(dataDir, 'documents');
    try {
      mkdirSync(docsDir, { recursive: true });
    } catch (err) {
      log.warn('transit-drag: failed to ensure documents dir', { error: String(err) });
    }
    const filePath = join(docsDir, `transit-${stamp}.md`);
    const content = `${data.text}\n\n> 来源：${data.pageUrl} | ${data.pageTitle} | ${isoTime}`;
    try {
      writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      log.warn('transit-drag: failed to write md doc', { error: String(err) });
    }
    send('transit:add', {
      kind: 'text',
      title: data.title,
      text: data.text,
      mdDocPath: filePath,
      sourceApp: 'webview',
    });
  } else if (data.kind === 'link' && data.url) {
    const docsDir = join(dataDir, 'documents');
    try {
      mkdirSync(docsDir, { recursive: true });
    } catch (err) {
      log.warn('transit-drag: failed to ensure documents dir', { error: String(err) });
    }
    const filePath = join(docsDir, `transit-${stamp}.md`);
    const linkText = data.linkText ?? data.title;
    const content = `# ${linkText}\n\n${data.url}\n\n> 来源：${data.pageUrl} | ${isoTime}`;
    try {
      writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      log.warn('transit-drag: failed to write md doc', { error: String(err) });
    }
    send('transit:add', {
      kind: 'text',
      title: data.title,
      text: content,
      mdDocPath: filePath,
      sourceApp: 'webview',
    });
  } else if (data.kind === 'image' && data.url) {
    send('transit:add', {
      kind: 'screenshot',
      title: data.title,
      url: data.url,
      sourceApp: 'webview',
    });
  } else if (data.kind === 'video' && data.url) {
    send('transit:add', {
      kind: 'video',
      title: data.title,
      url: data.url,
      sourceApp: 'webview',
    });
  }
}

/**
 * 下发悬浮球配置（主题 + 上下/左右灵敏度）给球窗口。
 * 灵敏度从 ctx.settingsManager 读取，设置变更或状态同步时调用。
 */
export function sendBallConfig(): void {
  if (!ctx.statusBarBall) return;
  const v = ctx.settingsManager.get('ui.statusBall.sensitivityVertical');
  const h = ctx.settingsManager.get('ui.statusBall.sensitivityHorizontal');
  const theme = (ctx.settingsManager.get('theme') as 'light' | 'dark' | undefined) ?? 'light';
  const sensitivityVertical =
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0.1, Math.min(5, v)) : 1;
  const sensitivityHorizontal =
    typeof h === 'number' && Number.isFinite(h) ? Math.max(0.1, Math.min(5, h)) : 1;
  ctx.statusBarBall.sendConfig({ theme, sensitivityVertical, sensitivityHorizontal });
}

/**
 * 滚动活跃网页（悬浮球拖动调用）。
 * dx/dy 为像素位移，正值向右/向下。在页面上下文执行 window.scrollBy。
 */
export function scrollActivePage(dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  try {
    const entry = windowManager.getAllWindows()[0];
    if (!entry) return;
    const active = tabManager.query({ windowId: entry.id }).find((t) => t.active);
    const tab = active ? tabManager.getTab(active.id) : undefined;
    // P2-7：executeJavaScript 已在 WebContentsLike（必选成员），无需逃逸回 Electron 类型
    tab?.webContents
      .executeJavaScript(`window.scrollBy(${Math.round(dx)}, ${Math.round(dy)});`, true)
      ?.catch(() => undefined);
  } catch (err) {
    log.warn('scroll active page failed', { error: String(err) });
  }
}

/**
 * 向所有窗口的渲染进程广播 Provider 事件（W5-D4）。
 *
 * crash 事件需要推送到 UI 显示 warning banner，
 * 状态变更用于刷新 Provider 列表状态。
 */
function broadcastProviderEvent(event: ProviderEvent): void {
  const windows = windowManager.getAllWindows();
  for (const win of windows) {
    try {
      win.browserWindow.webContents.send(PROVIDER_EVENT_CHANNEL, event);
    } catch (err) {
      log.warn('failed to broadcast provider event', {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 确保内置 Provider 已部署到 userData/providers 目录。
 *
 * 内置 OpenAI 兼容 Provider 支持 OpenAI / Azure OpenAI / Ollama / vLLM 等
 * 兼容 /v1/chat/completions 端点的服务。通过 config.baseUrl 自定义端点。
 *
 * 如果 provider 目录已存在则跳过（不覆盖用户修改）。
 */
function ensureBuiltinProviders(providersDir: string): void {
  // OpenAI 兼容 Provider
  const openaiDir = join(providersDir, 'openai-compatible');
  const openaiManifest = join(openaiDir, 'manifest.json');
  if (!existsSync(openaiManifest)) {
    mkdirSync(openaiDir, { recursive: true });
    writeFileSync(
      join(openaiDir, 'manifest.json'),
      JSON.stringify(
        {
          id: 'openai-compatible',
          name: 'OpenAI Compatible',
          version: '1.0.0',
          apiVersion: 'urchin-ai-provider/v1',
          capabilities: ['chat.completion', 'chat.completion.streaming'],
          authMethod: 'api_key',
          rateLimit: { requestsPerMin: 60 },
        },
        null,
        2,
      ),
      'utf-8',
    );
    // 从构建产物复制 Provider 子进程代码（源码在 src/main/orchestrator/providers/openai-compatible.ts，
    // 由 build:provider 脚本用 esbuild 编译到 dist/providers/openai-compatible.js）
    const builtProviderPath = join(__dirname, '..', 'providers', 'openai-compatible.js');
    if (existsSync(builtProviderPath)) {
      const providerCode = readFileSync(builtProviderPath, 'utf-8');
      writeFileSync(join(openaiDir, 'index.js'), providerCode, 'utf-8');
      log.info('built-in openai-compatible provider deployed', { dir: openaiDir, source: 'dist' });
    } else {
      log.error('built-in provider not found in dist, AI will be unavailable', {
        expectedPath: builtProviderPath,
      });
    }
  }
}

// 应用就绪
// Windows 应用用户模型 ID（任务栏分组 / 通知 / 跳转列表身份）。与
// electron-builder.yml 的 appId 保持一致；必须在创建窗口前设置。
if (process.platform === 'win32') app.setAppUserModelId('com.urchin.browser');
// 模块顶层初始化完成（scheme/lock/data-dir 均就绪；等待 app ready）
markStartup('main:module-top-done');

void app.whenReady().then(async () => {
  // dev.193 整改 R5：第二实例 app.quit() 已请求退出，但 ready 事件仍可能触发；
  // 必须提前返回，否则会重复初始化 SQLite / IPC / 窗口 / dsh。
  if (!singleInstanceLockAcquired) return;
  markStartup('main:ready');

  // dev.185 启动守卫：better-sqlite3 按需加载（见 storage/sqlite-factory.ts）。
  // 安装树残缺时（自动更新中途中断 → app.asar 已换新而 asar.unpacked 缺失）
  // 这里能捕获加载失败并给出「重新运行安装包」的可操作提示，而不是让共享
  // chunk 顶层 require 抛裸 JS 错误框（dev.184 事故：日志无痕、用户无从判断）。
  let sqliteFactory: DatabaseFactory;
  try {
    sqliteFactory = await loadSqliteFactory();
  } catch (error) {
    markStartup('main:fatal-sqlite-missing');
    log.error('better-sqlite3 unavailable, aborting startup', {
      error: error instanceof Error ? error.message : String(error),
    });
    abortOnSqliteLoadFailure(error);
    return;
  }

  // 注册 urchin:// 协议处理器（必须在 app ready 之后）。
  // onZoom：页面注入脚本 Ctrl+滚轮时 fetch urchin://zoom 触发——
  // 仅缩放网页 BrowserView（active tab，中区内容页）。
  // 用户指令 2026-10-23：左侧栏/地址栏/右侧栏尺寸固定，不随 Ctrl+滚轮缩放；
  // 因此不再处理 'main' 目标（主窗口整体 zoomFactor 会连带缩放全部 chrome）。
  // 内部页（设置/主页等 React 页面）由渲染层内容容器单独缩放。
  registerUrchinProtocol({
    onZoom: (direction, target) => {
      if (target !== 'tab') return;
      const delta = direction === 'in' ? -1 : 1;
      const active = tabManager.query({}).find((t) => t.active);
      const tab = active ? tabManager.getTab(active.id) : undefined;
      if (tab) applyZoomByDelta(tab.webContents, delta);
    },
    // dev.45：pi 品牌图标（π）——favicon 重定向目标（urchin://pi-icon）。
    // dev 与打包态同路径：dist/renderer/pi-icon.png（asar 内可直读）。
    piIconPath: join(app.getAppPath(), 'dist', 'renderer', 'pi-icon.png'),
    // dsh 品牌图标（SVG）——favicon 重定向目标（urchin://dsh-icon）。
    dshIconPath: join(app.getAppPath(), 'dist', 'renderer', 'dsh-icon.svg'),
    // M25：邮箱正文内容查询（urchin://mail-content/<token>）——
    // 惰性闭包引用模块级 ctx.mailContentStore（请求到达时已初始化）
    getMailContent: (token) => ctx.mailContentStore?.get(token) ?? null,
    // 网站图标缓存（M2）：标签栏/书签/历史统一读取主进程缓存。
    // ctx.faviconService 在下面 StorageLayer 初始化后创建；回调在请求到达时才执行。
    getFavicon: (name) => ctx.faviconService?.serve(name) ?? Promise.resolve(null),
    // 中转区拖拽（路径 B）：页面 dragstart 注入脚本 POST JSON 到 urchin://transit-drag。
    // text/link → 写 md 文档到 documents/；image/video → 直接传 URL 到主窗口。
    onTransitDrag: (data) => {
      handleTransitDragData(data, ctx.currentDataDir, sendToMainWindow);
    },
  });

  // 初始化需要文件系统 / SQLite 的模块（W6：移入 whenReady 避免模块加载阶段崩溃）
  // userDataPath 与 dataDir（ctx.currentDataDir）已在模块顶层解析（DD1 决策，
  // sessionData/cookies 重定向需 app ready 前完成），此处直接复用。
  const userDataPath = startupUserDataPath;
  const providersDir = join(userDataPath, 'providers');
  ctx.providerRegistry = new ProviderRegistry(providersDir);

  const dataDir = ctx.currentDataDir;
  const piDir = join(userDataPath, PI_DIR_NAME);
  const sl = new StorageLayer(dataDir, piDir, new ElectronSafeStorage(), sqliteFactory);
  ctx.storageLayer = sl;
  // 图标缓存随数据目录迁移；目录在服务内异步创建，不阻塞启动关键路径。
  ctx.faviconService = new FaviconService(dataDir);
  markStartup('main:storage');

  // 初始化 SettingsManager，注入 StorageLayer 持久化（设置变更自动写入 SQLite）。
  // DD1 决策：pi 键（pi.*）持久化到 pi 库 + pi 密钥存储，
  // 其余（书签/历史/普通设置）走主库。启动时迁移旧主库残留的 pi 键到 pi 库。
  ctx.settingsManager = new SettingsManager(sl.mainStore, sl.secrets, {
    piPersistence: sl.aiStore,
    piSecretStore: sl.secrets,
    legacyPiKeysScan: () => {
      const rows = sl.mainStore.query<{ key: string; value: string }>(
        'SELECT key, value FROM settings WHERE key LIKE ?',
        'settings:ai.%',
      );
      return rows
        .map((row) => {
          try {
            return { key: row.key, value: JSON.parse(row.value) as unknown };
          } catch {
            log.warn('skip malformed setting during legacy scan', { key: row.key });
            return null;
          }
        })
        .filter((r): r is { key: string; value: unknown } => r !== null);
    },
  });

  // TP7：工作区注册表（元数据存 Settings，非敏感）＋ session 分区管理器。
  // 持久化记录形状 { version, workspaces }；cookies 由 Chromium 分区自动落盘
  // （<sessionData>/Partitions），不进 SQLite。
  const workspacePersistence: WorkspacePersistence = {
    load: () => ctx.settingsManager.get('workspaces.registry'),
    save: (record) => ctx.settingsManager.set('workspaces.registry', record),
  };
  ctx.workspaceRegistry = new WorkspaceRegistry(workspacePersistence);
  ctx.workspaceSessions = new WorkspaceSessionManager();
  ctx.workspaceSessions.setSessionConfigure((ses) => {
    // 分区 session 也需可访问 urchin:// 内部页（settings/ai/newtab 等 React 占位页）
    registerUrchinProtocol(
      {
        getFavicon: (name) => ctx.faviconService?.serve(name) ?? Promise.resolve(null),
      },
      ses,
    );
    // 账号分区内的下载同样走统一保存位置策略（TP7：否则静默落入默认目录无 UI）
    installWillDownloadForSession(ses, {
      getSetting: (key) => ctx.settingsManager.get(key) as string | undefined,
      setSetting: (key, value) => ctx.settingsManager.set(key, value),
      getDataDir: () => ctx.currentDataDir,
      downloadManager,
    });
  });

  // 图标解析：按标签所属工作区选择 session（Cookie/代理与页面一致），
  // 由 FaviconService 下载、校验并落盘，返回 urchin://favicon/<hash>。
  tabManager.setFaviconResolver(async ({ pageUrl, candidates, workspaceId }) => {
    if (!ctx.faviconService) return undefined;
    try {
      const ses = ctx.workspaceSessions.resolve(workspaceId);
      return await ctx.faviconService.resolve({ pageUrl, candidates, session: ses });
    } catch {
      // 非法工作区/会话已销毁：图标失败不影响页面本身。
      return undefined;
    }
  });

  // 初始化 BookmarkManager，注入 SQLite 持久化适配器。
  // 启动时从 bookmarks 表加载已有书签到内存，create/delete 时同步写入 SQLite。
  // 修复：此前 BookmarkManager 仅用内存 Map，软件重启后书签全部丢失。
  const bookmarkPersistence: BookmarkPersistence = {
    loadAll(): ReturnType<BookmarkPersistence['loadAll']> {
      const rows = sl.mainStore.query<BookmarkRow>(
        'SELECT id, parent_id, url, title, favicon, type, position, created_at, updated_at FROM bookmarks',
      );
      return rows.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        url: row.url ?? undefined,
        title: row.title,
        favicon: row.favicon ?? undefined,
        type: row.type as 'bookmark' | 'folder',
        position: row.position,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
    upsert(bookmark): void {
      sl.mainStore.run(
        'INSERT INTO bookmarks (id, parent_id, url, title, favicon, type, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, url = excluded.url, title = excluded.title, favicon = excluded.favicon, type = excluded.type, position = excluded.position, updated_at = excluded.updated_at',
        bookmark.id,
        bookmark.parentId,
        bookmark.url ?? null,
        bookmark.title,
        bookmark.favicon ?? null,
        bookmark.type,
        bookmark.position,
        bookmark.createdAt,
        bookmark.updatedAt,
      );
    },
    remove(id): void {
      sl.mainStore.run('DELETE FROM bookmarks WHERE id = ?', id);
    },
  };
  ctx.bookmarkManager = new BookmarkManager(bookmarkPersistence);

  // 书签变更广播（create/update/delete）：推送到所有窗口的渲染进程。
  // 场景：收藏夹面板（独立子窗口）取消收藏/重命名后，主窗口地址栏星标需同步熄灭。
  // 渲染进程监听 'bookmark:changed' 后按 url 重新查询当前页收藏状态。
  const broadcastBookmarkChanged = (bookmark: { url?: string | null }): void => {
    for (const managed of windowManager.getAllWindows()) {
      managed.browserWindow.webContents.send('bookmark:changed', { url: bookmark.url ?? null });
    }
  };
  ctx.bookmarkManager.on('created', broadcastBookmarkChanged);
  ctx.bookmarkManager.on('updated', broadcastBookmarkChanged);
  ctx.bookmarkManager.on('deleted', broadcastBookmarkChanged);

  // 初始化 HistoryManager，注入 SQLite 持久化适配器。
  // 启动时从 history 表加载已有记录到内存，record/delete/clear 时同步写入 SQLite。
  // 修复：此前 HistoryManager 仅用内存 Map，软件重启后历史记录全部丢失。
  const historyPersistence: HistoryPersistence = {
    loadAll(): ReturnType<HistoryPersistence['loadAll']> {
      const rows = sl.mainStore.query<HistoryRow>(
        'SELECT id, url, title, favicon, visited_at, visit_count FROM history',
      );
      return rows.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title ?? '',
        favicon: row.favicon ?? undefined,
        visitedAt: row.visited_at,
        visitCount: row.visit_count,
      }));
    },
    upsert(entry): void {
      sl.mainStore.run(
        'INSERT INTO history (id, url, title, favicon, visited_at, visit_count) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, favicon = excluded.favicon, visited_at = excluded.visited_at, visit_count = excluded.visit_count',
        entry.id,
        entry.url,
        entry.title,
        entry.favicon ?? null,
        entry.visitedAt,
        entry.visitCount,
      );
    },
    remove(id): void {
      sl.mainStore.run('DELETE FROM history WHERE id = ?', id);
    },
    clearAll(): void {
      sl.mainStore.run('DELETE FROM history');
    },
  };
  ctx.historyManager = new HistoryManager(historyPersistence);

  markStartup('main:managers');

  // 数据目录设置变更（DD1 决策）：写入 data-location 指针，重启后整体迁移生效。
  // pi 数据（ai.db / secrets / providers）固定 userData/pi，不受此变更影响。
  ctx.settingsManager.on('changed', (key, value) => {
    if (key === 'data.directory') {
      const next = typeof value === 'string' ? value : '';
      if (!next.trim()) return; // 留空 = 恢复默认 userData/data，无需写指针
      try {
        setDataLocation(userDataPath, dataDir, next);
      } catch (err) {
        log.error('failed to update data directory pointer', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // 完整下载挂钩（DL1 决策）：BrowserView 使用默认 session，挂载 will-download
  // 统一处理保存位置（downloadsPath 设置 > 系统对话框询问 > 数据目录/downloads 默认）。
  // 对话框需要主窗口句柄，故在窗口创建后安装（installWillDownload 内部懒取）。
  installWillDownload({
    getSetting: (key) => ctx.settingsManager.get(key) as string | undefined,
    setSetting: (key, value) => ctx.settingsManager.set(key, value),
    getDataDir: () => ctx.currentDataDir,
    downloadManager,
  });

  ctx.providerConfigStore = {
    get(providerId: string): unknown {
      return sl.aiStore.get<unknown>(`provider_config:${providerId}`);
    },
    set(providerId: string, config: unknown): void {
      sl.aiStore.set(`provider_config:${providerId}`, config);
    },
  };

  /**
   * 配置提供器：合并 per-provider 配置与全局 AI 设置（apiKey / baseUrl / model）。
   *
   * 全局设置（pi.apiKey / pi.baseUrl / pi.model）通过 SettingsManager 读取，
   * 合并到 provider config 中，使 OpenAI 兼容 Provider 能直接使用设置页配置的密钥和端点。
   * per-provider 配置（provider_config:<id>）优先级高于全局设置，允许覆盖。
   *
   * 注意：ctx.providerConfigStore.get 返回 Promise（aiStore.get 是 async），必须 await。
   * 若不 await，Promise 对象被展开会把 then/catch/finally 函数注入 config，
   * 经 port.postMessage 结构化克隆会抛 "An object could not be cloned"。
   */
  const mergedConfigProvider = async (providerId: string): Promise<unknown> => {
    // 等待敏感键预加载完成，确保 pi.apiKey 已从 secretStore 读入内存
    await ctx.settingsManager.ensureSecretsLoaded();
    const perProvider = await ctx.providerConfigStore.get(providerId);
    const globalApiKey = ctx.settingsManager.get('pi.apiKey');
    const globalBaseUrl = ctx.settingsManager.get('pi.baseUrl');
    const globalModel = ctx.settingsManager.get('pi.model');
    const merged: Record<string, unknown> = {
      ...(typeof perProvider === 'object' && perProvider !== null
        ? (perProvider as Record<string, unknown>)
        : {}),
    };
    // 全局设置作为默认值，per-provider 配置可覆盖
    if (typeof globalApiKey === 'string' && globalApiKey && merged.apiKey === undefined) {
      merged.apiKey = globalApiKey;
    }
    if (typeof globalBaseUrl === 'string' && globalBaseUrl && merged.baseUrl === undefined) {
      merged.baseUrl = globalBaseUrl;
    }
    if (typeof globalModel === 'string' && globalModel && merged.model === undefined) {
      merged.model = globalModel;
    }
    return merged;
  };

  ctx.orchestrator = new Orchestrator({
    registry: ctx.providerRegistry,
    processFactory: electronProcessFactory,
    configProvider: mergedConfigProvider,
    events: {
      onProviderStateChanged: (providerId, state) => {
        broadcastProviderEvent({
          type: 'state-changed',
          providerId,
          state,
        });
      },
      onProviderCrashed: (providerId, reason) => {
        broadcastProviderEvent({ type: 'crashed', providerId, reason });
      },
    },
  });

  // 注：registerIpcHandlers() 已移至主窗口创建后的 setImmediate 延迟块
  //（启动优化 B3：窗口先出——渲染进程发出首个 IPC 远晚于本轮 setImmediate）

  // 注入链接打开行为解析器：根据设置决定点击链接时在当前/新标签页打开
  // 设置 links.openInNewTab = true 时新标签页打开，否则当前标签页打开（默认）
  tabManager.setLinkBehaviorResolver(() => {
    const openInNewTab = ctx.settingsManager.get('links.openInNewTab') === true;
    return openInNewTab ? 'new-tab' : 'current';
  });

  // 广告浮窗屏蔽（DB1 决策）：默认开启，由设置 blockAds 控制。
  // 初始化读取设置；监听设置变更实时更新——开启时对现有 tab 补注入
  // （新页面加载由 tab-manager 的 did-finish-load 自动注入）。
  tabManager.setAdBlockEnabled(ctx.settingsManager.get('blockAds') !== false);
  ctx.settingsManager.on('changed', (key, value) => {
    if (key !== 'blockAds') return;
    const enabled = value !== false;
    tabManager.setAdBlockEnabled(enabled);
    if (enabled) {
      // 补注入：已加载的外部网页立即应用屏蔽
      for (const snapshot of tabManager.query({ windowId: 1 })) {
        tabManager.applyAdBlock(snapshot.id);
      }
    }
  });

  // 监听 tab 导航事件，自动记录浏览历史。
  //
  // 根因：history.record IPC handler 存在但从未被调用，导致历史记录始终为空。
  // 修复：监听 TabManager 的 'updated' 事件，当页面加载完成（loading=false）
  // 且 URL 为 http/https 时记录到 ctx.historyManager。
  // 通过 lastUrlPerTab 去重，避免同一 URL 因 title 更新等事件被重复记录。
  const lastUrlPerTab = new Map<number, string>();
  // 图标通常晚于页面加载完成到达：记录每个 tab 最近一次已处理的图标，
  // 新图标到达时回填历史/书签，不重复计数访问。
  const lastFaviconPerTab = new Map<number, string>();
  tabManager.on('updated', (snapshot) => {
    const url = snapshot.url;
    const isHttp = url.startsWith('http://') || url.startsWith('https://');
    const favicon = snapshot.favicon;

    if (isHttp && favicon && lastFaviconPerTab.get(snapshot.id) !== favicon) {
      lastFaviconPerTab.set(snapshot.id, favicon);
      ctx.historyManager.setFavicon(url, favicon);
      if (ctx.bookmarkManager.updateFaviconByUrl(url, favicon) > 0) {
        broadcastBookmarkChanged({ url });
      }
    } else if (!favicon) {
      // 导航清空图标后允许新页面复用同一图标 URL。
      lastFaviconPerTab.delete(snapshot.id);
    }

    // 等待页面加载完成后再记录（此时 URL 和 title 都已确定）
    if (snapshot.loading) return;
    // 仅记录 http/https URL（排除 about:blank / urchin:// 等内部页面）
    if (!isHttp) return;
    // 去重：同一 tab 的同一 URL 只记录一次（后续重复访问由 ctx.historyManager.record 内部递增 visitCount）
    if (lastUrlPerTab.get(snapshot.id) === url) return;
    lastUrlPerTab.set(snapshot.id, url);
    ctx.historyManager.record(url, snapshot.title, favicon);
  });

  // 监听 AI 设置变更：当 pi.apiKey / pi.baseUrl / pi.model / pi.providerId 变化时，
  // dispose 已加载的 Provider 子进程，下次调用 ai.chat.start 时会以新配置重新 spawn。
  // 这是必要的，因为 Provider 子进程在 init 时接收配置并缓存，不会主动重新读取。
  ctx.settingsManager.on('changed', (key) => {
    if (
      key === 'pi.apiKey' ||
      key === 'pi.baseUrl' ||
      key === 'pi.model' ||
      key === 'pi.providerId'
    ) {
      log.info('AI settings changed, disposing providers for config reload', { key });
      void ctx.orchestrator.disposeAll();
    }
  });

  // 注：Provider 注册表扫描（ensureBuiltinProviders + scan）已移至主窗口创建后的
  // setImmediate 延迟块（启动优化 B3）

  // 安装 TabManager ↔ WindowManager 集成（BrowserView 挂载 + 事件推送）
  ctx.tabViewIntegration = installTabViewIntegration(tabManager, windowManager);

  // 右键菜单（复制 / 粘贴 / 保存网页）：对每个网页 tab 的 webContents 挂接
  // context-menu 监听，菜单动作全部在主进程执行。
  // 保存网页单独立项（用户决策 2026-08-18）：默认目录 <数据目录>/saved-pages/，
  // 不依赖下载相关设计（不读 downloadsPath、不接入 DownloadManager），仅需数据目录。
  const contextMenuDeps = {
    getDataDir: () => ctx.currentDataDir,
    // 网页翻译动作（M24 dev.81；结果卡悬浮窗化 2026-11-07）：划词结果由主进程
    // 直接送独立透明子窗口展示（selection-card-overlay），坐标为窗口相对坐标，
    // 与右键菜单 popup 同一补偿口径。窗口动态解析（此处早于主窗口创建）。
    translate: {
      isActive: (tabId: number) => ctx.translateManagerRef?.getStatus(tabId).active ?? false,
      translatePage: (tabId: number) => {
        void ctx.translateManagerRef?.start(tabId).catch((err) => {
          log.warn('context-menu translate page failed', { tabId, error: String(err) });
        });
      },
      translateSelection: (
        tabId: number,
        text: string,
        x: number,
        y: number,
        selection?: SelectionRect,
      ) => {
        const mgr = ctx.translateManagerRef;
        if (!mgr) return;
        // 仅活跃 tab 展示：右键必然发生在活跃 tab，但结果异步返回前用户可能已切换
        if (!tabManager.getTab(tabId)?.active) return;
        // 有选区几何时以选区左下角为锚点（结果卡贴在选中的文字下方，尺寸同源），
        // 无几何（脚本读取失败）时退回鼠标坐标。
        const anchorX = selection?.x ?? x;
        const anchorY = selection ? selection.y + selection.height : y;
        void mgr
          .translateSelection(tabId, text)
          .then((res) => {
            ctx.selectionCardOverlay?.show({
              tabId,
              source: text,
              result: res.result,
              x: anchorX,
              y: anchorY,
              selection,
            });
          })
          .catch(() => {
            ctx.selectionCardOverlay?.show({
              tabId,
              source: text,
              error: '翻译失败，请检查网络后重试',
              x: anchorX,
              y: anchorY,
              selection,
            });
          });
      },
      restore: (tabId: number) => {
        void ctx.translateManagerRef?.stop(tabId).catch((err) => {
          log.warn('context-menu restore failed', { tabId, error: String(err) });
        });
      },
    },
    // 加入中转区：选中文字生成 md 文档存 documents/，链接/视频直接传 URL。
    // 通过 sendToMainWindow('transit:add') 推送到主窗口渲染层。
    addToTransit: (item: {
      kind: 'text' | 'link' | 'video';
      title: string;
      text?: string;
      url?: string;
      sourceUrl?: string;
    }) => {
      if (item.kind === 'text' && item.text) {
        const docsDir = join(ctx.currentDataDir, 'documents');
        try {
          mkdirSync(docsDir, { recursive: true });
        } catch (err) {
          log.warn('transit: failed to ensure documents dir', { error: String(err) });
        }
        const now = new Date();
        const pad = (n: number): string => String(n).padStart(2, '0');
        const stamp =
          `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
          `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const fileName = `transit-${stamp}.md`;
        const filePath = join(docsDir, fileName);
        const content = `# ${item.title}\n\n${item.text}\n\n> 来源：${item.sourceUrl ?? '未知'} | ${now.toISOString()}`;
        try {
          writeFileSync(filePath, content, 'utf8');
        } catch (err) {
          log.warn('transit: failed to write md doc', { error: String(err) });
        }
        sendToMainWindow('transit:add', {
          kind: 'text',
          title: item.title,
          text: item.text,
          mdDocPath: filePath,
          sourceApp: 'webview',
        });
      } else if (item.kind === 'link' && item.url) {
        sendToMainWindow('transit:add', {
          kind: 'link',
          title: item.title,
          url: item.url,
          sourceApp: 'webview',
        });
      } else if (item.kind === 'video' && item.url) {
        sendToMainWindow('transit:add', {
          kind: 'video',
          title: item.title,
          url: item.url,
          sourceApp: 'webview',
        });
      }
    },
  };
  ctx.disposeContextMenu = installTabContextMenu(tabManager, contextMenuDeps);

  // 创建主窗口：恢复上次会话的窗口几何（尺寸/位置/最大化态，窗口状态记忆）。
  // loadWindowState 已校验记录形状与显示器可见性（拔掉显示器/改分辨率后
  // 自动回退默认 1280x800 居中）；screen 不可用（无头测试环境）按无记录处理。
  let mainWindowOpts: CreateWindowOptions = {};
  const savedWindowState = loadWindowState(ctx.settingsManager, () =>
    screen.getAllDisplays().map((d) => d.bounds),
  );
  if (savedWindowState) {
    mainWindowOpts = {
      x: savedWindowState.x,
      y: savedWindowState.y,
      width: savedWindowState.width,
      height: savedWindowState.height,
      maximize: savedWindowState.isMaximized,
    };
    log.info('restoring window state from previous session', {
      x: savedWindowState.x,
      y: savedWindowState.y,
      width: savedWindowState.width,
      height: savedWindowState.height,
      isMaximized: savedWindowState.isMaximized,
    });
  }
  const mainWindow = windowManager.createWindow(mainWindowOpts);
  markStartup('main:window-created');

  // 追踪主窗口几何变更（resize/move 防抖 500ms，maximize/close 立即），
  // 落盘 window.bounds 供下次启动恢复。仅主窗口追踪：拖出的新窗口/
  // macOS activate 重建窗口不参与记忆，避免互相覆盖。
  trackWindowState(mainWindow.browserWindow, ctx.settingsManager);

  // 主窗口 webContents（新标签页/设置页等 React 内部页）也挂右键菜单：
  // 复制/粘贴可用；保存网页对内部页禁用（handleContextMenu 内部按 urchin:// 前缀判断）。
  // 修复：此前只挂 BrowserView（外部网页），新标签页右键无菜单（用户反馈）。
  // BrowserWindowLike 是结构化接口（不含 on），运行时即真实 Electron webContents。
  const mainWebContents = mainWindow.browserWindow.webContents as unknown as Electron.WebContents;
  mainWebContents.on('context-menu', (_event, params) => {
    const mainTab = tabManager.query({ windowId: mainWindow.id }).find((t) => t.active);
    handleContextMenu(mainWebContents, params, mainTab, contextMenuDeps);
  });

  // 首帧渲染完成打点（启动优化 B5 诊断）：主窗口首载 HTML 完成
  mainWebContents.once('did-finish-load', () => markStartup('main:did-finish-load'));

  // 启动优化（B3，窗口先出）：主窗口与 mainWebContents 已就绪——「窗口可见」的
  // 关键路径到此为止，以下初始化不阻塞首帧，移入 setImmediate 延后执行：
  // 渲染进程需先经协议加载页面资源、再执行 JS 才会发出首个 IPC（远晚于本轮
  // setImmediate），故与渲染侧无竞态；各监听相对「归属对象创建」的先后语义不变
  // （tab/window 的 created 监听本就在窗口创建之后注册）。次序沿用原序列；
  // 各 dispose 变量在 performCleanup 已有 null 守卫。
  setImmediate(() => {
    markStartup('main:deferred-start');

    // IPC 全量注册（原位置在主窗口创建之前，B3 下移：最大同步块）
    registerIpcHandlers(ctx);

    // 系统托盘驻留（2026-11-10 用户需求）。必须在 registerIpcHandlers 之后
    // 安装：GenOffice 脏文档守卫在自己的 window-created 回调里挂 close 监听，
    // 本模块的监听排在其后，才能用 event.defaultPrevented 识别「保存确认已接管
    // 本次关闭」，避免关窗时跳过保存直接隐藏。
    ctx.trayManager = new TrayManager({
      getSetting: (key) => ctx.settingsManager.get(key),
      getWindows: () => windowManager.getAllWindows().map((w) => w.browserWindow),
      quit: () => {
        void requestQuitFromTray();
      },
      appName: displayNameForLocale(app.getLocale()),
    });
    // 设置页开关改动即时生效（无需重启）：开启建托盘，关闭销毁托盘。
    ctx.settingsManager.on('changed', (key) => {
      ctx.trayManager?.handleSettingChange(key);
    });
    for (const managed of windowManager.getAllWindows()) {
      ctx.trayManager.attachWindow(managed.browserWindow);
    }
    windowManager.on('window-created', (windowId) => {
      const managed = windowManager.getWindow(windowId);
      if (managed) ctx.trayManager?.attachWindow(managed.browserWindow);
    });
    ctx.trayManager.syncWithSetting();

    // 扫描 Provider 注册表（W4：加载已安装的 AI Provider）
    // 先确保内置 OpenAI 兼容 Provider 已部署到 userData/providers 目录
    ensureBuiltinProviders(providersDir);
    ctx.providerRegistry.scan();

    // Ctrl+滚轮缩放（v2，修复 v1 不生效根因）：
    // before-input-event 在 Electron 32 仅键盘事件触发（滚轮不达），v1 失效；
    // v2 改为向页面注入 wheel 监听脚本，识别 Ctrl+滚轮后 fetch urchin://zoom
    // 通知主进程缩放（协议特权 bypassCSP + supportFetchAPI 保证任意网页可发）。
    // 页面脚本在 did-finish-load 后注入；缩放状态由 Electron 按 webContents 持有，
    // 每标签独立、切 tab 保留，无需模块级状态。
    // 用户指令 2026-10-23：不向主窗口注入缩放脚本，避免侧栏/地址栏随 Ctrl+滚轮缩放；
    // 仅网页 BrowserView（中区内容页）参与缩放。
    ctx.disposeZoomControl = installZoomControl(tabManager);

    // 中转区拖拽注入（路径 B）：每个网页 tab 的 did-finish-load 后注入 dragstart
    // 监听脚本。脚本收集选中文字/链接/图片/视频信息，fetch urchin://transit-drag
    // 通知主进程 → 写 md 文档 / 推送 transit:add 到主窗口。
    // 复用 zoom 的 created + 存量补挂 + dispose 模式，不注入 BrowserView preload。
    ctx.disposeDragInjection = installDragInjection(tabManager);

    // M15 DevTools F12 快捷键（dev.121）：对每个网页 tab + 主窗口 webContents
    // 挂 before-input-event，命中 F12 → preventDefault + 推送 devtools:toggle
    // 到渲染层（面板开合唯一状态源）。安装/卸载复用 zoom 的 created + 存量补挂模式。
    ctx.disposeDevtoolsShortcuts = installDevtoolsShortcuts(tabManager, mainWebContents, () =>
      sendToMainWindow(DEVTOOLS_TOGGLE_CHANNEL, undefined),
    );

    // dev.45：pi 网页 favicon 统一为 π 品牌图标——拦截 pi 服务（当前随机端口）的
    // favicon 请求重定向到 urchin://pi-icon。效果覆盖标签栏/历史/主页等所有经
    // favicon URL 渲染的位置；仅匹配 pi 端口，不影响其他 localhost 应用。
    // M2C：阶段 1（pi-web-ui）已退役，仅保留 piWebHost + dsh favicon 重定向。
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://127.0.0.1/*'] },
      (details, callback) => {
        try {
          const u = new URL(details.url);
          const phPort = ctx.piWebHostLauncher?.status().port;
          if (
            phPort &&
            u.port === String(phPort) &&
            (u.pathname === '/favicon.svg' ||
              u.pathname === '/favicon.ico' ||
              u.pathname === '/favicon.png' ||
              u.pathname === '/pi-icon.png')
          ) {
            callback({ redirectURL: 'urchin://pi-icon/' });
            return;
          }
          const dshPort = ctx.dshLauncher?.status().port;
          if (
            dshPort &&
            u.port === String(dshPort) &&
            (u.pathname === '/favicon.svg' ||
              u.pathname === '/favicon-dark.svg' ||
              u.pathname === '/favicon.ico' ||
              u.pathname === '/favicon.png')
          ) {
            callback({ redirectURL: 'urchin://dsh-icon/' });
            return;
          }
        } catch {
          /* URL 解析异常按原请求放行 */
        }
        callback({});
      },
    );

    // 初始化收藏夹悬浮面板（子窗口，悬浮于网页之上；随主窗口移动/缩放重定位）。
    // 面板定位避开底部地址栏与右侧边栏：布局尺寸从 view-integration 的 layoutState 读取。
    // P2 Session 4：面板页面为 React 组件（src/renderer/panel/，独立 vite 入口
    // panel.html）；dev 加载 dev server，prod loadFile 构建产物，与状态栏悬浮层同模式。
    ctx.bookmarkPanel = new BookmarkPanel({
      getParentWindow: () => windowManager.getWindow(mainWindow.id)?.browserWindow ?? null,
      preloadPath: join(__dirname, '..', 'preload', 'index.js'),
      getLayout: () => {
        const state = getLayoutState();
        // 面板吸附在内容区右下角：额外让出外框（Windows 为 8px；其他平台 0）。
        return {
          rightWidth: state.rightWidth + WINDOW_FRAME_WIDTH,
          bottomHeight: state.bottomHeight + WINDOW_FRAME_WIDTH,
        };
      },
      onLoad: async (win, mode) => {
        const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
        const query = mode === 'picker' ? { mode: 'picker' } : undefined;
        if (isDev) {
          const base = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
          const u = new URL(base);
          u.pathname = '/panel.html';
          if (query) Object.entries(query).forEach(([k, v]) => u.searchParams.set(k, v));
          await win.loadURL(u.toString());
        } else {
          await win.loadFile(join(__dirname, '..', 'renderer', 'panel.html'), { query });
        }
      },
    });

    // 初始化底部悬浮状态栏（透明子窗口，悬浮于网页之上；网页内容铺到窗口底部）。
    // 状态由主渲染进程经 ui.statusbar.sync 推送；悬浮层动作经 ui.statusbar.action 转发。
    ctx.statusBarOverlay = new StatusBarOverlay({
      getParentWindow: () =>
        (windowManager.getWindow(mainWindow.id)?.browserWindow ??
          null) as unknown as StatusBarHostWindow | null,
      preloadPath: join(__dirname, '..', 'preload', 'index.js'),
      getLayout: () => {
        const state = getLayoutState();
        return {
          leftWidth: state.leftWidth,
          rightWidth: state.rightWidth,
          bottomHeight: state.bottomHeight,
        };
      },
      onLoad: async (win) => {
        const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
        if (isDev) {
          const base = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
          const u = new URL(base);
          u.searchParams.set('view', 'statusbar');
          await win.loadURL(u.toString());
        } else {
          await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), {
            query: { view: 'statusbar' },
          });
        }
      },
      onAction: (action) => {
        // 原生右键菜单不经过渲染层 IPC，必须转发给 App 的动作分发器。
        sendToMainWindow('ui.statusbar.action', action);
        if (action.type === 'navigate') {
          // 与 ui.statusbar.action 的导航路径一致，离开输入焦点以同步新 URL。
          mainWindow.browserWindow.focus?.();
          const active = tabManager.query({ windowId: mainWindow.id }).find((tab) => tab.active);
          if (active) tabManager.getTab(active.id)?.webContents.focus?.();
        }
      },
      getBallBounds: () => ctx.statusBarBall?.getBounds() ?? null,
      onBallOverlap: (barBounds) => ctx.statusBarBall?.ensureClearOfRect(barBounds),
      isBallDragging: () => ctx.statusBarBall?.isDragging ?? false,
    });
    // 悬浮层懒创建：在主渲染同步状态 visible=true（外部网页）时由 applyVisibility 创建。

    // 悬浮球：独立透明子窗口，位于网页区右侧；点击切换折叠，拖动滚动网页。
    ctx.statusBarBall = new StatusBarBall({
      getParentWindow: () =>
        (windowManager.getWindow(mainWindow.id)?.browserWindow ??
          null) as unknown as StatusBarBallHostWindow | null,
      preloadPath: join(__dirname, '..', 'preload', 'index.js'),
      onLoad: async (win) => {
        const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
        if (isDev) {
          const base = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
          const u = new URL(base);
          u.searchParams.set('view', 'statusbar-ball');
          await win.loadURL(u.toString());
        } else {
          await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), {
            query: { view: 'statusbar-ball' },
          });
        }
      },
      onToggleCollapse: () => ctx.statusBarOverlay?.toggleCollapsed(),
      onScroll: (dx, dy) => scrollActivePage(dx, dy),
      onPositionChanged: () => ctx.statusBarOverlay?.refreshPosition(),
      getBarBounds: () => ctx.statusBarOverlay?.getBounds() ?? null,
      getLayout: () => {
        const state = getLayoutState();
        return {
          leftWidth: state.leftWidth,
          rightWidth: state.rightWidth,
          bottomHeight: state.bottomHeight,
        };
      },
    });
    // 悬浮球在所有页面常驻（仅全屏/最小化隐藏），但**延后到主窗口首次显示后创建**：
    // · 主窗口可见前球毫无意义（applyVisibility 本来也会把它隐藏）；
    // · 更关键的是窗口顺序：Playwright 的 electronApp.firstWindow() 取「最先创建的页面」，
    //   球窗口若先于主窗口 page 就绪，E2E 就会把球当成主窗口，在主窗口控件上等满超时
    //   （2026-11-09 CI launch.spec 实测：dblclick [aria-label="右侧边栏"] 30s 超时）。
    const hostWindow = windowManager.getWindow(mainWindow.id)?.browserWindow;
    const showBall = (): void => {
      ctx.statusBarBall?.setVisible(true);
      // 球页面此刻还在加载，sendConfig 会被暂存到 did-finish-load 后补发
      sendBallConfig();
    };
    const hostVisible = (
      hostWindow as unknown as { isVisible?: () => boolean } | undefined
    )?.isVisible?.();
    if (!hostWindow || hostVisible === true) {
      showBall();
    } else {
      hostWindow.once('show', showBall);
    }
    // 初始下发配置 + 监听灵敏度设置变化
    sendBallConfig();
    ctx.settingsManager.on('changed', (key: string) => {
      if (key.startsWith('ui.statusBall.')) {
        sendBallConfig();
      }
    });

    // 划词翻译结果卡（独立透明子窗口，悬浮于网页之上；§12.3 悬浮窗化落地）。
    // 懒创建：首次划词翻译时由 show() 创建，✕ 关闭只隐藏复用。
    ctx.selectionCardOverlay = new SelectionCardOverlay({
      getParentWindow: () => windowManager.getWindow(mainWindow.id)?.browserWindow ?? null,
      preloadPath: join(__dirname, '..', 'preload', 'index.js'),
      getTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
      onLoad: async (win) => {
        const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
        if (isDev) {
          const base = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
          const u = new URL(base);
          u.searchParams.set('view', 'translate-card');
          await win.loadURL(u.toString());
        } else {
          await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), {
            query: { view: 'translate-card' },
          });
        }
      },
    });
    // 切换标签时收起结果卡（选区上下文已失效，避免残留误导）
    tabManager.on('activated', () => ctx.selectionCardOverlay?.hide());

    // HTML5 全屏抑制悬浮状态栏：内嵌视频全屏时隐藏地址栏（同 view-integration 撑满）
    tabManager.on('updated', (snapshot) => {
      if (!snapshot.active) return;
      const tab = tabManager.getTab(snapshot.id);
      const fs = tab?.htmlFullscreen ?? false;
      ctx.statusBarOverlay?.setHtmlFullscreen(fs);
      ctx.statusBarBall?.setSuppressed(fs);
      // 结果卡随全屏一并隐藏（进入时；退出不自动恢复，避免残留旧选区结果）
      if (fs) ctx.selectionCardOverlay?.hide();
    });
    tabManager.on('activated', (snapshot) => {
      const tab = tabManager.getTab(snapshot.id);
      const fs = tab?.htmlFullscreen ?? false;
      ctx.statusBarOverlay?.setHtmlFullscreen(fs);
      ctx.statusBarBall?.setSuppressed(fs);
    });

    markStartup('main:deferred-end');
  });

  // 为主窗口创建初始 tab：默认打开主页占位标签（urchin://newtab）。
  // 标签持久化（TP4）：若 startup.restoreTabs 开启且 session.lastTabs 有默认工作区的保存标签，
  // 则恢复这些标签（创建 + 激活上次活跃的）；否则创建单个主页占位。
  // 其他工作区的标签不在此恢复——由渲染层在切换到该工作区时懒恢复。
  {
    const restoreDefault = ctx.settingsManager.get('startup.restoreTabs') === true;
    const savedAll = ctx.settingsManager.get('session.lastTabs');
    const savedTabs = Array.isArray(savedAll)
      ? (savedAll as { url: string; title: string; workspaceId: string; active: boolean }[])
      : [];
    const defaultTabs = savedTabs.filter((t) => t.workspaceId === 'default');

    let restored = false;
    if (restoreDefault && defaultTabs.length > 0) {
      let activeTabId: number | undefined;
      for (const tab of defaultTabs) {
        // ADR-014：丢弃遗留的 urchin://ai 启动器标签（pi 入口已改为直接打开
        // pi-web-host 托管的 http 页，urchin://ai 路由已释放）。避免旧会话恢复出 404 页。
        if (tab.url.startsWith('urchin://ai')) continue;
        const created = tabManager.create({
          windowId: mainWindow.id,
          url: tab.url,
          workspaceId: 'default',
          active: false,
        });
        if (tab.active) activeTabId = created.id;
      }
      if (activeTabId) tabManager.setActive(activeTabId);
      restored = true;
      log.info('default workspace tabs restored', { count: defaultTabs.length });
    }
    if (!restored) {
      tabManager.create({ windowId: mainWindow.id, url: 'urchin://newtab' });
    }
  }
  markStartup('main:first-tab');

  // Windows 文件关联 / 默认浏览器启动：命令行带 URL 或文件路径时打开对应内容。
  // 须在主窗口与初始 tab 创建后执行，否则 windowId 尚未建立。
  // parseOpenArgs 会跳过开发模式的 app 目录参数，避免把应用目录当文件打开。
  openFromCommandLine(mainWindow.id, process.argv);

  // macOS：点击 dock 图标时重新创建窗口；窗口已存在（含隐藏到托盘）时
  // 优先唤回并聚焦，而不是再建一个空窗口。
  app.on('activate', () => {
    if (windowManager.getCount() > 0) {
      ctx.trayManager?.showMainWindow();
      return;
    }
    const win = windowManager.createWindow({});
    tabManager.create({ windowId: win.id, url: 'urchin://newtab' });
  });
});

// 所有窗口关闭时退出（Windows/Linux）
// macOS 不退出（保留 dock 常驻），清理流程由 before-quit 接管。
//
// 托盘模式（ui.minimizeToTray）不会走到这里：TrayManager 在 close 里
// preventDefault + hide，窗口仍是「存在但不可见」，closed / window-all-closed
// 都不会触发，pi/dsh/GenOffice 子进程继续运行。若本事件真的触发，说明窗口是被
// 真正销毁（而非隐藏），此时退出并走完整清理是正确语义。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * before-quit：Electron 退出流程的最后机会，覆盖所有平台（含 macOS Cmd+Q）。
 *
 * 第一次进入：preventDefault 阻止默认退出 → runCleanupAndExit 异步执行
 * performCleanup（含子进程兜底强杀）→ 完成后或硬超时后 app.exit(0)。
 * app.exit(0) 会再次触发 before-quit，此时 ctx.cleanupDone=true 直接放行，
 * 进程真正退出。
 */
app.on('before-quit', (event) => {
  // 托盘驻留：退出流程开始后所有窗口 close 一律放行（否则隐藏导致退不掉）
  ctx.trayManager?.markQuitting();
  if (ctx.cleanupDone) return; // 清理已完成，让默认退出继续
  if (ctx.isCleaningUp) {
    // 清理进行中，阻止重复退出
    event.preventDefault();
    return;
  }
  event.preventDefault();
  runCleanupAndExit(ctx, { exit: (code) => app.exit(code) });
});

// 信号处理（SIGINT/SIGTERM → 统一清理，实现见 lifecycle/signals.ts）
installSignalHandlers(ctx);

// 第二实例聚焦已有窗口（单实例锁配合）
// Windows 文件关联场景：应用已在运行再双击关联文件 → 系统启动第二实例，
// 此处接管：聚焦窗口 + 在现有窗口打开该文件
app.on('second-instance', (_event, commandLine) => {
  const windows = windowManager.getAllWindows();
  if (windows.length > 0) {
    const win = windows[0]!;
    win.browserWindow.show();
    win.browserWindow.restore();
    // 与首启同一套解析：跳过 app 目录参数，URL / 多个文件都能正确处理
    openFromCommandLine(win.id, commandLine);
  }
});

// 全局错误兜底（02-架构设计 §5 错误传播策略）
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { message: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
});

// 渲染/子进程异常也写入运行日志（设置 → 运行日志）：用户报「某功能打不开」时，
// 崩溃事件与退出码是排障关键，且不会被渲染进程 console 吞掉。
app.on('render-process-gone', (_event, contents, details) => {
  log.error('render-process-gone', {
    url: safeUrl(contents),
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

app.on('child-process-gone', (_event, details) => {
  log.error('child-process-gone', {
    type: details.type,
    serviceName: details.serviceName,
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

/** 读取 webContents URL（已销毁时返回空串）。 */
function safeUrl(contents: { getURL?: () => string }): string {
  try {
    return contents.getURL?.() ?? '';
  } catch {
    return '';
  }
}
