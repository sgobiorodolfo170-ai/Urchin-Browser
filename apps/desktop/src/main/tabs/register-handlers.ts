/**
 * M2 Tab Manager · Tab IPC Handler 注册
 *
 * 依据：契约 B §3.1 tab.* 通道 / 契约 D §2 / 04-模块全景 M2/M17
 * 职责：
 * 注册 tab.create / tab.close / tab.list / tab.setActive /
 *      tab.reload / tab.goBack / tab.goForward IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 TabManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 * - reload/goBack/goForward 直接调用 webContents，M3 Navigation Stack 将增加事件与状态同步
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { fallbackGenOfficeUrl } from '../genoffice/url';
import type { TabManager } from './tab-manager';
import type { BrowserViewLike } from './types';

const log = createLogger('tab-ipc');

/** tab handler 可注入依赖（阶段 2 GenOffice 集成；缺省 = 浏览器原生行为）。 */
export interface TabHandlerDeps {
  readonly genoffice?: {
    resolveTabCreate(url: string): {
      url: string;
      view?: unknown;
      viewKind: 'browser' | 'genoffice';
      genofficeKind?: string;
      /** 标签标题（文件名兜底；可选）。 */
      title?: string;
    };
    /** 关闭前守卫（GenOffice 原生保存/放弃/取消）；false = 取消关闭。 */
    guardTabClose(tabId: number): Promise<boolean>;
  };
}

/**
 * 注册 tab 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param tabManager TabManager 实例
 * @param deps 可注入依赖（GenOffice 集成；单测可省略）
 */
export function registerTabHandlers(
  ipcMain: IpcMain,
  tabManager: TabManager,
  deps: TabHandlerDeps = {},
): void {
  // tab.create：创建新标签
  // 阶段 2：URL 命中 GenOffice 伪地址时改用预构建编辑器 WebContentsView；
  // 产物缺失/创建失败由集成层回落为 urchin://file-viewer（保底）。
  // 集成整体停用（URCHIN_DISABLE_GENOFFICE=1）时 deps.genoffice 缺省，
  // 此处把带路径的伪地址改写为内置查看器，保证降级模式下「打开文件」仍可用。
  registerHandler(ipcMain, 'tab.create', (req) => {
    log.info('tab.create', { windowId: req.windowId, url: req.url });

    const resolved = deps.genoffice?.resolveTabCreate(req.url) ?? {
      url: deps.genoffice ? req.url : fallbackGenOfficeUrl(req.url),
      viewKind: 'browser' as const,
    };

    // 仅 genoffice 标签携带 view/viewKind，保持普通网页 create 调用形状不变
    //（既有单测断言精确参数；也避免脏状态字段外溢）
    const tab = tabManager.create({
      windowId: req.windowId,
      url: resolved.url,
      active: req.active,
      index: req.index,
      workspaceId: req.workspaceId,
      ...(resolved.view
        ? { view: resolved.view as BrowserViewLike, viewKind: resolved.viewKind }
        : {}),
      ...(resolved.viewKind === 'genoffice' ? { genofficeKind: resolved.genofficeKind } : {}),
    });

    // GenOffice 编辑器页面 document.title 为空：用文件名兜底（伪地址不作标题）
    if (resolved.title) {
      tab.title = resolved.title;
    }

    const snapshot = tabManager.getSnapshot(tab.id);
    if (!snapshot) {
      throw new Error(`Failed to snapshot newly created tab ${tab.id}`);
    }

    return { tab: snapshot };
  });

  // tab.close：关闭指定标签
  // 阶段 2：genoffice 标签先过编辑器自己的关闭守卫（原生三键对话框）；
  // 用户取消时 closed=false，标签保留（渲染层无需回滚——主进程未发事件）。
  registerHandler(ipcMain, 'tab.close', async (req) => {
    log.info('tab.close', { tabId: req.tabId });

    const allowed = (await deps.genoffice?.guardTabClose(req.tabId)) ?? true;
    if (!allowed) {
      return { ok: true as const, tabId: req.tabId, closed: false };
    }

    tabManager.remove(req.tabId);

    return { ok: true as const, tabId: req.tabId, closed: true };
  });

  // tab.list：查询标签列表
  registerHandler(ipcMain, 'tab.list', (req) => {
    log.info('tab.list', { windowId: req.windowId });

    const tabs = tabManager.query({ windowId: req.windowId });

    return { tabs };
  });

  // tab.setActive：激活指定标签
  registerHandler(ipcMain, 'tab.setActive', (req) => {
    log.info('tab.setActive', { tabId: req.tabId });

    tabManager.setActive(req.tabId);

    const snapshot = tabManager.getSnapshot(req.tabId);
    if (!snapshot) {
      throw new Error(`Tab not found after setActive: ${req.tabId}`);
    }

    return { tab: snapshot };
  });

  // tab.reload：重新加载标签
  registerHandler(ipcMain, 'tab.reload', (req) => {
    log.info('tab.reload', { tabId: req.tabId, ignoreCache: req.ignoreCache });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (req.ignoreCache) {
      tab.webContents.reloadIgnoringCache();
    } else {
      tab.webContents.reload();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.goBack：后退
  registerHandler(ipcMain, 'tab.goBack', (req) => {
    log.info('tab.goBack', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (tab.canGoBack) {
      tab.webContents.goBack();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.goForward：前进
  registerHandler(ipcMain, 'tab.goForward', (req) => {
    log.info('tab.goForward', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${req.tabId}`);
    }

    if (tab.canGoForward) {
      tab.webContents.goForward();
    }

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.loadUrl：导航到指定 URL（M3 Navigation Stack）
  registerHandler(ipcMain, 'tab.loadUrl', (req) => {
    log.info('tab.loadUrl', { tabId: req.tabId, url: req.url });

    tabManager.loadUrl(req.tabId, req.url);

    return { ok: true as const, tabId: req.tabId, url: req.url };
  });

  // tab.stop：停止加载（M3 Navigation Stack）
  registerHandler(ipcMain, 'tab.stop', (req) => {
    log.info('tab.stop', { tabId: req.tabId });

    tabManager.stopLoading(req.tabId);

    return { ok: true as const, tabId: req.tabId };
  });

  // tab.captureThumbnail：抓取标签页网页快照（工作区总览页缩略图，浏览器视口比例）。
  // 返回 PNG data URL（限宽缩略，控制内存）；抓取失败/空白/无内容时返回 null，
  // 渲染层降级显示 favicon+标题。语义是 display-only hint，失败不影响标签功能。
  registerHandler(ipcMain, 'tab.captureThumbnail', async (req) => {
    log.info('tab.captureThumbnail', { tabId: req.tabId });

    const tab = tabManager.getTab(req.tabId);
    if (!tab) {
      return { tabId: req.tabId, dataUrl: null };
    }

    try {
      // WebContentsLike 是结构化接口（不含 capturePage），运行时即 Electron WebContents
      const wc = tab.webContents as unknown as Electron.WebContents;
      const image = await wc.capturePage();
      if (image.isEmpty()) {
        return { tabId: req.tabId, dataUrl: null };
      }
      // 缩略图限宽 480px，保持视口比例缩放，避免大 PNG 尺寸传输
      const W = 480;
      const size = image.getSize();
      const scale = size.width > W ? W / size.width : 1;
      const dataUrl = image
        .resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
        .toDataURL();
      return { tabId: req.tabId, dataUrl };
    } catch (err) {
      log.warn('captureThumbnail failed', { tabId: req.tabId, error: String(err) });
      return { tabId: req.tabId, dataUrl: null };
    }
  });

  log.info('tab ipc handlers registered');
}
