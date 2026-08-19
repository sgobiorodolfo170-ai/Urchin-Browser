/**
 * 右键菜单模块 · 原生上下文菜单（复制 / 粘贴 / 保存网页）
 *
 * 依据：02-架构设计 §4 安全边界（webContents 事件在主进程处理）/ M2 Tab Manager
 * 职责：
 * 1. 为网页 tab 的 webContents 与主窗口 webContents（React 内部页）挂接 context-menu 事件
 * 2. 弹出原生菜单：复制 / 粘贴 / 保存网页（按 editFlags 动态置灰）
 * 3. 动作全部在主进程执行——复制/粘贴经 webContents.copy()/paste()
 *    （Chromium 编辑命令），保存网页走 dialog + webContents.savePage('HTMLComplete')
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「进程隔离」）：
 * - 原生菜单方案与 Chrome 一致：菜单由主进程弹出，网页上下文（选中文本/焦点可粘贴）
 *   由 Electron context-menu 事件参数（editFlags / isEditable）提供，渲染进程零改动
 * - 不使用 preload 注入 JS 实现右键菜单——固化教训：BrowserView 注入 preload 会阻塞
 *   网页加载（见 create-browser-view.ts 头部说明）
 * - 保存网页用 savePage：与 will-download 链路互不影响（该链路处理网页内媒体/二进制
 *   下载，savePage 直接写盘、不触发 will-download 事件）
 * - 保存网页单独立项（用户决策 2026-08-18）：默认目录为 <数据目录>/saved-pages/，
 *   不复用下载目录 downloads/，不读 downloadsPath 设置，不接入 DownloadManager
 * - 主窗口 webContents（新标签页/设置页等 React 内部页）同样挂右键菜单：
 *   复制/粘贴可用，保存网页禁用（内部页保存无意义）；真实鼠标右键在 BrowserView
 *   上的事件坐标相对页面，popup 坐标相对窗口，需按 BrowserView 偏移量补偿
 *   （否则菜单出现在鼠标左侧 44px——BrowserView 水平起点即左侧栏宽度）
 */
import { Menu, dialog, BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { TabManager } from '../tabs/tab-manager';
import type { TabSnapshot } from '../tabs/types';
import { createLogger } from '@urchin/logger';

const log = createLogger('context-menu');

/** 保存网页默认子目录名（数据目录下独立目录；与下载目录 downloads 无关） */
const SAVED_PAGES_DIR = 'saved-pages';

/** 内部协议前缀（urchin:// 内部页保存无意义，置灰「保存网页」） */
const INTERNAL_URL_PREFIX = 'urchin://';

/** 保存网页对话框的文件类型过滤器 */
const HTML_FILTERS = [{ name: 'HTML 文件', extensions: ['html', 'htm'] }];

/** 右键菜单依赖注入（便于测试与解耦） */
export interface ContextMenuDeps {
  /** 用户数据目录绝对路径（保存网页默认目录 <数据目录>/saved-pages/ 的父目录） */
  getDataDir: () => string;
}

/** 菜单项（原生 MenuItemConstructorOptions 的测试友好子集） */
export type ContextMenuTemplateItem =
  { type: 'separator' } | { label: string; enabled: boolean; click?: () => void };

/** context-menu 事件参数的测试友好子集（Electron ContextMenuParams 结构兼容） */
export interface ContextMenuParamsLite {
  isEditable?: boolean;
  editFlags?: { canCopy?: boolean; canPaste?: boolean };
}

/** 右键菜单目标页信息（用于「保存网页」默认文件名与内部页禁用判断） */
export interface ContextMenuTabInfo {
  id?: number;
  url: string;
  title: string;
}

/**
 * 生成右键菜单模板（纯函数，可单测）。
 *
 * 规则：
 * - 复制：按 editFlags.canCopy 置灰（页面无可复制内容时不响应）
 * - 粘贴：按 editFlags.canPaste 置灰（输入框焦点才可粘贴）
 * - 保存网页：urchin:// 内部页（React 渲染，保存无意义）置灰
 *
 * @param params context-menu 事件参数（editFlags 缺失时按可用处理，兼容测试 mock）
 * @param tab 右键所在页面（可能为 undefined：异常场景）
 * @param actions 菜单点击执行的回调（由安装方绑定 webContents 后注入）
 */
export function buildMenuTemplate(
  params: ContextMenuParamsLite,
  tab: ContextMenuTabInfo | undefined,
  actions: { copy: () => void; paste: () => void; save: () => void },
): ContextMenuTemplateItem[] {
  const canCopy = params.editFlags?.canCopy ?? true;
  const canPaste = params.editFlags?.canPaste ?? true;
  const isInternalPage = tab?.url.startsWith(INTERNAL_URL_PREFIX) ?? false;
  return [
    { label: '复制', enabled: canCopy, click: () => actions.copy() },
    { label: '粘贴', enabled: canPaste, click: () => actions.paste() },
    { type: 'separator' },
    { label: '保存网页为…', enabled: !isInternalPage, click: () => actions.save() },
  ];
}

/**
 * 文件名清洗：剔除 Windows 非法字符（\ / : * ? " < > |），空串回退默认名。
 *
 * 保存网页默认文件名取页面标题，标题可能含非法字符导致保存失败。
 */
export function sanitizeFilename(name: string, fallback = 'page'): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || fallback;
}

