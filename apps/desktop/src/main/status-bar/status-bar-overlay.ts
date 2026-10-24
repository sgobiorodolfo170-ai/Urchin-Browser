/**
 * 底部悬浮状态栏（独立透明子窗口，悬浮于网页 BrowserView 之上）
 *
 * 设计（2026-10-23）：
 * - 状态栏不再占用主窗口布局高度，网页内容铺到窗口底部；
 *   状态栏以透明 frameless 子 BrowserWindow 悬浮于网页之上，呈现 3D 卡片。
 * - Electron BrowserView 永远渲染在主窗口 webContents 之上，React 浮层无法盖住网页，
 *   因此必须用独立 BrowserWindow（同 BookmarkPanel/CaptureOverlay 模式）。
 * - 透明 BrowserWindow 在仓库已有成功用例（capture-overlay）；不用透明 BrowserView
 *   以规避已记录的 Windows DWM/TDR 风险。
 *
 * 状态来源：主渲染进程持有 tab/建议/书签/toast/主题等状态，经本管理器缓存并转发给
 * 悬浮层；悬浮层的用户动作经本管理器转发回主渲染进程。主渲染进程仍是单一真源。
 *
 * 几何计算：悬浮层宽度 = 中区宽 × 0.6 + 阴影边距；高度 = 状态栏区域 + 阴影边距 +
 * 建议/提示展开高；底部对齐内容区底，水平居中于中区。
 */
import { BrowserWindow, Menu } from 'electron';
import { createLogger } from '@urchin/logger';
import { WINDOW_FRAME_WIDTH } from '../tabs/view-integration';
import type { StatusBarState, StatusBarToast, UiStatusBarActionReq } from '@urchin/ipc-contract';

const log = createLogger('status-bar-overlay');

/** 状态栏卡片高度（px），与渲染层 h-10 一致 */
const CARD_HEIGHT = 40;
/** 卡片四周透明阴影边距（px），用于 3D 阴影与圆角透出网页 */
const SHADOW_PAD = 8;
/** 基础窗口高度 = 卡片 + 上下阴影边距（恰好占满 48px 状态栏区域并留 8px 底距） */
const BASE_HEIGHT = CARD_HEIGHT + SHADOW_PAD * 2;
/** 状态栏宽度占中区宽度比例（3/5） */
const WIDTH_RATIO = 0.6;
/** 建议下拉额外高度（max-h-80=320 + 边距） */
const SUGGESTIONS_PANEL_HEIGHT = 332;
/** toast 额外高度 */
const TOAST_PANEL_HEIGHT = 44;

/** 默认状态（悬浮层未收到主渲染同步前使用，visible:false） */
export const DEFAULT_STATUS_BAR_STATE: StatusBarState = {
  visible: false,
  url: '',
  loading: false,
  securityState: 'insecure',
  canGoBack: false,
  canGoForward: false,
  reloadDisabled: true,
  bookmarkSaved: false,
  bookmarkable: false,
  summarizeDisabled: true,
  screenshotDisabled: true,
  translateActive: false,
  translateDisabled: true,
  searchEngine: 'duckduckgo',
  suggestions: [],
  toast: null,
  theme: 'light',
  collapsed: false,
};

/** 宿主主窗口最小依赖接口（真实 BrowserWindow 与 mock 均满足） */
export interface StatusBarHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isVisible(): boolean;
  isMinimized?(): boolean;
  focus(): void;
  close(): void;
  isDestroyed?(): boolean;
}

