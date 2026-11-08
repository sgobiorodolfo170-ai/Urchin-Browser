/**
 * IPC handler 注册中心（refactor-plan-p2 §1.3 步骤 3）。
 *
 * registerIpcHandlers（~660 行）及其专属辅助函数自 index.ts 原样迁出：
 * 所有跨域 handler 注册（window/tab/history/bookmark/settings/workspace/
 * download/import/update/translate/devtools/screenshot/clipper/ai/dsh/
 * pi-web-host/mail/file/editor 等）与 UI 域 handler 集中于此；可变状态一律
 * 经 AppContext（ctx）访问，本文件不持有可变模块级状态。
 *
 * ⚠ 循环引用（已评估，安全）：本文件从 '../index' 反向导入 7 个仍被
 * index.ts 其他路径（whenReady / 文件关联入口 / 悬浮层）使用的符号
 * （routeLocalFile / sendToMainWindow / sendBallConfig / scrollActivePage /
 * GENOFFICE_DISABLED / downloadManager / startupUserDataPath），
 * 而 index.ts 导入本文件的 registerIpcHandlers。两侧引用均只发生在运行时
 * （registerIpcHandlers 于主窗口创建后 setImmediate 调用），不在模块求值期
 * 解引用，ESM 惰性绑定下安全。applyTheme 已于步骤 5 迁至 './theme-apply'，
 * 不再构成反向依赖。
 */
import {
  app,
  ipcMain,
  dialog,
  BrowserWindow,
  WebContentsView,
  nativeTheme,
  screen,
  session,
  net,
} from 'electron';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '@urchin/logger';
import { registerHandler, DEVTOOLS_EVENT_CHANNEL } from '@urchin/ipc-contract';
import { registerWindowHandlers } from '../windows';
import { registerTabHandlers, getLayoutState, setLayoutState, type BrowserViewLike } from '../tabs';
import { registerHistoryHandlers } from '../history';
import { registerBookmarkHandlers } from '../bookmarks';
import { registerSettingsHandlers } from '../settings';
import { registerDownloadHandlers } from '../downloads';
import { registerImportHandlers } from '../import';
import { registerWorkspaceHandlers } from '../workspaces';
import { registerAiHandlers } from '../ai';
import { registerAiInputHandlers } from '../ai/input-handlers';
import { createDshLauncher, registerDshHandlers, bindTabCloseToStop } from '../deepseek-harness';
import { createPiWebHostLauncher, registerPiWebHostHandlers } from '../pi-web-host';
import { registerPageContextHandlers } from '../page-context';
import { registerFileHandlers, registerEditorHandlers, sweepDrafts } from '../files';
import { registerFileAssociationHandlers } from '../file-association';
import { createGenOfficeIntegration } from '../genoffice/integration';
import { loadGenOfficeEmbed } from '../genoffice/loader';
import { createAiPanelPrefsStore } from '../genoffice/host-channels';
import { registerGenOfficeHomeHandlers } from '../genoffice/home-handlers';
import { GenOfficeHomeStore } from '../genoffice/home-store';
import { resolveShellRendererRoot } from '../genoffice/paths';
import { currentThemeBackground } from '../theme';
import { DEFAULT_STATUS_BAR_STATE } from '../status-bar/status-bar-overlay';
import { PI_DIR_NAME } from '../storage/data-location';
import { CaptureOverlay } from '../screenshots/capture-overlay';
import { registerScreenshotHandlers } from '../screenshots/register-handlers';
import { ClipperPanel } from '../clipper/panel';
import { ClipperStore } from '../clipper/store';
import { registerClipperHandlers } from '../clipper/register-handlers';
import { TranslateManager, TRANSLATE_PROGRESS_CHANNEL } from '../translate/translate-manager';
import { registerTranslateHandlers } from '../translate/register-handlers';
import { registerMailHandlers, MailManager, MailStorage, MailContentStore } from '../mail';
import { createMicrosoftEngine } from '../translate/engines/microsoft';
import { createGoogleEngine } from '../translate/engines/google';
import { createMyMemoryEngine } from '../translate/engines/mymemory';
import type { HttpTransport } from '../translate/engines/types';
import { createUpdateService, registerUpdateHandlers, UPDATE_EVENT_CHANNEL } from '../update';
import { registerRuntimeHandlers, resolvePortableNodeExePath } from '../runtime';
import { registerLogHandlers } from '../logs';
import { DevtoolsManager, registerDevtoolsHandlers } from '../devtools';
import type { AppContext } from './app-context';
// 运行时惰性使用的 index.ts 共享符号（循环引用安全性见文件头注释）
import { applyTheme } from './theme-apply';
// 运行时惰性使用的 index.ts 共享符号（循环引用安全性见文件头注释）
import {
  routeLocalFile,
  sendToMainWindow,
  sendBallConfig,
  scrollActivePage,
  GENOFFICE_DISABLED,
  downloadManager,
  startupUserDataPath,
} from '../index';

const log = createLogger('main');

/** 默认窗口 id（GenOffice Home 动作无 sender 上下文，取首个受管窗口）。 */
function defaultWindowId(ctx: AppContext): number {
  return ctx.windowManager.getAllWindows()[0]?.id ?? 1;
}

/**
 * 创建 GenOffice shell Home 视图（阶段 4.6，用户指令）。
 *
 * 直接加载上游 apps/shell 的 Home 渲染产物（genoffice-app://shell/index.html），
 * 但使用 **Urchin 自己的 preload**：preload 在 genoffice-app://shell 页面下
 * 暴露 window.aiOffice 适配层（genoffice:home 通道 → 本进程 home-handlers）。
 * shell 产物缺失返回 null → 集成层回落 React 保底主页。
 */
