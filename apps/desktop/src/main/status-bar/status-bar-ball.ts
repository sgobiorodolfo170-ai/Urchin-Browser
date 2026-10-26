/**
 * 底部悬浮球（独立透明子窗口，位于网页区最右侧、不遮挡滚动条）。
 *
 * 2026-10-24：状态栏折叠后地址栏隐藏，悬浮球始终显示于网页区右下角。
 * - 点击悬浮球：展开/折叠地址栏（由 StatusBarOverlay 管理）。
 * - 按住悬浮球拖动：上下/左右滚动网页（经主进程转发到活跃 tab webContents）。
 * - 拖动时球体轻微位移配合，反方向残影阴影辅助视觉识别。
 *
 * 悬浮球为独立 BrowserWindow，避免与地址栏窗口的透明区域互相影响点击穿透。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';
import { WINDOW_FRAME_WIDTH } from '../tabs/view-integration';

const log = createLogger('status-bar-ball');

/** 悬浮球直径（px） */
const BALL_SIZE = 40;
/** 球四周阴影/边距（px） */
const BALL_PAD = 6;
/** 网页滚动条宽度（px），球需让出此宽度避免遮挡滑块 */
const SCROLLBAR_WIDTH = 17;
/** 球与滚动条之间的间隙（px） */
const BALL_GAP = 8;

export interface StatusBarBallHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isVisible(): boolean;
  isMinimized?(): boolean;
  isDestroyed?(): boolean;
}

export interface StatusBarBallOptions {
  getParentWindow: () => StatusBarBallHostWindow | null;
  preloadPath: string;
  onLoad: (win: BrowserWindow) => Promise<void>;
  /** 折叠/展开地址栏（球点击调用） */
  onToggleCollapse: () => void;
  /** 拖动滚动网页（dx/dy 像素，正值向右/下） */
  onScroll: (dx: number, dy: number) => void;
  /** 位置改变后回调（通知地址栏对齐同一行） */
  onPositionChanged?: () => void;
  /** 获取地址栏窗口当前 bounds（用于防重叠；null 表示地址栏不可见） */
  getBarBounds?: () => { x: number; y: number; width: number; height: number } | null;
  /** 读取布局尺寸（右栏宽度等，球定位需让出右侧栏） */
  getLayout?: () => { leftWidth: number; rightWidth: number; bottomHeight: number };
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

/**
 * 计算悬浮球窗口 bounds（屏幕坐标）。
 * 导出供单测验证几何。
 * 球定位在 BrowserView/WebContentsView 的滚动条左侧（不遮挡滚动条，不进入右侧栏区域）。
 */
export function computeBallBounds(params: {
  contentBounds: { x: number; y: number; width: number; height: number };
  bottomHeight: number;
  /** 右侧栏宽度（球需让出此区域，定位在网页区右缘而非窗口右缘） */
  rightWidth?: number;
}): { x: number; y: number; width: number; height: number } {
  const { contentBounds, bottomHeight, rightWidth = 0 } = params;
  const frame = WINDOW_FRAME_WIDTH;
  const size = BALL_SIZE + BALL_PAD * 2;
  // 网页区右缘 = 内容区右缘 - 外框 - 右侧栏宽度
  // 球右缘 = 网页区右缘 - 滚动条 - 间隙
  const x = Math.round(
    contentBounds.x + contentBounds.width - frame - rightWidth - SCROLLBAR_WIDTH - BALL_GAP - size,
  );
  // 垂直居中于底部状态栏区域：底部对齐内容区底，上移 (bottomHeight - size)/2
  const y = Math.round(
    contentBounds.y + contentBounds.height - frame - size - Math.max(0, (bottomHeight - size) / 2),
  );
  return { x, y, width: size, height: size };
}

export class StatusBarBall {
  private win: BrowserWindow | null = null;
  private visible = false;
  private parentClosing = false;
  private parentListenersAttached = false;
  private readonly options: StatusBarBallOptions;

  constructor(options: StatusBarBallOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /** 设置可见性（球在所有页面常驻；仅全屏/最小化时隐藏） */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && !this.isOpen) {
      this.open();
    }
    this.applyVisibility();
  }