export interface StatusBarOverlayOptions {
  /** 获取宿主主窗口（null = 尚未创建） */
  getParentWindow: () => StatusBarHostWindow | null;
  /** 主窗口 preload 脚本路径（子窗口复用，file/urchin 下暴露 window.urchin） */
  preloadPath: string;
  /** 读取布局尺寸（左/右侧栏宽度 + 底部状态栏区域高度） */
  getLayout: () => { leftWidth: number; rightWidth: number; bottomHeight: number };
  /** 加载悬浮层页面（dev: dev server + ?view=statusbar；prod: loadFile + query） */
  onLoad: (win: BrowserWindow) => Promise<void>;
  /** 悬浮层用户动作转发（主进程转发给主渲染进程并处理焦点等） */
  onAction: (action: StatusBarAction) => void;
  /** 读取悬浮球当前 Y（供地址栏与球保持同一行；null 则用默认底部对齐） */
  getBallY?: () => number | null;
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

/** 悬浮层可上报的用户动作类型（与 IPC schema 对齐） */
export type StatusBarAction = UiStatusBarActionReq;

/** 悬浮层状态同步事件 payload（与 schema 对齐） */
export type { StatusBarState, StatusBarToast };

/**
 * 计算悬浮地址栏窗口的 bounds（屏幕坐标）。
 *
 * 导出供单测直接验证几何，不依赖 BrowserWindow。
 * 悬浮球由独立的 StatusBarBall 管理几何。
 */
export function computeStatusBarBounds(params: {
  contentBounds: { x: number; y: number; width: number; height: number };
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  panelHeight: number;
}): { x: number; y: number; width: number; height: number } {
  const { contentBounds, leftWidth, rightWidth, bottomHeight, panelHeight } = params;
  const frame = WINDOW_FRAME_WIDTH;
  const middleWidth = Math.max(0, contentBounds.width - frame * 2 - leftWidth - rightWidth);
  const barWidth = Math.round(middleWidth * WIDTH_RATIO);
  const width = barWidth + SHADOW_PAD * 2;
  // 高度 = 基础高度 + 额外面板高；但不低于基础，且不超过内容区可视高度
  const baseWithArea = Math.max(BASE_HEIGHT, bottomHeight + SHADOW_PAD);
  const height = Math.min(
    baseWithArea + panelHeight,
    Math.max(baseWithArea, contentBounds.height - frame * 2),
  );
  const x = Math.round(
    contentBounds.x + frame + leftWidth + (middleWidth - barWidth) / 2 - SHADOW_PAD,
  );
  // 底部对齐内容区底（contentBounds 下缘 - 外框）；悬浮层下缘贴内容区底
  const y = Math.round(contentBounds.y + contentBounds.height - frame - height);
  return { x, y, width, height };
}

export class StatusBarOverlay {
  private win: BrowserWindow | null = null;
  private state: StatusBarState = { ...DEFAULT_STATUS_BAR_STATE };
  private panelHeight = 0;
  private collapsed = false;
  private htmlFullscreen = false;
  private parentClosing = false;
  private parentListenersAttached = false;
  private shouldShow = false;
  private readonly options: StatusBarOverlayOptions;

  constructor(options: StatusBarOverlayOptions) {
    this.options = options;
  }

  /** 主渲染进程推送状态快照（IPC ui.statusbar.sync） */
  handleSync(state: StatusBarState): void {
    this.state = state;
    this.applyVisibility();
    this.sendState();
  }

  /** 悬浮层取缓存状态（IPC ui.statusbar.getState） */
  getState(): StatusBarState {
    return this.state;
  }

  /** 悬浮层上报额外面板高度（IPC ui.statusbar.setExpanded） */
  setExpanded(panelHeight: number): void {
    this.panelHeight = panelHeight;
    this.reposition();
  }

  /** 折叠/展开地址栏（IPC ui.statusbar.collapse / ball.click） */
  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.applyVisibility();
    this.sendState();
  }

  /** 切换折叠/展开（悬浮球点击） */
  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  /** 当前折叠态（供悬浮球点击切换） */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  /** HTML5 全屏抑制（主进程 tab 事件调用） */
  setHtmlFullscreen(suppressed: boolean): void {
    if (this.htmlFullscreen === suppressed) return;
    this.htmlFullscreen = suppressed;
    this.applyVisibility();
  }

  /** 获取地址栏窗口当前 bounds（供悬浮球防重叠；不可见时返回 null） */
  getBounds(): { x: number; y: number; width: number; height: number } | null {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return null;
    return win.getBounds();
  }

