/**
 * GenOffice 编辑器 · Urchin 集成装配（阶段 2 md 打样）
 *
 * 职责：
 * 1. install()（app ready 后调用一次）：
 *    - 注册宿主缺失的应用级通道（host-channels）
 *    - 加载 vendor 嵌入包并初始化（renderer/preload 路径）
 *    - 挂 dirty 旁路监听：GenOffice 编辑器自报的 `${kind}:dirty-changed`
 *      同步到标签脏状态（侧栏脏点/关闭守卫共用）
 * 2. resolveTabCreate(url)：tab.create 分流——GenOffice 伪地址 → 预构建
 *    WebContentsView；产物缺失/创建失败 → 回落 Urchin 内置查看器（保底策略）
 * 3. guardTabClose / confirmWindowClose：关闭前复用 GenOffice 自己的
 *    Save / Don't Save / Cancel 原生三键对话框
 *
 * 边界：本模块不 import vendor 类型（loader 暴露最小接口），产物缺失时
 * available=false，全部路径退化为浏览器原生行为。
 */
import type { BrowserWindow, IpcMain } from 'electron';
import { basename } from 'node:path';
import { createLogger } from '@urchin/logger';
import type { TabManager } from '../tabs/tab-manager';
import type { WindowManager } from '../windows/window-manager';
import { registerGenOfficeHostChannels, type GenOfficeAiPanelPrefsStore } from './host-channels';
import { loadGenOfficeEmbed, type GenOfficeEmbedApi } from './loader';
import { GENOFFICE_HOME_URL, resolveGenOfficeArtifacts, resolveShellRendererRoot } from './paths';
import { buildFileUrl, buildFileViewerUrl, parseGenOfficeUrl } from './url';

const log = createLogger('genoffice');

export interface GenOfficeIntegrationDeps {
  readonly ipcMain: IpcMain;
  readonly tabManager: TabManager;
  readonly windowManager: WindowManager;
  /** 宿主当前主题 getter（app:get-theme 用）。 */
  readonly getTheme: () => string;
  /** 共享的 AI 面板偏好存储（Home 设置与编辑器侧切按钮共用）。 */
  readonly aiPanelPrefs?: GenOfficeAiPanelPrefsStore;
  /**
   * 创建 GenOffice shell Home 视图（宿主以自有 preload 承载 window.aiOffice）。
   * 返回 null = shell 产物缺失，调用方回落 React 保底主页。
   */
  readonly createHomeView?: () => unknown;
}

/** tab.create 的分流结果（view 存在时由 TabManager 直接使用）。 */
export interface GenOfficeTabCreate {
  readonly url: string;
  readonly view?: unknown;
  readonly viewKind: 'browser' | 'genoffice';
  readonly genofficeKind?: string;
  /** 标签标题（文件名；编辑器页面 document.title 为空时不至于显示伪地址）。 */
  readonly title?: string;
}

export interface GenOfficeIntegration {
  /** 嵌入包已加载且初始化成功（false = 全部回落到 Urchin 内置查看器）。 */
  readonly available: boolean;
  /** 阶段 3：GenOffice 原生 AI 通道已注册（编辑器 AI 面板/设置界面可用）。 */
  readonly aiAvailable: boolean;
  install(): void;
  resolveTabCreate(url: string): GenOfficeTabCreate;
  /** 关闭前守卫；resolve true = 允许关闭。 */
  guardTabClose(tabId: number): Promise<boolean>;
  /** 整窗关闭守卫：逐个脏编辑器确认；任一取消返回 false。 */
  confirmWindowClose(windowId: number): Promise<boolean>;
  /** 宿主退出清理：停 sheets Rust sidecar 子进程（防孤儿 xlsx-sidecar.exe）。 */
  stopProcesses(): void;
}