function createGenOfficeShellHomeView(): unknown {
  if (!resolveShellRendererRoot()) return null;
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  view.setBackgroundColor(currentThemeBackground());
  // 上游 Home 自带窗口内标签条（.tab-bar）：Urchin 中标签由浏览器侧栏承担，
  // 注入 CSS 隐藏，避免「标签里的标签」。仅隐藏标签条会留下其 40px 占位
  // （.app-frame-content 的 padding-top 与 .home 的 calc(100vh - 40px)），
  // 表现为主页顶部一条白条（body 背景 #fff vs 内容区 --bg-content #fafafa），
  // 故一并撤掉占位、让 Home 占满整个视图高度。只作用于 shell Home 视图；
  // docx/xlsx 等编辑器是独立 WebContentsView（自带菜单栏），不受影响。
  view.webContents.on('dom-ready', () => {
    void view.webContents
      .insertCSS(
        '.tab-bar{display:none !important}' +
          '.app-frame-content{padding-top:0 !important}' +
          '.home{height:100vh !important}',
      )
      .catch(() => undefined);
  });
  void view.webContents.loadURL('genoffice-app://shell/index.html');
  return view;
}
/** 已挂 GenOffice 整窗关闭守卫的窗口（防止重复挂接）。 */
const genofficeCloseGuardedWindows = new Set<number>();

/**
 * GenOffice 整窗关闭守卫（阶段 2）。
 *
 * 标签级关闭走 tab.close handler；窗口 X / 应用退出不经过该路径，
 * 这里沿 Electron close 事件拦截：存在脏编辑器标签时逐标签弹
 * Save / Don't Save / Cancel，全部通过才放行关闭。
 */
function installGenOfficeWindowCloseGuard(ctx: AppContext): void {
  ctx.windowManager.on('window-created', (windowId: number) => {
    if (genofficeCloseGuardedWindows.has(windowId)) return;
    const win = ctx.windowManager.getWindow(windowId)?.browserWindow;
    if (!win) return;
    genofficeCloseGuardedWindows.add(windowId);
    let allowClose = false;
    win.on('close', (...args: unknown[]) => {
      if (allowClose) return;
      const dirty = ctx.tabManager
        .query({ windowId })
        .some((t) => t.viewKind === 'genoffice' && t.dirty);
      if (!dirty || !ctx.genofficeIntegration) {
        allowClose = true;
        return;
      }
      const event = args[0] as { preventDefault?: () => void } | undefined;
      event?.preventDefault?.();
      void (async () => {
        const ok = await ctx.genofficeIntegration?.confirmWindowClose(windowId);
        if (ok) {
          allowClose = true;
          win.close();
        }
      })();
    });
  });
}
/**
 * 把键盘焦点还回活跃网页（状态栏导航/Escape 后调用）。
 *
 * 状态栏是独立 BrowserWindow，导航后若不显式聚焦，键盘焦点会留在悬浮层，
 * 导致网页无法接收空格/方向键等按键。这里先聚焦主窗口，再聚焦活跃 tab 的
 * webContents（BrowserView），使焦点回到网页。
 */
function focusActivePage(ctx: AppContext): void {
  try {
    const entry = ctx.windowManager.getAllWindows()[0];
    if (!entry) return;
    // P2-7：focus? 已入 BrowserWindowLike / WebContentsLike（可选成员），无需逃逸
    entry.browserWindow.focus?.();
    const active = ctx.tabManager.query({ windowId: entry.id }).find((t) => t.active);
    if (active) {
      ctx.tabManager.getTab(active.id)?.webContents.focus?.();
    }
  } catch (err) {
    log.warn('focus active page failed', { error: String(err) });
  }
}
/**
 * 注册 IPC handlers。
 * W1-D3：tab 域完整实现 + window 域完整实现。
 */