  /** 布局变化后刷新位置（侧栏宽度拖拽 / 窗口尺寸变化） */
  refreshPosition(): void {
    this.reposition();
  }

  /** 是否已创建 */
  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /** 创建并加载悬浮层窗口（幂等） */
  open(): void {
    if (this.isOpen) return;
    // 重置关闭标志（销毁后重建时）
    this.parentClosing = false;
    this.parentListenersAttached = false;
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('status bar: parent window not available');
      return;
    }

    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const win = create({
      width: 400,
      height: BASE_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      parent: parent as unknown as BrowserWindow,
      title: 'Urchin Status Bar',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;

    // 定位后再加载，避免首帧位置跳动
    this.reposition();

    // 安全：悬浮层不允许导航到外部页面或弹出新窗口
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // 地址栏 copy/paste/selectAll 右键菜单（与主窗口地址栏行为对齐）
    win.webContents.on('context-menu', (_e, params) => {
      if (!params.isEditable) return;
      const menu = Menu.buildFromTemplate([
        { role: 'cut', enabled: params.editFlags.canCut, label: '剪切' },
        { role: 'copy', enabled: params.editFlags.canCopy, label: '复制' },
        { role: 'paste', enabled: params.editFlags.canPaste, label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ]);
      menu.popup({ window: win });
    });

    // Alt+F4 / 系统关闭应关闭整个应用窗口，而非仅悬浮层。
    // 但主窗口关闭/应用退出时（parentClosing=true）放行，避免阻止退出。
    win.on('close', (e) => {
      if (this.parentClosing) return;
      e.preventDefault();
      const p = this.options.getParentWindow();
      if (p && !p.isDestroyed?.()) {
        this.parentClosing = true;
        p.close();
      }
    });

    win.on('closed', () => {
      this.win = null;
    });

    // 跟随主窗口移动/缩放/最小化/恢复重定位与可见性
    this.attachParentListeners(parent);

    // 页面加载完成后下发缓存状态并应用可见性
    win.webContents.once('did-finish-load', () => {
      this.applyVisibility();
      this.sendState();
    });

    // 透明窗口建议 ready-to-show 后显示，避免首帧白闪/合成未就绪
    win.once('ready-to-show', () => {
      if (this.shouldShow && !win.isDestroyed()) {
        win.showInactive();
        this.reposition();
      }
    });

    void this.options.onLoad(win).catch((e) => {
      log.error('status bar: failed to load page', { error: String(e) });
    });

    log.info('status bar overlay created');
  }

  /** 销毁悬浮层窗口（退出清理 / 主窗口关闭时调用） */
  destroy(): void {
    this.parentClosing = true;
    this.detachParentListeners();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }

  // ── 内部 ───────────────────────────────────────────────

  private applyVisibility(): void {
    const parent = this.options.getParentWindow();
    const parentVisible = parent ? parent.isVisible() : false;
    const parentMinimized = parent?.isMinimized?.() ?? false;
    // 外部网页可见且未折叠时显示地址栏；折叠时由悬浮球显示，地址栏隐藏。
    const shouldShow =
      this.state.visible &&
      !this.htmlFullscreen &&
      !this.collapsed &&
      parentVisible &&
      !parentMinimized;
    this.shouldShow = shouldShow;
    if (shouldShow) {
      // 懒创建：仅首次进入外部网页时创建悬浮层，之后常驻（隐藏而非销毁），
      // 避免外部/内部页切换时反复重建导致页面失效与闪烁。
      if (!this.isOpen) {
        this.open();
      } else if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) {
        this.win.showInactive();
      }
      this.reposition();
    } else if (this.win && !this.win.isDestroyed()) {
      // 内部页/AI/全屏/折叠时隐藏，不销毁（perf 场景仅打开内部页，悬浮层从未创建，无额外内存）
      if (this.win.isVisible()) {
        this.win.hide();
      }
    }
  }

  private reposition(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    const layout = this.options.getLayout();
    const bounds = computeStatusBarBounds({
      contentBounds: parent.getContentBounds(),
      leftWidth: layout.leftWidth,
      rightWidth: layout.rightWidth,
      bottomHeight: layout.bottomHeight,
      panelHeight: this.panelHeight,
    });
    // 若悬浮球位置改变，地址栏与球保持同一行：以球中心对齐卡片中心。
    const ballY = this.options.getBallY?.() ?? null;
    if (ballY !== null) {
      const BALL_SIZE = 40 + 6 * 2; // BALL_SIZE + BALL_PAD
      const ballCenterY = ballY + BALL_SIZE / 2;
      // 卡片中心在窗口内的偏移：overlayHeight - 下阴影边距 - 卡片半高
      const cardCenterOffset = bounds.height - SHADOW_PAD - CARD_HEIGHT / 2;
      bounds.y = Math.round(ballCenterY - cardCenterOffset);
    }
    win.setBounds(bounds);
  }

  private sendState(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    // 页面仍在加载时跳过，待 did-finish-load 统一下发，避免 renderer 尚未注册监听
    if (win.webContents.isLoadingMainFrame()) return;
    // 折叠态由主进程管理，覆盖同步给悬浮层
    win.webContents.send('ui.statusbar.state', { ...this.state, collapsed: this.collapsed });
  }

  private attachParentListeners(parent: StatusBarHostWindow): void {
    if (this.parentListenersAttached) return;
    const onMove = (): void => this.reposition();
    const onResize = (): void => this.reposition();
    const onShow = (): void => this.applyVisibility();
    const onHide = (): void => this.applyVisibility();
    const onMinimize = (): void => this.applyVisibility();
    const onRestore = (): void => this.applyVisibility();
    const onMaximize = (): void => this.reposition();
    const onUnmaximize = (): void => this.reposition();
    const onClosed = (): void => {
      this.parentClosing = true;
      this.destroy();
    };
    const onClose = (): void => {
      // 主窗口开始关闭时标记，放行悬浮层 close，避免阻止应用退出
      this.parentClosing = true;
    };
    parent.on('move', onMove);
    parent.on('resize', onResize);
    parent.on('show', onShow);
    parent.on('hide', onHide);
    parent.on('minimize', onMinimize);
    parent.on('restore', onRestore);
    parent.on('maximize', onMaximize);
    parent.on('unmaximize', onUnmaximize);
    parent.on('close', onClose);
    parent.on('closed', onClosed);
    this.parentListenersAttached = true;
    // 缓存以支持解绑
    this.parentDisposers = [
      () => parent.removeListener?.('move', onMove),
      () => parent.removeListener?.('resize', onResize),
      () => parent.removeListener?.('show', onShow),
      () => parent.removeListener?.('hide', onHide),
      () => parent.removeListener?.('minimize', onMinimize),
      () => parent.removeListener?.('restore', onRestore),
      () => parent.removeListener?.('maximize', onMaximize),
      () => parent.removeListener?.('unmaximize', onUnmaximize),
      () => parent.removeListener?.('close', onClose),
      () => parent.removeListener?.('closed', onClosed),
    ];
  }

  private parentDisposers: (() => void)[] = [];

  private detachParentListeners(): void {
    for (const dispose of this.parentDisposers) {
      try {
        dispose();
      } catch {
        // 忽略：父窗口可能已销毁
      }
    }
    this.parentDisposers = [];
    this.parentListenersAttached = false;
  }
}

/** 供悬浮层渲染层根据状态/焦点计算额外面板高度（与主进程常量保持一致） */
export function computeStatusBarPanelHeight(params: {
  suggestionsOpen: boolean;
  toast: StatusBarToast | null;
}): number {
  if (params.suggestionsOpen) return SUGGESTIONS_PANEL_HEIGHT;
  if (params.toast) return TOAST_PANEL_HEIGHT;
  return 0;
}
