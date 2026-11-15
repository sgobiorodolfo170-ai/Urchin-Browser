/**
 * 收藏栏文件夹菜单（独立子窗口，定位在文件夹按钮正下方）
 *
 * 2026-11-15 重设计（用户需求）：原主进程原生菜单（Menu.popup）改为渲染层
 * 子窗口，与主页「常用网站」弹窗共用同一 React 列表组件（BookmarkListPanel），
 * 行前显示网站图标。为什么必须用子窗口：主窗口网页是 WebContentsView，永远
 * 渲染在主窗口 webContents（React）之上，渲染层浮层会被网页遮挡——收藏夹
 * 悬浮面板（bookmark-panel.ts）已验证「独立 BrowserWindow 天然悬浮置顶」，
 * 本类沿用同一机制（创建 / blur 关闭 / 跟随主窗口），定位改为主流浏览器的
 * 「按钮正下方弹出 + 屏幕边缘翻转」。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';
import type { PanelHostWindow } from '../panel/bookmark-panel';

const log = createLogger('folder-menu-window');

/**
 * 菜单窗口宽度。比收藏夹面板（280）宽：列表行是「图标 + 标题/URL 双行 +
 * 取消收藏」的卡片排版（与主页弹窗同款组件），280px 下 URL 几乎全截断。
 */
export const FOLDER_MENU_WIDTH = 380;
/** 菜单最大高度：超出后列表内部滚动 */
export const FOLDER_MENU_MAX_HEIGHT = 480;
/** 菜单最小高度（空文件夹：标题行 + 空态提示） */
export const FOLDER_MENU_MIN_HEIGHT = 110;
/** 与按钮的垂直间隙 */
const ANCHOR_GAP = 4;
/** 与窗口边缘的安全边距 */
const EDGE_MARGIN = 8;
/** 菜单窗口外框宽（Windows 不可调边框为 0？统一按 8px 余量处理，与 bookmark-panel 同口径） */
const WINDOW_FRAME_WIDTH = 8;

/**
 * 按首层子项数估算窗口高度：标题行（约 44px）+ 每行（约 56px：双行文本 + p-3）
 * + 容器 padding。仅首层精确，下钻层级由列表内部滚动兜底。
 */
export function estimateFolderMenuHeight(childCount: number): number {
  return Math.min(FOLDER_MENU_MAX_HEIGHT, Math.max(FOLDER_MENU_MIN_HEIGHT, 68 + childCount * 56));
}

export interface FolderMenuOptions {
  /** 获取宿主主窗口（null = 主窗口尚未创建） */
  getParentWindow: () => PanelHostWindow | null;
  /** 主窗口 preload 脚本路径（子窗口复用，file/urchin 下暴露 window.urchin） */
  preloadPath: string;
  /** 加载菜单页面（panel.html?mode=folder-menu&folderId=...） */
  onLoad: (win: BrowserWindow, folderId: string) => Promise<void>;
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export class FolderMenuWindow {
  private menu: BrowserWindow | null = null;
  private readonly options: FolderMenuOptions;
  /** 打开时的锚点（屏幕坐标，DIP）与窗口高度，供边缘翻转与主窗口移动时重定位 */
  private anchor: { x: number; y: number } | null = null;
  private height = 0;

  constructor(options: FolderMenuOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.menu !== null && !this.menu.isDestroyed();
  }

  /**
   * 在锚点（文件夹按钮左下角，屏幕 DIP 坐标）下方打开菜单；已打开则先关闭再开
   * （点击另一个文件夹 = 换菜单；点击同一按钮 = blur 已关闭、click 再打开）。
   */
  open(folderId: string, anchor: { x: number; y: number }, childCount: number): void {
    if (this.isOpen) this.close();
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('folder menu: parent window not available');
      return;
    }
    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const height = estimateFolderMenuHeight(childCount);
    const menu = create({
      width: FOLDER_MENU_WIDTH,
      height,
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.anchor = anchor;
    this.height = height;
    this.reposition(menu, parent);
    // 点击菜单外任意处（主窗口/网页/另一处收藏栏）自动关闭
    menu.on('blur', () => this.close());
    // 跟随主窗口移动/缩放（按钮相对内容区位置不变，按最新 bounds 重定位）
    const onParentMove = (): void => {
      if (this.isOpen && !menu.isDestroyed()) this.reposition(menu, parent);
    };
    parent.on('move', onParentMove);
    parent.on('resize', onParentMove);
    menu.on('closed', () => {
      parent.removeListener?.('move', onParentMove);
      parent.removeListener?.('resize', onParentMove);
      this.menu = null;
      this.anchor = null;
    });
    this.menu = menu;
    // 加载失败销毁，避免不可见僵尸窗口（与 bookmark-panel 同模式）
    void this.options.onLoad(menu, folderId).catch((err: unknown) => {
      log.error('folder menu load failed', { error: String(err) });
      if (!menu.isDestroyed()) {
        menu.destroy();
        this.menu = null;
      }
    });
    menu.once('ready-to-show', () => {
      if (!menu.isDestroyed()) menu.show();
    });
    log.info('folder menu opened', { folderId, childCount });
  }

  close(): void {
    if (this.menu && !this.menu.isDestroyed()) {
      this.menu.destroy();
    }
    this.menu = null;
    this.anchor = null;
  }

  /**
   * 定位：按钮正下方（y = anchor.y + 间隙）；右缘/下缘溢出时向内/向上翻转。
   * anchor 与 parentBounds 均为屏幕 DIP 坐标，无需额外 DPI 换算。
   */
  private reposition(menu: BrowserWindow, parent: PanelHostWindow): void {
    if (!this.anchor) return;
    const bounds = parent.getContentBounds();
    const innerRight = bounds.x + bounds.width - WINDOW_FRAME_WIDTH;
    const innerBottom = bounds.y + bounds.height - WINDOW_FRAME_WIDTH;
    const x = Math.max(
      bounds.x + EDGE_MARGIN,
      Math.min(this.anchor.x, innerRight - FOLDER_MENU_WIDTH),
    );
    let y = this.anchor.y + ANCHOR_GAP;
    if (y + this.height > innerBottom) {
      // 下方放不下：向上翻转到按钮上方（仍不出窗口顶）
      y = Math.max(bounds.y + EDGE_MARGIN, this.anchor.y - this.height - ANCHOR_GAP);
    }
    menu.setPosition(Math.round(x), Math.round(y));
  }
}