export function registerIpcHandlers(ctx: AppContext): void {
  // M1 window 域 handler
  registerWindowHandlers(ipcMain, ctx.windowManager);

  // GenOffice 编辑器集成（阶段 2-4）：注册宿主通道、初始化嵌入包、
  // 挂 dirty 旁路与关闭守卫。产物缺失时 available=false，标签全部回落
  // Urchin 内置查看器（用户策略：GenOffice 为主、Urchin 保底）。
  // URCHIN_DISABLE_GENOFFICE=1 时整体跳过（含嵌入包加载）。
  const genofficeAiPanelPrefs = createAiPanelPrefsStore();
  const genofficeEmbed = GENOFFICE_DISABLED ? null : loadGenOfficeEmbed();
  if (!GENOFFICE_DISABLED) {
    ctx.genofficeIntegration = createGenOfficeIntegration({
      ipcMain,
      tabManager: ctx.tabManager,
      windowManager: ctx.windowManager,
      getTheme: () => nativeTheme.themeSource,
      aiPanelPrefs: genofficeAiPanelPrefs,
      createHomeView: () => createGenOfficeShellHomeView(),
    });
    ctx.genofficeIntegration.install();
    installGenOfficeWindowCloseGuard(ctx);
  }

  // GenOffice Home 宿主适配（阶段 4.6，用户指令：入口直接使用上游 Home 前端）。
  // 上游 shell Home 的 home:* 通道由本进程实现可用子集（打开/最近/文件夹/
  // 新建/主题/语言/AI 设置），账号与云能力以中性桩返回。
  if (!GENOFFICE_DISABLED) {
    // 确保 GenOffice 编辑器的默认保存目录与浏览器数据目录对齐：
    // 编辑器的 configuredDefaultSaveDir(app) 读 <userData>/app-settings.json
    // 的 defaultSaveDir 键。启动时如该键未设置（用户未自定义），写入
    // <数据目录>/documents。用户可通过设置弹窗的「更改」按钮自定义（写入同一文件）。
    {
      const settingsPath = join(app.getPath('userData'), 'app-settings.json');
      const documentsRoot = join(ctx.currentDataDir, 'documents');
      try {
        const raw = existsSync(settingsPath)
          ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
          : {};
        if (typeof raw.defaultSaveDir !== 'string' || !raw.defaultSaveDir) {
          raw.defaultSaveDir = documentsRoot;
          writeFileSync(settingsPath, JSON.stringify(raw, null, 2));
        }
      } catch {
        /* 读/写失败：编辑器回落到 <Documents>/GenOffice，不影响 Home 侧 */
      }
    }
    registerGenOfficeHomeHandlers({
      ipcMain,
      store: new GenOfficeHomeStore(join(ctx.currentDataDir, 'genoffice-home.json')),
      documentsRoot: join(ctx.currentDataDir, 'documents'),
      getTheme: () => nativeTheme.themeSource,
      setTheme: (theme) => {
        if (theme === 'light' || theme === 'dark' || theme === 'system') applyTheme(ctx, theme);
      },
      getVersion: () => app.getVersion(),
      aiPanelPrefs: genofficeAiPanelPrefs,
      openLocalPath: (path) => routeLocalFile(defaultWindowId(ctx), path),
      openBlankDocument: (kind) => {
        const view = genofficeEmbed?.createGenOfficeBlankView?.(kind);
        if (!view) return false;
        ctx.tabManager.create({
          windowId: defaultWindowId(ctx),
          url: `urchin://genoffice/?kind=${encodeURIComponent(kind)}`,
          active: true,
          view: view as BrowserViewLike,
          viewKind: 'genoffice',
          genofficeKind: kind,
        });
        return true;
      },
      writeBlankPdf: async (filePath) => {
        await genofficeEmbed?.writeBlankPdfFile?.(filePath);
      },
      setLanguage: (lang) => genofficeEmbed?.setGenOfficeLanguage?.(lang),
      embedApi: genofficeEmbed,
    });
  }

  // M2 tab 域 handler（注入 GenOffice 集成：tab.create 分流 + tab.close 守卫）
  registerTabHandlers(ipcMain, ctx.tabManager, {
    genoffice: ctx.genofficeIntegration ?? undefined,
  });

  // M6 history 域 handler
  registerHistoryHandlers(ipcMain, ctx.historyManager);

  // M5 bookmark 域 handler
  // 新建书签时从当前标签快照取已缓存图标（主进程可信来源，渲染层不可伪造）。
  registerBookmarkHandlers(ipcMain, ctx.bookmarkManager, {
    getFavicon: (url) => {
      const tabs = ctx.tabManager.query({});
      return (
        tabs.find((tab) => tab.active && tab.url === url) ?? tabs.find((tab) => tab.url === url)
      )?.favicon;
    },
  });

  // M7 settings 域 handler
  registerSettingsHandlers(ipcMain, ctx.settingsManager);

  // TP7 workspace 域 handler：CRUD + 清空数据；变更广播所有窗口刷新。
  registerWorkspaceHandlers(ipcMain, {
    registry: ctx.workspaceRegistry,
    sessions: ctx.workspaceSessions,
    tabManager: ctx.tabManager,
    broadcastChanged: () => {
      for (const managed of ctx.windowManager.getAllWindows()) {
        managed.browserWindow.webContents.send('workspace:changed', {});
      }
    },
  });

  // M23 download 域 handler
  registerDownloadHandlers(ipcMain, downloadManager);

  // D 导入域 handler（dev.119）：从其他浏览器导入收藏夹
  // （HTML 文件 + Chrome/Edge/Firefox profile 自动检测；解析器/检测器 DI 注入便于单测）
  registerImportHandlers({ ipcMain, bookmarkManager: ctx.bookmarkManager });

  // M20 update 域 handler（dev.114 提前落地）：设置页更新按钮 → GitHub Releases
  // dev 预发布通道。electron-updater 懒加载（首次检查才 dynamic import，不拖
  // 启动），开发态整体 disabled；状态变化经 update:event 推送设置页。
  const updateService = createUpdateService({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    notify: (state) => sendToMainWindow(UPDATE_EVENT_CHANNEL, state),
  });
  registerUpdateHandlers(ipcMain, updateService);

  // 便携 node.exe 期望路径（单一真源：main/runtime/portable-node.ts）——同时供
  // runtime.portableNode IPC（设置-关于）与下方 dsh 启动器接线使用，避免多处
  // 内联 join 漂移。
  const portableNodeExePath = resolvePortableNodeExePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  // Runtime 域 handler（设置-关于 · 运行时信息）：展示便携 Node 是否随包装上
  // 且可运行（存在性 + `--version` spawn 探测，见 main/runtime/portable-node.ts）。
  registerRuntimeHandlers(ipcMain, { portableNodeExePath });

  // Logs 域 handler（设置 → 运行日志）：读取 <数据目录>/logs 下的 JSONL 日志。
  // 落盘由 @urchin/logger 的进程级 sink 完成（main/index.ts 启动早期初始化），
  // 此处注册读取通道；目录跟随数据目录，不提供单独设置项（2026-11-07 用户指令）。
  registerLogHandlers(ipcMain, { dir: join(ctx.currentDataDir, 'logs') });

  // M24 网页翻译域 handler（dev.79）：微软/谷歌免费双引擎互为兜底（TD2）。
  // HTTP 经 net.fetch（Chromium 网络栈）——系统代理下谷歌可达，auto 引擎的
  // resolveProxy 判定（直连微软优先/走代理谷歌优先）才与真实路由一致。
  const translateHttpTransport: HttpTransport = async (url, init) => {
    const res = await net.fetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    });
    return { status: res.status, text: await res.text() };
  };
  // E2E 注入口（dev.82）：URCHIN_TRANSLATE_TEST_BASE 指向本地假翻译服务时，
  // 双引擎端点整体切换到该基址（/microsoft/auth、/microsoft/translate、/google/translate_a/t），
  // 生产环境未设置该变量时使用真实免费接口端点。
  const translateTestBase = process.env.URCHIN_TRANSLATE_TEST_BASE;
  const translateManager = new TranslateManager({
    tabManager: ctx.tabManager,
    settings: ctx.settingsManager,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    // 进度事件发往主窗口渲染层（页面 world 无监听能力，dev.82 修正）
    notifyProgress: (tabId, payload) => sendToMainWindow(TRANSLATE_PROGRESS_CHANNEL, payload),
    engines: {
      microsoft: createMicrosoftEngine(
        translateTestBase
          ? {
              transport: translateHttpTransport,
              authUrl: `${translateTestBase}/microsoft/auth`,
              baseUrl: `${translateTestBase}/microsoft`,
            }
          : { transport: translateHttpTransport },
      ),
      google: createGoogleEngine(
        translateTestBase
          ? { transport: translateHttpTransport, baseUrl: `${translateTestBase}/google` }
          : { transport: translateHttpTransport },
      ),
      mymemory: createMyMemoryEngine(
        translateTestBase
          ? { transport: translateHttpTransport, baseUrl: `${translateTestBase}/mymemory` }
          : { transport: translateHttpTransport },
      ),
    },
  });
  registerTranslateHandlers({ ipcMain, translateManager, tabManager: ctx.tabManager });
  ctx.disposeTranslateManager = () => translateManager.dispose();
  ctx.translateManagerRef = translateManager;

  // M15 DevTools（dev.121，CDP 采集检视面板）：会话管理 + IPC handler。
  // 事件推送复用 sendToMainWindow（devtools:event）；F12 toggle 走 devtools:toggle。
  const devtoolsManager = new DevtoolsManager({
    tabManager: ctx.tabManager,
    notify: (payload) => sendToMainWindow(DEVTOOLS_EVENT_CHANNEL, payload),
  });
  registerDevtoolsHandlers(ipcMain, devtoolsManager);
  ctx.disposeDevtoolsManager = () => devtoolsManager.dispose();

  // 截图域 handler（地址栏截图按钮）：弹出整屏框选覆盖窗口，确认后裁剪保存到
  // <数据目录>/screenshots/。CaptureOverlay 单例持覆盖窗口与截图缓存。
  const captureOverlay = new CaptureOverlay({
    createWindow: (opts) => new BrowserWindow(opts),
    preloadPath: join(__dirname, '..', 'preload', 'index.js'),
    dataDir: ctx.currentDataDir,
  });
  registerScreenshotHandlers(ipcMain, { overlay: captureOverlay });

  // 剪藏域 handler（地址栏剪藏按钮，M26）：面板 + 页面快照 + 多格式落盘。
  // 保存目录默认 <数据目录>/documents/clipper，可经设置「数据 → 剪藏保存路径」
  // 自定义（clipper.saveDir，动态读取，改后立即生效）；面板失焦自动关闭。
  const clipperStore = new ClipperStore({
    documentsRoot: join(ctx.currentDataDir, 'documents'),
    customDir: () => {
      const value = ctx.settingsManager.get('clipper.saveDir');
      return typeof value === 'string' ? value : '';
    },
  });
  const clipperPanel = new ClipperPanel({
    getParentWindow: () => ctx.windowManager.getAllWindows()[0]?.browserWindow ?? null,
    preloadPath: join(__dirname, '..', 'preload', 'index.js'),
    getLayout: () => {
      const state = getLayoutState();
      return {
        leftWidth: state.leftWidth,
        rightWidth: state.rightWidth,
        bottomHeight: state.bottomHeight,
      };
    },
    onLoad: async (win, tabId) => {
      const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
      if (isDev) {
        const base = process.env.URCHIN_RENDERER_URL ?? 'http://localhost:5173';
        const u = new URL(base);
        u.searchParams.set('view', 'clipper');
        u.searchParams.set('tabId', String(tabId));
        await win.loadURL(u.toString());
      } else {
        await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), {
          query: { view: 'clipper', tabId: String(tabId) },
        });
      }
    },
  });
  registerClipperHandlers({
    ipcMain,
    tabManager: ctx.tabManager,
    settings: ctx.settingsManager,
    panel: clipperPanel,
    store: clipperStore,
    embedApi: genofficeEmbed,
    openMhtmlFile: (path) => {
      if (!routeLocalFile(defaultWindowId(ctx), path)) {
        throw new Error(`无法打开 MHTML：${path}`);
      }
    },
  });

  // dialog 域 handler：原生目录选择器
  // 供设置页「下载位置」「摘要文档保存位置」等路径字段点击选择目录使用。
  registerHandler(ipcMain, 'dialog.selectDirectory', async (req) => {
    const focused = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(focused!, {
      title: req.title ?? '选择目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { path: null };
    }
    return { path: result.filePaths[0]! };
  });

  // M13 AI 域 handler（provider.list/install/remove/config + ai.chat.start/abort + ai.agent.start/abort）
  // agentConfigProvider 复用 ctx.settingsManager + ctx.providerConfigStore 的合并逻辑，为 pi 适配层提供 apiKey/baseUrl
  // 注意：ctx.providerConfigStore.get 返回 Promise（aiStore.get 是 async），必须 await
  const agentConfigProvider = {
    async get(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }> {
      // 等待敏感键预加载完成，确保 pi.apiKey 已从 secretStore 读入内存
      await ctx.settingsManager.ensureSecretsLoaded();
      const perProvider = ctx.providerConfigStore
        ? await ctx.providerConfigStore.get(providerId)
        : null;
      const cfg =
        typeof perProvider === 'object' && perProvider !== null
          ? (perProvider as Record<string, unknown>)
          : {};
      const globalApiKey = ctx.settingsManager.get('pi.apiKey');
      const globalBaseUrl = ctx.settingsManager.get('pi.baseUrl');
      return {
        apiKey:
          typeof cfg.apiKey === 'string'
            ? cfg.apiKey
            : typeof globalApiKey === 'string'
              ? globalApiKey
              : undefined,
        baseUrl:
          typeof cfg.baseUrl === 'string'
            ? cfg.baseUrl
            : typeof globalBaseUrl === 'string'
              ? globalBaseUrl
              : undefined,
      };
    },
  };
  // 保存 AI handlers 的 dispose 句柄，退出时用于 abort 活跃流
  const aiHandlers = registerAiHandlers(
    ipcMain,
    ctx.orchestrator,
    ctx.providerRegistry,
    ctx.providerConfigStore,
    agentConfigProvider,
  );
  ctx.aiHandlersDispose = () => aiHandlers.dispose();

  // pi 模块前端加号菜单三项：截图、上传文件、设置工作目录
  registerAiInputHandlers(ipcMain);

  // DeepSeek Harness 启动器（X4 双模式，两种模式均用便携 node.exe 直启）：
  // - 开发态：vendor/deepseek-harness TypeScript 源码 + tsx ESM loader，
  //   运行时 = apps/desktop/build/node/node.exe（scripts/fetch-node.mjs 前置生成）。
  // - 打包态：npm 包 @deepseek-ai/dsh（app.asar.unpacked，asarUnpack 自动部署）
  //   + 便携 node.exe（process.resourcesPath/node，extraResources）。
  // 为何不能复用 Electron 内置 Node（ELECTRON_RUN_AS_NODE）：dsh 依赖
  // node-addon-require-builtin 校验运行时指纹，实探双态均拒绝 Electron V8
  // （unsupported Electron runtime fingerprint），必须有独立纯 Node 运行时。
  // （pi-web 不走 dsh 依赖，仍用 Electron 内置 Node，无需此文件。）
  // 与 piWeb 的关键差异：标签关闭后自动停止后端（bindTabCloseToStop）。
  const dshDataDir = join(startupUserDataPath, 'deepseek-harness');
  if (app.isPackaged) {
    const dshPackagedCliPath = join(
      app.getAppPath(),
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    ).replace('app.asar', 'app.asar.unpacked');
    // 便携 node.exe：上方 resolvePortableNodeExePath 产物（打包态 = resources/node）
    const dshNodeExePath = portableNodeExePath;
    if (!existsSync(dshNodeExePath)) {
      log.error('portable node.exe not found (package:win 应经 fetch-node.mjs 生成)', {
        dshNodeExePath,
      });
    }
    if (!existsSync(dshPackagedCliPath)) {
      log.error('@deepseek-ai/dsh CLI not found in app.asar.unpacked', { dshPackagedCliPath });
    }
    ctx.dshLauncher = createDshLauncher({
      cwdDir: dshDataDir,
      cliEntry: dshPackagedCliPath,
      nodePath: dshNodeExePath,
      usesTsxLoader: false,
      dataDir: dshDataDir,
    });
  } else {
    const dshVendorDir = resolve(app.getAppPath(), '..', '..', 'vendor', 'deepseek-harness');
    // vendor 树不在版本控制内（P2-13 / ADR-016）：新环境经 `pnpm sync:dsh` 拉取，
    // 版本真源为 apps/desktop 的 @deepseek-ai/dsh 依赖（check:dsh 三源把守）。
    if (!existsSync(dshVendorDir)) {
      log.error('dsh vendor directory not found — run `pnpm sync:dsh` at repo root first', {
        dshVendorDir,
      });
    }
    // 开发态同样用便携 node.exe 作运行时（Electron-as-Node 会被 dsh 的
    // node-addon-require-builtin 指纹校验拒绝，见上方注释）。缺失时按提示
    // 生成；仍传入路径，使启动器在 UI 上给出可诊断的 spawn 错误。
    // 便携 node.exe：上方 resolvePortableNodeExePath 产物（开发态 = build/node）
    const dshDevNodeExePath = portableNodeExePath;
    if (!existsSync(dshDevNodeExePath)) {
      log.error(
        'portable node.exe not found（开发态 dsh 运行时）—— 请先运行 node scripts/fetch-node.mjs',
        {
          dshDevNodeExePath,
        },
      );
    }
    ctx.dshLauncher = createDshLauncher({
      cwdDir: dshVendorDir,
      cliEntry: 'apps/cli/src/bin.ts',
      nodePath: dshDevNodeExePath,
      usesTsxLoader: true,
      dataDir: dshDataDir,
    });
  }
  registerDshHandlers(ipcMain, ctx.dshLauncher);
  ctx.unbindDshTabClose = bindTabCloseToStop(ctx.tabManager, ctx.dshLauncher);

  // pi 阶段 2 自研托管服务启动器（docs/pi-web-评估.md 阶段 2）：utilityProcess 内运行
  // @urchin/pi-web-host（HTTP 静态 + WebSocket + 随机 token 鉴权，前端 apps/pi-web）。
  // 与 piWeb（阶段 1）双轨并存：本自研服务是收敛终点，阶段 1 于 M2C 整体退役。
  // forkTarget = dist/main/pi-web-host.js（scripts/build-pi-web.mjs 产物，dev/打包同构）；
  // wwwDir = dist/pi-web（apps/pi-web 构建产物）。数据落 userData/pi/self-host（DD1）。
  const piWebHostDataDir = join(startupUserDataPath, PI_DIR_NAME, 'self-host');
  // P6（2026-11-08）：默认切到上游 pi-server（与重建前端同源协议）；
  // 设 URCHIN_PI_SERVER=legacy 可回退 pi-web-host.js 轻量壳。
  const usePiServer = process.env.URCHIN_PI_SERVER !== 'legacy';
  ctx.piWebHostLauncher = createPiWebHostLauncher({
    forkTarget: join(__dirname, usePiServer ? 'pi-server.mjs' : 'pi-web-host.js'),
    serverKind: usePiServer ? 'pi-server' : 'legacy',
    agentDir: join(startupUserDataPath, PI_DIR_NAME, 'agent'),
    wwwDir: join(app.getAppPath(), 'dist', 'pi-web'),
    dataDir: piWebHostDataDir,
    // M2B：fork 时从 settings + agentConfigProvider 解析当前凭据/模型（支持运行时变更）
    agentCredsProvider: async () => {
      await ctx.settingsManager.ensureSecretsLoaded();
      const providerId = ctx.settingsManager.get('pi.providerId') as string | undefined;
      const modelId = ctx.settingsManager.get('pi.model') as string | undefined;
      if (!providerId || !modelId) return null;
      const cfg = await agentConfigProvider.get(providerId);
      if (!cfg.apiKey) return null;
      return {
        apiKey: cfg.apiKey,
        providerId,
        modelId,
        baseUrl: cfg.baseUrl,
        // M2B-4：在 utility 进程内恢复 coding 工具（PH7；agent 不跑主进程，安全）
        enableTools: true,
        toolsCwd: piWebHostDataDir,
      };
    },
    // Phase 4：子进程→主进程消息回调（pi-web SettingsModal set_model → 写回 pi.* 键）
    onChildMessage: (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: string; providerId?: string; modelId?: string };
      if (m.type === 'piSettingsChanged') {
        if (m.providerId) ctx.settingsManager.set('pi.providerId', m.providerId);
        if (m.modelId) ctx.settingsManager.set('pi.model', m.modelId);
      }
    },
  });
  registerPiWebHostHandlers(ipcMain, ctx.piWebHostLauncher);

  // dev.122（ADR-014）：pi 服务改为应用级常驻——关 pi 标签不再停止后端，
  // 服务活到应用退出（performCleanup 调 dispose）。仅 dsh 保留「关标签停后端」。
  ctx.tabManager.setPiIconPinner((sourceUrl) => {
    try {
      const origin = new URL(sourceUrl).origin;
      const phUrl = ctx.piWebHostLauncher?.status().url;
      if (phUrl && new URL(phUrl).origin === origin) return 'urchin://pi-icon/';
      const dshUrl = ctx.dshLauncher?.status().url;
      if (dshUrl && new URL(dshUrl).origin === origin) return 'urchin://dsh-icon/';
    } catch {
      /* invalid URL → no pin */
    }
    return undefined;
  });

  // M14 page context 域 handler（page.extract）
  registerPageContextHandlers(ipcMain, ctx.tabManager);

  // 本地文件域 handler（file.stat / file.read / file.write / file.saveAs / file.open / file.dir）
  // 支撑「以网页形式打开本地文件」：音视频/PDF/图片原生渲染，文本类文档查看器渲染
  registerFileHandlers({ ipcMain });

  // 编辑器草稿域（editor.*，会话内自动临时保存）：
  // 启动清扫上一会话残留草稿后注册（目录已由 ensureDataDir 预创建）
  const editorDraftsDir = join(ctx.currentDataDir, 'editor-drafts');
  void sweepDrafts(editorDraftsDir);
  registerEditorHandlers({ ipcMain, draftsDir: editorDraftsDir });

  // 文件关联域 handler（默认应用）：注册/查询 HKCU 文件关联
  // 使用 process.execPath 作为打开命令的可执行文件路径
  registerFileAssociationHandlers({
    ipcMain,
    exePath: process.execPath,
    launchArgs: process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : [],
  });

  // M25 邮箱域 handler（imapflow + nodemailer + postal-mime）
  if (ctx.storageLayer) {
    if (!ctx.translateManagerRef) {
      throw new Error('translateManager must be registered before mail handlers');
    }
    ctx.mailContentStore = new MailContentStore();
    const mailStorage = new MailStorage(
      ctx.storageLayer.mainStore.query.bind(ctx.storageLayer.mainStore),
      ctx.storageLayer.mainStore.run.bind(ctx.storageLayer.mainStore),
    );
    const mailManager = new MailManager(
      mailStorage,
      ctx.storageLayer.secrets,
      ctx.mailContentStore,
    );
    registerMailHandlers({
      ipcMain,
      mailManager,
      translateManager: ctx.translateManagerRef,
      getMainWindow: () => {
        const managed = ctx.windowManager.getAllWindows()[0];
        const wc = managed?.browserWindow?.webContents;
        if (!wc) return null;
        return wc as unknown as import('electron').WebContents;
      },
    });
  }

  // UI 域 handler：布局状态切换（左/右侧栏宽度 + 下侧栏高度 + 内容区可见性）
  registerHandler(ipcMain, 'ui.layout.setState', (req) => {
    const newState = setLayoutState({
      leftWidth: req.leftWidth,
      rightWidth: req.rightWidth,
      bottomHeight: req.bottomHeight,
      contentHidden: req.contentHidden,
      browserViewHidden: req.browserViewHidden,
      devtoolsWidth: req.devtoolsWidth,
    });
    // 立即刷新所有窗口的 BrowserView bounds
    ctx.tabViewIntegration?.refreshAllViewBounds();
    // 布局变化（如右侧栏宽度拖拽调节）时，悬浮面板与状态栏跟随重新定位
    ctx.bookmarkPanel?.refreshPosition();
    ctx.statusBarOverlay?.refreshPosition();
    ctx.statusBarBall?.refreshPosition();
    log.info('layout state updated', {
      leftWidth: newState.leftWidth,
      rightWidth: newState.rightWidth,
      bottomHeight: newState.bottomHeight,
      contentHidden: newState.contentHidden,
      browserViewHidden: newState.browserViewHidden,
    });
    return {
      leftWidth: newState.leftWidth,
      rightWidth: newState.rightWidth,
      bottomHeight: newState.bottomHeight,
      contentHidden: newState.contentHidden,
      browserViewHidden: newState.browserViewHidden,
      devtoolsWidth: newState.devtoolsWidth,
    };
  });

  // UI 域 handler：收藏夹悬浮面板开关（独立子窗口，悬浮于网页之上）
  registerHandler(ipcMain, 'ui.panel.toggle', () => {
    const open = ctx.bookmarkPanel?.toggle() ?? false;
    return { open };
  });

  // UI 域 handler：以 picker 模式打开面板（星标按钮未收藏时调用）。
  // 解析活动标签 url/title 存上下文，面板加载 ?mode=picker 后渲染「选择文件夹保存」视图。
  registerHandler(ipcMain, 'ui.panel.saveBookmarkPicker', () => {
    const tabs = ctx.tabManager.query({});
    const active = tabs.find((t) => t.active) ?? tabs[0];
    const url = active?.url ?? '';
    // 仅 http/https 可收藏（与渲染层 isBookmarkable 一致；星标本就禁用，此处防御式校验）
    if (!/^https?:\/\//i.test(url)) {
      return { ok: true as const, reason: 'not-bookmarkable' };
    }
    ctx.bookmarkPickerContext = { url, title: active?.title ?? url };
    ctx.bookmarkPanel?.openPicker();
    return { ok: true as const };
  });

  // UI 域 handler：面板 picker 模式加载时拉取待存页面上下文
  registerHandler(ipcMain, 'ui.panel.getPickerContext', () => {
    const pickerCtx = ctx.bookmarkPickerContext;
    return { url: pickerCtx?.url ?? null, title: pickerCtx?.title ?? null };
  });

  // UI 域 handler：关闭面板（picker 保存成功后面板主动调用，面板窗口无法直接关 BrowserWindow）
  registerHandler(ipcMain, 'ui.panel.close', () => {
    ctx.bookmarkPanel?.close();
    return { ok: true as const };
  });

  // UI 域 handler：主题切换（渲染层 ThemeProvider 调用）。
  // 设置 nativeTheme.themeSource 使：窗口标题栏/边框跟随主题；
  // 支持 prefers-color-scheme 的网页（BrowserView）跟随主题（Chrome 深色模式行为）。
  // dev.49：设置后立刻向所有 pi 标签直推主题（page-enhance 注入脚本暴露的
  // __ubApplyTheme）——根治 dev.48 纯 2s 轮询的滞后/偶发 fetch 失败导致的
  // 「pi 前端主题切换阻塞」；页面内 2s 轮询降级为兜底。
  // dev.50：同步刷新窗口与已存在 BrowserView 的背景色——消除深色模式下
  // 网页区四周几何缝隙透出的硬编码白色（渲染层容器已同步改用主题令牌）。
  registerHandler(ipcMain, 'ui.theme.set', (req) => {
    applyTheme(ctx, req.theme);
    return { ok: true as const };
  });

  // UI 域 handler：按住侧边栏空白处拖动窗口（相对位移）。
  // 渲染层发屏幕坐标增量，主进程移动窗口位置（手动拖拽实现，兼容双击/悬停展开）。
  // 多窗口：按 sender 反查所属窗口移动（不再硬编码 windowId=1，新窗口拖拽不再误移原窗口）。
  registerHandler(ipcMain, 'ui.window.dragBy', (req, callCtx) => {
    const sender = callCtx.event.sender;
    const managed =
      ctx.windowManager.getWindowByWebContents(sender) ?? ctx.windowManager.getWindow(1);
    const win = managed?.browserWindow;
    if (!win?.getPosition || !win.setPosition) {
      return { ok: true as const }; // 测试环境无真实 BrowserWindow 位置 API
    }
    const pos = win.getPosition();
    const x = pos[0] ?? 0;
    const y = pos[1] ?? 0;
    win.setPosition(x + req.dx, y + req.dy);
    return { ok: true as const };
  });

  // UI 域 handler：状态栏状态同步（主渲染 → 主进程，缓存并转发给悬浮层）
  registerHandler(ipcMain, 'ui.statusbar.sync', (req) => {
    ctx.statusBarOverlay?.handleSync(req);
    // 主题 + 灵敏度同步给球（球在所有页面常驻，可见性由主进程独立管理）
    sendBallConfig();
    return { ok: true as const };
  });

  // UI 域 handler：悬浮层取缓存状态（悬浮层 → 主进程）
  registerHandler(ipcMain, 'ui.statusbar.getState', () => {
    return ctx.statusBarOverlay?.getState() ?? DEFAULT_STATUS_BAR_STATE;
  });

  // UI 域 handler：悬浮层上报建议/提示展开高度（悬浮层 → 主进程，重定位窗口）
  registerHandler(ipcMain, 'ui.statusbar.setExpanded', (req) => {
    ctx.statusBarOverlay?.setExpanded(req.panelHeight);
    return { ok: true as const };
  });

  // UI 域 handler：折叠/展开地址栏（折叠按钮调用）
  registerHandler(ipcMain, 'ui.statusbar.collapse', (req) => {
    ctx.statusBarOverlay?.setCollapsed(req.collapsed);
    return { ok: true as const };
  });

  // UI 域 handler：悬浮球拖动滚动网页
  registerHandler(ipcMain, 'ui.statusbar.ball.scroll', (req) => {
    scrollActivePage(req.dx, req.dy);
    return { ok: true as const };
  });

  // UI 域 handler：悬浮球右键拖动改变位置
  registerHandler(ipcMain, 'ui.statusbar.ball.move', (req) => {
    ctx.statusBarBall?.moveBy(req.dx, req.dy);
    return { ok: true as const };
  });

  // UI 域 handler：悬浮球点击切换折叠/展开
  registerHandler(ipcMain, 'ui.statusbar.ball.click', () => {
    ctx.statusBarOverlay?.toggleCollapsed();
    return { ok: true as const };
  });

  // UI 域 handler：悬浮层用户动作转发（悬浮层 → 主进程 → 主渲染）
  registerHandler(ipcMain, 'ui.statusbar.action', (req) => {
    const action = req;
    // 转发给主渲染进程（App.tsx 监听 ui.statusbar.action 事件）
    sendToMainWindow('ui.statusbar.action', action);
    // 导航类动作：把焦点还回网页，避免悬浮层占用键盘焦点
    if (
      action.type === 'navigate' ||
      action.type === 'back' ||
      action.type === 'forward' ||
      action.type === 'reload' ||
      action.type === 'focus-page'
    ) {
      focusActivePage(ctx);
    }
    return { ok: true as const };
  });

  // Window 域 handler：查询当前渲染进程所属窗口 id（多窗口下渲染层不再硬编码 windowId=1）。
  // 经 event.sender 反查 ManagedWindow；找不到（如测试/非受管 webContents）回退 windowId=1。
  registerHandler(ipcMain, 'window.getCurrent', (_req, callCtx) => {
    const sender = callCtx.event.sender;
    const managed = ctx.windowManager.getWindowByWebContents(sender);
    return { windowId: managed?.id ?? 1 };
  });

  // Window 域 handler：新浏览器窗口打开 URL（侧边栏标签/书签拖出窗口触发）。
  // 新窗口默认打开新标签页，随后把目标 URL 导航到活跃标签（tab.loadUrl）——
  // 直接给 createWindow 传 url 不会导航（create-window.ts 仅用 url 参数决定加载源）。
  // v0.1 单窗口化：ctx.windowManager.createWindow 恒分配 windowId=2（原窗口为 1）。
  // x/y（拖出瞬间屏幕坐标）：窗口左上角定位到拖拽位置，避免新窗口重叠在原窗口上；
  // clamp 到主屏工作区（至少留 120px 窗口主体可见），测试环境无 screen 时跳过定位。
  registerHandler(ipcMain, 'window.createWithUrl', (req) => {
    log.info('window.createWithUrl', {
      url: req.url,
      x: req.x,
      y: req.y,
      workspaceId: req.workspaceId,
    });
    const managed = ctx.windowManager.createWindow({});
    ctx.tabManager.create({
      windowId: managed.id,
      url: req.url,
      active: true,
      workspaceId: req.workspaceId,
    });
    if (req.x !== undefined && req.y !== undefined) {
      try {
        const wa = screen.getPrimaryDisplay().workArea;
        const px = Math.min(Math.max(req.x, wa.x), wa.x + Math.max(0, wa.width - 120));
        const py = Math.min(Math.max(req.y, wa.y), wa.y + Math.max(0, wa.height - 120));
        managed.browserWindow.setPosition?.(px, py);
      } catch (err) {
        log.warn('failed to position new window', { error: String(err) });
      }
    }
    return { windowId: managed.id };
  });

  log.info('ipc handlers registered');
}