export function createGenOfficeIntegration(deps: GenOfficeIntegrationDeps): GenOfficeIntegration {
  let embed: GenOfficeEmbedApi | null = null;
  let available = false;
  let aiAvailable = false;

  /** 不发 dirty-changed 推送的 kind（脏状态经轮询补齐）按 tabId 的定时器。 */
  const polledDirtyTimers = new Map<number, ReturnType<typeof setInterval>>();

  /**
   * 产物缺失时的保底地址：HTML 走 file:// 直开（原行为），其余走内置查看器。
   */
  function fallbackUrl(kind: string, filePath: string): string {
    return kind === 'html' ? buildFileUrl(filePath) : buildFileViewerUrl(filePath);
  }

  /**
   * docs / slides / sheets 编辑器不发 dirty-changed 推送：
   * - docs 脏状态经 close-check 握手异步查询（`docsQueryDirty`）；
   * - slides 脏状态由主进程 sessions map 同步判定（`slidesIsDirty`），但不主动推送；
   * - sheets 脏状态由 pendingEditCount > 0 判定，同样不主动推送。
   * 侧栏脏点统一由 2s 轮询 `genOfficeIsDirty(kind, wc)` 补齐；
   * md/pdf/html 仍走 `${kind}:dirty-changed` 即时通道。
   */
  function startPolledDirtyKinds(): void {
    deps.tabManager.on('created', (snapshot) => {
      const tab = deps.tabManager.getTab(snapshot.id);
      if (!tab) return;
      if (tab.viewKind !== 'genoffice') return;
      // 仅 docs/slides/sheets 走轮询；其余 kind 走 dirty-changed 推送（见 install 旁路）
      if (
        tab.genofficeKind !== 'docs' &&
        tab.genofficeKind !== 'slides' &&
        tab.genofficeKind !== 'sheets'
      )
        return;
      if (polledDirtyTimers.has(snapshot.id)) return;
      const pollKind = tab.genofficeKind;
      const timer = setInterval(() => {
        const current = deps.tabManager.getTab(snapshot.id);
        if (!current || !embed) {
          stopPolledDirty(snapshot.id);
          return;
        }
        void embed
          .genOfficeIsDirty(pollKind, current.webContents)
          .then((dirty) => deps.tabManager.setDirty(snapshot.id, dirty))
          .catch(() => undefined);
      }, 2000);
      // 不阻塞应用退出
      (timer as { unref?: () => void }).unref?.();
      polledDirtyTimers.set(snapshot.id, timer);
    });
    deps.tabManager.on('removed', (snapshot) => stopPolledDirty(snapshot.id));
  }

  function stopPolledDirty(tabId: number): void {
    const timer = polledDirtyTimers.get(tabId);
    if (timer) {
      clearInterval(timer);
      polledDirtyTimers.delete(tabId);
    }
  }

  function install(): void {
    // 应用级通道无条件注册：即使产物缺失也不影响浏览器本体
    registerGenOfficeHostChannels(deps.ipcMain, {
      getTheme: deps.getTheme,
      ...(deps.aiPanelPrefs ? { aiPanelPrefs: deps.aiPanelPrefs } : {}),
    });

    const artifacts = resolveGenOfficeArtifacts();
    const loaded = loadGenOfficeEmbed();
    if (!artifacts || !loaded) {
      log.info('genoffice artifacts unavailable — editor tabs fall back to built-in viewer');
      return;
    }

    // shell Home 渲染产物（阶段 4.6）：有则随 genoffice-app:// 协议一并服务
    const shellRoot = resolveShellRendererRoot();

    try {
      loaded.initGenOfficeEmbed({
        rendererRoots: artifacts.rendererRoots,
        preloads: artifacts.preloads,
        ...(artifacts.sheetsSidecarPath ? { sheetsSidecarPath: artifacts.sheetsSidecarPath } : {}),
        ...(shellRoot ? { extraRendererRoots: { shell: shellRoot } } : {}),
      });
    } catch (e) {
      log.error('genoffice embed init failed', { error: String(e) });
      return;
    }

    // 阶段 3：GenOffice 原生 AI（ai:*）与会话存储（project:*）。
    // 与 Urchin/pi 完全隔离：模型/密钥走 GenOffice 自己的 ai-settings.json，
    // 编辑器 AI 面板由其自带前端驱动。失败仅降级 AI 能力，不影响编辑器。
    if (typeof loaded.initGenOfficeAi === 'function') {
      try {
        loaded.initGenOfficeAi();
        aiAvailable = true;
      } catch (e) {
        log.error('genoffice ai init failed — AI panels stay unavailable', {
          error: String(e),
        });
      }
    }

    // dirty 旁路：通道名 `${kind}:dirty-changed`（GenOffice 编辑器 main 内的
    // 自有监听不受影响；此处仅同步到标签快照）
    for (const kind of Object.keys(artifacts.rendererRoots)) {
      deps.ipcMain.on(`${kind}:dirty-changed`, (event, dirty) => {
        const tab = deps.tabManager.getTabByWebContents(event.sender);
        if (tab) deps.tabManager.setDirty(tab.id, dirty === true);
      });
    }

    embed = loaded;
    available = true;
    startPolledDirtyKinds();
    log.info('genoffice editor integration ready', {
      kinds: Object.keys(artifacts.rendererRoots),
    });
  }

  function resolveTabCreate(url: string): GenOfficeTabCreate {
    // GenOffice Home 入口（阶段 4.6，用户指令）：直接使用上游 shell Home 前端。
    // 宿主以自有 preload 创建 WebContentsView（window.aiOffice 适配层）；
    // shell 产物缺失时回落为浏览器标签 → 渲染进程的 React 保底主页。
    if (url === GENOFFICE_HOME_URL || url.startsWith(`${GENOFFICE_HOME_URL}/`)) {
      const view = deps.createHomeView?.();
      if (view) {
        return {
          url: GENOFFICE_HOME_URL,
          view,
          viewKind: 'genoffice',
          genofficeKind: 'shell',
          title: 'GenOffice',
        };
      }
      return { url: GENOFFICE_HOME_URL, viewKind: 'browser' };
    }

    const target = parseGenOfficeUrl(url);
    if (!target) return { url, viewKind: 'browser' };
    if (!embed || !available) {
      return { url: fallbackUrl(target.kind, target.path), viewKind: 'browser' };
    }
    try {
      const view = embed.createGenOfficeView(target.kind, target.path);
      return {
        url,
        view,
        viewKind: 'genoffice',
        genofficeKind: target.kind,
        title: basename(target.path),
      };
    } catch (e) {
      log.error('create genoffice view failed — falling back to built-in viewer', {
        kind: target.kind,
        error: String(e),
      });
      return { url: fallbackUrl(target.kind, target.path), viewKind: 'browser' };
    }
  }

  async function guardTabClose(tabId: number): Promise<boolean> {
    const tab = deps.tabManager.getTab(tabId);
    if (!tab) return true;
    // shell Home 无脏状态/保存流程，无需守卫
    if (tab.viewKind !== 'genoffice' || !tab.genofficeKind || tab.genofficeKind === 'shell') {
      return true;
    }
    if (!embed) return true;
    const win = deps.windowManager.getWindow(tab.windowId)?.browserWindow as unknown as
      BrowserWindow | undefined;
    return embed.requestGenOfficeClose(tab.genofficeKind, tab.webContents, win);
  }

  async function confirmWindowClose(windowId: number): Promise<boolean> {
    for (const snapshot of deps.tabManager.query({ windowId })) {
      if (snapshot.viewKind !== 'genoffice' || !snapshot.dirty) continue;
      const ok = await guardTabClose(snapshot.id);
      if (!ok) return false;
    }
    return true;
  }

  function stopProcesses(): void {
    try {
      // 只停子进程（Rust sidecar）；webContents/定时器由宿主统一销毁
      embed?.stopGenOfficeSidecars?.();
    } catch (e) {
      log.error('genoffice sidecar stop failed on quit', { error: String(e) });
    }
  }

  return {
    get available() {
      return available;
    },
    get aiAvailable() {
      return aiAvailable;
    },
    install,
    resolveTabCreate,
    guardTabClose,
    confirmWindowClose,
    stopProcesses,
  };
}
