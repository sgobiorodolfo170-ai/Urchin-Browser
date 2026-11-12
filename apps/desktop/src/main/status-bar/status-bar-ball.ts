/**
 * 底部悬浮球（独立透明子窗口，位于网页区最右侧、不遮挡滚动条）。
 *
 * 2026-10-24：状态栏折叠后地址栏隐藏，悬浮球始终显示于网页区右下角。
 * - 点击悬浮球：展开/折叠地址栏（由 StatusBarOverlay 管理）。
 * - 按住悬浮球拖动：上下/左右滚动网页（经主进程转发到活跃 tab webContents）。
 * - 右键按住拖动：移动球位置（可拖出主窗口到桌面任意位置；不可拖入地址栏区域）。
 * - 拖动时球体轻微位移配合，反方向残影阴影辅助视觉识别。
 *
 * 悬浮球为独立 BrowserWindow，避免与地址栏窗口的透明区域互相影响点击穿透。
 *
 * 右键拖动引擎（2026-11-13 重写，同日二次修订）：渲染层只上报 dragStart/dragEnd，
 * 移动由主进程以 screen.getCursorScreenPoint() 轮询 + 抓取偏移绝对定位驱动。
 * 此前的渲染层增量 dx/dy IPC 有两类实测故障：① 52px 透明小窗口在 setPosition
 * 下 capture 不可靠，事件断流后球冻结（「偶发卡住」）；② 增量无自纠错，丢一帧
 * 即永久落后（「焦点脱离悬浮球」）。绝对定位按「光标 + 抓取偏移」每帧重算，
 * 光标始终锁定在按住的位置，且不依赖渲染层事件流。
 *
 * 与地址栏的重叠约束改为「拖动期自由 + 松手结算」：地址栏横跨整个中区宽度，
 * 若拖动期防重叠，球在地址栏右侧同行时水平拖动必被挡死（实测「左右无法咬住
 * 光标」）——故拖动期间球临时置顶（modal-panel）自由移动，四向咬住且永不
 * 被地址栏覆盖；松手时若球停在地址栏区域内则移出（ensureClearOfRect），
 * 稳态球与地址栏不重叠。
 */
import { BrowserWindow, screen } from 'electron';
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
/** 拖动轮询间隔（ms）：16ms ≈ 60fps，窗口拖动足够顺滑 */
const DRAG_POLL_INTERVAL = 16;
/**
 * 拖动看门狗：光标静止超过该时长视为拖动已中断。
 * pointerup 在 capture 丢失时可能永远不到（拖出窗口外松手），无兜底则球会
 * 无限跟随光标；渲染层 dragEnd 与本看门狗双保险，均幂等。
 */
const DRAG_IDLE_TIMEOUT = 1000;
/** 移球让位时与地址栏的间隙（px） */
const NUDGE_GAP = 4;
/**
 * 拖动期间球的临时置顶层级（modal-panel 高于普通 owned 兄弟窗口）：
 * 允许球自由穿过地址栏上方的同时保证球不被地址栏盖住；拖动结束恢复 normal。
 */
const DRAG_ALWAYS_ON_TOP_LEVEL: 'floating' | 'modal-panel' = 'modal-panel';

/** 屏幕坐标矩形（DIP） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两矩形是否相交（严格重叠；边缘相切不算——默认布局球左缘与地址栏窗口右缘恰好相切） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 两矩形水平区间是否重叠（只看 x 轴；相切不算，供地址栏「同行跟随」的前提判断） */
export function rectsOverlapHorizontally(
  a: Pick<Rect, 'x' | 'width'>,
  b: Pick<Rect, 'x' | 'width'>,
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x;
}

/**
 * 计算把球移出地址栏区域的落点（上方优先、下方兜底；均不可见返回 null 放弃）。
 *
 * 可见性判定用**屏幕工作区**而非父窗口内容区：地址栏可随球拖出窗口（2026-11-13
 * 用户指令），窗外结算若仍按窗内判定会上下都「放不下」→ 球被留在原地被地址栏
 * 盖住（违禁复发）。屏幕判定下球至少部分可见，且球/地址栏受光标物理边界限制
 * 最多出屏约一个球身，不存在双分支都不可见的死锁。
 * 导出供单测验证几何。
 */