  /** 右键拖动移动球位置（可拖出主窗口到桌面任意位置；不可拖入地址栏区域） */
  moveBy(dx: number, dy: number): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (dx === 0 && dy === 0) return;
    const pos = win.getPosition();
    const x = pos[0] ?? 0;
    const y = pos[1] ?? 0;
    const newX = x + Math.round(dx);
    const newY = y + Math.round(dy);
    // 防重叠：若新位置与地址栏窗口相交，则不允许移动
    const barBounds = this.options.getBarBounds?.();
    if (barBounds) {
      const ballSize = BALL_SIZE + BALL_PAD * 2;
      const intersects =
        newX < barBounds.x + barBounds.width &&
        newX + ballSize > barBounds.x &&
        newY < barBounds.y + barBounds.height &&
        newY + ballSize > barBounds.y;
      if (intersects) return; // 拖入地址栏区域，拒绝移动
    }
    win.setPosition(newX, newY);
    this.options.onPositionChanged?.();
  }

  /** 当前球窗口 Y（供地址栏对齐同一行） */
  getY(): number | null {
    const win = this.win;
    if (!win || win.isDestroyed()) return null;
    const pos = win.getPosition();
    return pos[1] ?? null;
  }

  /** 布局变化后刷新位置 */
  refreshPosition(): void {
    this.reposition();
  }

  /** 下发配置（主题 + 上下/左右灵敏度）给球窗口 */
  sendConfig(config: {
    theme: 'light' | 'dark';
    sensitivityVertical: number;
    sensitivityHorizontal: number;
  }): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isLoadingMainFrame()) return;
    win.webContents.send('ui.statusbar.ball.state', config);
  }

  /** HTML5 全屏抑制（主进程 tab 事件调用） */
  setSuppressed(suppressed: boolean): void {
    if (suppressed) {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        this.win.hide();
      }
    } else {
      this.applyVisibility();
    }
  }

  /** 创建并加载球窗口（幂等） */
  open(): void {
    if (this.isOpen) return;
    this.parentClosing = false;
    this.parentListenersAttached = false;
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('ball: parent window not available');
      return;
    }
    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const win = create({
      width: BALL_SIZE + BALL_PAD * 2,
      height: BALL_SIZE + BALL_PAD * 2,
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
      title: 'Urchin Status Ball',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    this.reposition();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // 系统关闭转发到主窗口
    win.on('close', (e) => {
      if (this.parentClosing) return;
      e.preventDefault();
      const p = this.options.getParentWindow();
      if (p && !p.isDestroyed?.()) {
        this.parentClosing = true;
        // 不直接关闭主窗口（球点击不应退出应用），仅忽略
      }
    });
    win.on('closed', () => {
      this.win = null;
    });

    this.attachParentListeners(parent);

    win.webContents.once('did-finish-load', () => {
      this.applyVisibility();
    });
    win.once('ready-to-show', () => {
      if (this.visible && !win.isDestroyed()) {
        win.showInactive();
        this.reposition();
      }
    });

    void this.options.onLoad(win).catch((e) => {
      log.error('ball: failed to load page', { error: String(e) });
    });
    log.info('status bar ball created');
  }

  destroy(): void {
    this.parentClosing = true;
    this.detachParentListeners();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }

  // ── 内部 ──

  private applyVisibility(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const parent = this.options.getParentWindow();
    const parentVisible = parent ? parent.isVisible() : false;
    const parentMinimized = parent?.isMinimized?.() ?? false;
    const shouldShow = this.visible && parentVisible && !parentMinimized;
    if (shouldShow && !win.isVisible()) {
      win.showInactive();
      this.reposition();
    } else if (!shouldShow && win.isVisible()) {
      win.hide();
    }
  }

  private reposition(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    // 读取布局状态以获取右侧栏宽度（球定位在网页区右缘，不进入右侧栏）
    const layout = this.options.getLayout?.();
    const bounds = computeBallBounds({
      contentBounds: parent.getContentBounds(),
      bottomHeight: layout?.bottomHeight ?? 48,
      rightWidth: layout?.rightWidth ?? 0,
    });
    win.setBounds(bounds);
  }

  private parentDisposers: (() => void)[] = [];

  private attachParentListeners(parent: StatusBarBallHostWindow): void {
    if (this.parentListenersAttached) return;
    const onMove = (): void => this.reposition();
    const onResize = (): void => this.reposition();
    const onShow = (): void => this.applyVisibility();
    const onHide = (): void => this.applyVisibility();
    const onMinimize = (): void => this.applyVisibility();
    const onRestore = (): void => this.applyVisibility();
    const onMaximize = (): void => this.reposition();
    const onUnmaximize = (): void => this.reposition();
    const onClose = (): void => {
      this.parentClosing = true;
      this.destroy();
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
    parent.on('closed', onClose);
    this.parentListenersAttached = true;
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
      () => parent.removeListener?.('closed', onClose),
    ];
  }

  private detachParentListeners(): void {
    for (const dispose of this.parentDisposers) {
      try {
        dispose();
      } catch {
        /* 忽略 */
      }
    }
    this.parentDisposers = [];
    this.parentListenersAttached = false;
  }
}

/** 球直径（供渲染层使用） */
export const STATUS_BALL_SIZE = BALL_SIZE;