/**
 * 保存网页完整流程：默认目录兜底创建 → 保存对话框 → 补扩展名 → savePage('HTMLComplete')。
 *
 * 默认目录恒为 <数据目录>/saved-pages/（保存网页单独立项，与下载目录/下载设置无关），
 * 对话框允许用户改到任意位置；不接入 DownloadManager。
 *
 * @returns 保存结果（取消返回 saved:false；写盘失败 throw 由调用方捕获）
 */
export async function saveCurrentPage(
  wc: WebContents,
  tab: { id?: number; url: string; title: string },
  deps: ContextMenuDeps,
): Promise<{ saved: boolean; path?: string }> {
  const savedDir = join(deps.getDataDir(), SAVED_PAGES_DIR);
  try {
    // 默认目录不存在时先创建，否则对话框默认路径指向不存在的目录会保存失败
    mkdirSync(savedDir, { recursive: true });
  } catch (err) {
    log.warn('failed to ensure saved-pages directory', { error: String(err) });
  }
  const defaultPath = join(savedDir, `${sanitizeFilename(tab.title)}.html`);

  const win = BrowserWindow.fromWebContents(wc);
  const options: Electron.SaveDialogOptions = {
    title: '保存网页',
    defaultPath,
    buttonLabel: '保存',
    filters: HTML_FILTERS,
  };
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }

  // 用户手改去掉扩展名时补 .html，保证产物可双击打开（savePage 不负责补扩展名）
  let target = result.filePath;
  if (!/\.html?$/i.test(target)) {
    target += '.html';
  }

  await wc.savePage(target, 'HTMLComplete');
  log.info('page saved', { path: target });
  return { saved: true, path: target };
}

/**
 * 安装网页 tab 的右键菜单。
 *
 * 通过 TabManager 的 created 事件对每个新建 tab 的 webContents 挂接
 * context-menu 监听，同时对已存在的 tab 补装（安装时机晚于首次创建时兜底）。
 *
 * @returns 卸载函数（移除 created 监听；webContents 随 tab 销毁自动释放）
 */
export function installTabContextMenu(tabManager: TabManager, deps: ContextMenuDeps): () => void {
  const attach = (wc: unknown): void => {
    const electronWc = wc as WebContents;
    if (!electronWc || typeof electronWc.on !== 'function') return;
    electronWc.on('context-menu', (_event, params: Electron.ContextMenuParams) => {
      const tab = tabManager.getTabByWebContents(electronWc);
      const tabInfo = tab ? { id: tab.id, url: tab.url, title: tab.title } : undefined;
      // BrowserView 的 params 坐标相对页面，popup 坐标相对窗口：
      // 补偿 BrowserView 在窗口内的偏移（其水平起点 = 左侧栏宽度），避免菜单错位
      const offset = tab?.view.getBounds ? tab.view.getBounds() : { x: 0, y: 0 };
      handleContextMenu(electronWc, params, tabInfo, deps, offset);
    });
  };

  const onTabCreated = (snapshot: TabSnapshot): void => {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) attach(tab.webContents);
  };
  tabManager.on('created', onTabCreated);

  // 补装已存在 tab（首次安装发生在初始 tab 创建之后等场景）
  for (const snapshot of tabManager.query({})) {
    const tab = tabManager.getTab(snapshot.id);
    if (tab) attach(tab.webContents);
  }

  return () => {
    tabManager.off('created', onTabCreated);
  };
}

/**
 * 单个右键菜单弹出与动作分发（供网页 tab 与主窗口 webContents 共用）。
 *
 * @param tabInfo 页面信息：urchin:// 前缀禁用「保存网页」
 * @param offset 弹出坐标补偿（BrowserView 相对窗口的偏移；主窗口传 {x:0,y:0}）
 */
export function handleContextMenu(
  wc: WebContents,
  params: Electron.ContextMenuParams,
  tabInfo: ContextMenuTabInfo | undefined,
  deps: ContextMenuDeps,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): void {
  const template = buildMenuTemplate(params, tabInfo, {
    copy: () => {
      try {
        wc.copy();
      } catch (err) {
        log.warn('copy failed', { error: String(err) });
      }
    },
    paste: () => {
      try {
        wc.paste();
      } catch (err) {
        log.warn('paste failed', { error: String(err) });
      }
    },
    save: () => {
      if (tabInfo && !tabInfo.url.startsWith(INTERNAL_URL_PREFIX)) {
        saveCurrentPage(wc, tabInfo, deps).catch((err) => {
          log.warn('save page failed', { tabId: tabInfo.id, error: String(err) });
        });
      }
    },
  });

  try {
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: BrowserWindow.fromWebContents(wc) ?? undefined,
      x: Math.round(params.x + offset.x),
      y: Math.round(params.y + offset.y),
    });
  } catch (err) {
    // 页面/窗口正在销毁时弹出可能失败，静默忽略
    log.warn('context menu popup failed', { error: String(err) });
  }
}