export function computeBallNudge(params: {
  ball: Rect;
  bar: Rect;
  /** 屏幕工作区（可见性判定；null 不限制） */
  visibleBounds: Rect | null;
}): { x: number; y: number } | null {
  const { ball, bar, visibleBounds } = params;
  if (!rectsIntersect(ball, bar)) return null;
  const visible = (r: Rect): boolean => !visibleBounds || rectsIntersect(r, visibleBounds);
  const above: Rect = {
    x: ball.x,
    y: bar.y - ball.height - NUDGE_GAP,
    width: ball.width,
    height: ball.height,
  };
  if (visible(above)) return { x: above.x, y: above.y };
  const below: Rect = {
    x: ball.x,
    y: bar.y + bar.height + NUDGE_GAP,
    width: ball.width,
    height: ball.height,
  };
  if (visible(below)) return { x: below.x, y: below.y };
  return null;
}

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
  /** 拖动轮询定时器（null = 未在拖动） */
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  /** 抓取偏移：球位置 = 光标位置 + 偏移（贴边/滑移后重锚） */
  private dragOffset: { x: number; y: number } = { x: 0, y: 0 };
  /** 上一次轮询到的光标位置（看门狗判静止用） */
  private dragLastCursor: { x: number; y: number } | null = null;
  /** 光标最后一次移动的时间戳（ms） */
  private dragLastMoveAt = 0;
  /** 待下发的球配置（页面加载完成后补发，避免启动期丢失） */
  private pendingConfig: {
    theme: 'light' | 'dark';
    sensitivityVertical: number;
    sensitivityHorizontal: number;
  } | null = null;
  private readonly options: StatusBarBallOptions;

  constructor(options: StatusBarBallOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /** 是否正在右键拖动（overlay 据此跳过「移球让位」兜底，避免与拖动轮询打架） */
  get isDragging(): boolean {
    return this.dragTimer !== null;
  }

  /** 设置可见性（球在所有页面常驻；仅全屏/最小化时隐藏） */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && !this.isOpen) {
      this.open();
    }
    this.applyVisibility();
  }

  /** 右键拖动开始：按「光标 − 球位置」记录抓取偏移并启动光标轮询（幂等，重复调用先结束上一轮） */
  startDrag(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.stopDrag();
    // 拖动期间球临时置顶：允许球自由穿过地址栏上方（四向都咬住光标），
    // 同时保证球永不被地址栏盖住；松手 stopDrag 恢复层级并结算重叠。
    win.setAlwaysOnTop(true, DRAG_ALWAYS_ON_TOP_LEVEL);
    const cursor = screen.getCursorScreenPoint();
    const pos = win.getPosition();
    this.dragOffset = { x: (pos[0] ?? 0) - cursor.x, y: (pos[1] ?? 0) - cursor.y };
    this.dragLastCursor = cursor;
    this.dragLastMoveAt = Date.now();
    this.dragTimer = setInterval(() => this.dragTick(), DRAG_POLL_INTERVAL);
    this.dragTick();
  }

  /** 右键拖动结束（渲染层上报 / 看门狗 / 球隐藏三路兜底，幂等）：恢复层级 + 结算重叠 */
  stopDrag(): void {
    if (!this.dragTimer) return; // 幂等守卫：未在拖动时重复上报只处理一次
    clearInterval(this.dragTimer);
    this.dragTimer = null;
    this.dragOffset = { x: 0, y: 0 };
    this.dragLastCursor = null;
    this.dragLastMoveAt = 0;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    // 松手结算：球若停在地址栏区域内则移出（上方优先、下方兜底），
    // 随后 onPositionChanged 触发地址栏刷新收敛——稳态球与地址栏不重叠。
    const barBounds = this.options.getBarBounds?.() ?? null;
    if (barBounds) this.ensureClearOfRect(barBounds);
  }

  /** 当前球窗口 bounds（屏幕坐标，含四周阴影边距；供地址栏避让计算；null = 球不可用） */
  getBounds(): Rect | null {
    const win = this.win;
    if (!win || win.isDestroyed()) return null;
    const pos = win.getPosition();
    const size = BALL_SIZE + BALL_PAD * 2;
    return { x: pos[0] ?? 0, y: pos[1] ?? 0, width: size, height: size };
  }

  /** 地址栏即将落位且与球重叠时把球移出（上方优先、下方兜底；按屏幕工作区判可见性） */
  ensureClearOfRect(barRect: Rect): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const pos = win.getPosition();
    const size = BALL_SIZE + BALL_PAD * 2;
    const ball: Rect = { x: pos[0] ?? 0, y: pos[1] ?? 0, width: size, height: size };
    // 可见性按屏幕工作区判定（地址栏可随球出窗，父窗口内容区判定会在窗外死锁）
    const display = screen.getDisplayNearestPoint({
      x: Math.round(ball.x + size / 2),
      y: Math.round(ball.y + size / 2),
    });
    const nudge = computeBallNudge({ ball, bar: barRect, visibleBounds: display.workArea });
    if (!nudge) return;
    log.info('ball nudged out of status bar area', { from: ball, to: nudge });
    win.setPosition(nudge.x, nudge.y);
    this.options.onPositionChanged?.();
  }

  /** 拖动轮询：光标 + 抓取偏移 → 直接落位（拖动期自由移动，四向咬住；重叠在松手时结算） */
  private dragTick(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) {
      this.stopDrag();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const last = this.dragLastCursor;
    if (last?.x !== cursor.x || last?.y !== cursor.y) {
      this.dragLastCursor = cursor;
      this.dragLastMoveAt = Date.now();
    } else if (Date.now() - this.dragLastMoveAt > DRAG_IDLE_TIMEOUT) {
      // pointerup 丢失兜底：光标静止超时即结束，防球无限跟随光标
      this.stopDrag();
      return;
    }
    const target = { x: cursor.x + this.dragOffset.x, y: cursor.y + this.dragOffset.y };
    const pos = win.getPosition();
    const current = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
    if (target.x === current.x && target.y === current.y) return;
    win.setPosition(target.x, target.y);
    this.options.onPositionChanged?.();
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
    // 缓存待下发配置：启动期球窗口刚创建、页面仍在加载，直接 send 会丢；
    // did-finish-load 后由 flushConfig() 补发（此前只有设置变更才会再次下发）。
    this.pendingConfig = config;
    this.flushConfig();
  }

  /** 下发缓存的球配置（页面就绪时调用） */
  private flushConfig(): void {
    const win = this.win;
    const config = this.pendingConfig;
    if (!win || win.isDestroyed() || !config) return;
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
      this.flushConfig();
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
    this.stopDrag();
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

/**
 * 悬浮球在地址栏同一行占用的水平宽度（球窗口 + 滚动条让位 + 间隙）。
 *
 * 地址栏窗口与球共用网页区底部这一行，球固定在网页区右缘（`computeBallBounds`），
 * 因此地址栏的宽度上限必须让出这段宽度，否则两窗重叠（球会盖住地址栏右端的动作按钮）。
 */
export const STATUS_BALL_RESERVED_WIDTH = SCROLLBAR_WIDTH + BALL_GAP + BALL_SIZE + BALL_PAD * 2;
