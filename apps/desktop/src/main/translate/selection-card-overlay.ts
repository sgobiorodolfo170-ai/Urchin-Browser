/**
 * 划词翻译结果卡（独立透明子窗口，悬浮于网页 BrowserView 之上）
 *
 * 设计（2026-11-07，网页翻译功能规划 §12.3 待办落地）：
 * - 旧实现是主窗口 React 层的 fixed 结果卡（原 ContentArea.tsx），普通网页标签下
 *   被 BrowserView 覆盖——选区落在网页中部时结果卡不可见。Electron 中 BrowserView
 *   恒渲染在主窗口 webContents 之上，React 浮层无法盖住网页，因此照状态栏悬浮窗
 *   （status-bar-overlay.ts）同款架构改为独立透明 frameless 子 BrowserWindow。
 * - 透明 BrowserWindow 在仓库已有成功用例（capture-overlay / status-bar-overlay）；
 *   不用透明 BrowserView 以规避已记录的 Windows DWM/TDR 风险。
 * - 窗口高度按结果文本估算（选中文字翻译结果通常较短），结果区内部滚动兜底估算
 *   偏差；透明区域在 Windows 上会拦截点击，故不能留大片透明余量。
 * - 显示/隐藏策略：新结果替换旧内容并跟随选区锚点重定位；主窗口移动/缩放时跟随；
 *   最小化/隐藏/切换标签时隐藏；✕ 关闭只隐藏不销毁（复用窗口避免反复重建闪烁）；
 *   主窗口关闭/退出时销毁。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';
import type { TranslateSelectionResultEvent } from '@urchin/ipc-contract';

const log = createLogger('selection-card-overlay');

/** 卡片宽度（px），与渲染层 max-w-md（28rem=448）一致 */
export const CARD_WIDTH = 448;
/** 卡片四周透明阴影边距（px），用于 3D 阴影与圆角透出网页（与状态栏同值） */
export const SHADOW_PAD = 8;
/** 估算高度下限：源行 + 单行结果 + 内边距 */
export const MIN_CARD_HEIGHT = 72;
/** 估算高度上限：超出部分由结果区内部滚动承接 */
export const MAX_CARD_HEIGHT = 264;
/** 结果区上下安全边距（窗口定位时夹边用） */
const CONTENT_EDGE_PAD = 8;

/** 宿主主窗口最小依赖接口（真实 BrowserWindow 与 mock 均满足） */
export interface SelectionCardHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isDestroyed?(): boolean;
}

export interface SelectionCardOverlayOptions {
  /** 获取宿主主窗口（null = 尚未创建） */
  getParentWindow: () => SelectionCardHostWindow | null;
  /** 主窗口 preload 脚本路径（子窗口复用，file/urchin 下暴露 window.urchin） */
  preloadPath: string;
  /** 加载结果卡页面（dev: dev server + ?view=translate-card；prod: loadFile + query） */
  onLoad: (win: BrowserWindow) => Promise<void>;
  /** 读取当前已解析主题（悬浮子窗口不经过主窗口渲染层 ThemeProvider，需显式下发） */
  getTheme: () => 'light' | 'dark';
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

/** show() 入参：选区锚点为窗口内容相对坐标（与右键菜单 popup 同一补偿口径） */
export interface SelectionCardShowPayload {
  tabId: number;
  source: string;
  result?: string;
  error?: string;
  x: number;
  y: number;
}

/**
 * 按结果文本估算卡片内容高度（px）。
 *
 * 源文本行固定单行截断（20px），结果区按 CJK 宽度假设折行（leading-relaxed
 * 14px 字号约 23px/行，448-24px 内容宽约 34 个 CJK 字/行）。混排英文会低估行数
 * 偏差不大，且结果区 overflow-y-auto 兜底。导出供单测验证边界。
 */
export function estimateCardHeight(text: string): number {
  const CHARS_PER_LINE = 34;
  const LINE_HEIGHT = 23;
  const SOURCE_ROW = 26; // 源行 20px + 下边距 6px
  const PADDING = 24; // p-3 上下
  let lines = 0;
  for (const seg of text.split('\n')) {
    lines += Math.max(1, Math.ceil(seg.length / CHARS_PER_LINE));
  }
  const h = SOURCE_ROW + PADDING + lines * LINE_HEIGHT;
  return Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, Math.round(h)));
}

/**
 * 计算结果卡窗口 bounds（屏幕坐标）。
 *
 * 水平：以锚点为左缘基准，右溢出夹边（与旧 React 卡 left 夹边一致）；
 * 垂直：优先锚点下方 12px（同旧卡 top = y + 12），下方放不下改到锚点上方，
 * 仍放不下贴内容区底。导出供单测直接验证几何，不依赖 BrowserWindow。
 */
export function computeSelectionCardBounds(params: {
  contentBounds: { x: number; y: number; width: number; height: number };
  anchorX: number;
  anchorY: number;
  cardHeight: number;
}): { x: number; y: number; width: number; height: number } {
  const { contentBounds, anchorX, anchorY, cardHeight } = params;
  const width = CARD_WIDTH + SHADOW_PAD * 2;
  const height = cardHeight + SHADOW_PAD * 2;
  const x = Math.round(
    contentBounds.x +
      Math.max(CONTENT_EDGE_PAD, Math.min(anchorX, contentBounds.width - width - CONTENT_EDGE_PAD)),
  );
  let y = contentBounds.y + anchorY + 12;
  if (y + height > contentBounds.y + contentBounds.height - CONTENT_EDGE_PAD) {
    y = contentBounds.y + anchorY - height - CONTENT_EDGE_PAD;
  }
  if (y < contentBounds.y + CONTENT_EDGE_PAD) {
    y = contentBounds.y + contentBounds.height - height - CONTENT_EDGE_PAD;
  }
  return { x, y: Math.round(y), width, height };
}

export class SelectionCardOverlay {
  private win: BrowserWindow | null = null;
  private parentClosing = false;
  private parentListenersAttached = false;
  private parentDisposers: (() => void)[] = [];
  /** 首帧渲染就绪标志：透明窗口 ready-to-show 前显示会白闪/合成未就绪 */
  private ready = false;
  /** 最近一次结果（含锚点）：父窗口移动/缩放时跟随重定位 */
  private last: (SelectionCardShowPayload & { theme: 'light' | 'dark' }) | null = null;
  private readonly options: SelectionCardOverlayOptions;

  constructor(options: SelectionCardOverlayOptions) {
    this.options = options;
  }

  /** 是否已创建 */
  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /** 展示划词结果（懒创建窗口；新结果替换旧内容并重定位） */
  show(payload: SelectionCardShowPayload): void {
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('selection card: parent window not available');
      return;
    }
    if (!this.isOpen) this.open();
    const win = this.win;
    if (!win || win.isDestroyed()) return;

    this.last = { ...payload, theme: this.options.getTheme() };
    this.applyBounds();
    // 未 ready（首帧未渲染）时暂不显示，待 ready-to-show 回调补显示
    if (!win.isVisible() && this.ready) win.showInactive();
    this.sendPayload();
  }

  /** 隐藏结果卡（保留窗口复用；切换标签/最小化/HTML5 全屏时调用） */
  hide(): void {
    const win = this.win;
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
    }
  }

  /** 销毁悬浮层窗口（主窗口关闭 / 退出清理时调用） */
  destroy(): void {
    this.parentClosing = true;
    this.detachParentListeners();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.last = null;
    this.ready = false;
  }

  // ── 内部 ───────────────────────────────────────────────

  private open(): void {
    const parent = this.options.getParentWindow();
    if (!parent) return;

    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const win = create({
      width: CARD_WIDTH + SHADOW_PAD * 2,
      height: MIN_CARD_HEIGHT + SHADOW_PAD * 2,
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
      title: 'Urchin Translate Card',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;

    // 安全：结果卡不允许导航到外部页面或弹出新窗口
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // ✕ 关闭：只隐藏不销毁，复用窗口避免重建闪烁；主窗口关闭时放行
    win.on('close', (e) => {
      if (this.parentClosing) return;
      e.preventDefault();
      this.hide();
    });

    win.on('closed', () => {
      this.win = null;
    });

    // 透明窗口建议 ready-to-show 后显示，避免首帧白闪/合成未就绪
    win.once('ready-to-show', () => {
      this.ready = true;
      if (this.last && !win.isDestroyed() && !win.isVisible()) {
        this.applyBounds();
        win.showInactive();
      }
    });

    // 页面加载完成后补发缓存结果（show 时页面可能尚未加载完，直接 send 会丢）
    win.webContents.once('did-finish-load', () => {
      this.sendPayload();
    });

    this.attachParentListeners(parent);

    void this.options.onLoad(win).catch((e) => {
      log.error('selection card: failed to load page', { error: String(e) });
    });

    log.info('selection card overlay created');
  }

  /** 按最近锚点重定位（父窗口移动/缩放跟随） */
  private applyBounds(): void {
    const win = this.win;
    const last = this.last;
    if (!win || win.isDestroyed() || !last) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    win.setBounds(
      computeSelectionCardBounds({
        contentBounds: parent.getContentBounds(),
        anchorX: last.x,
        anchorY: last.y,
        cardHeight: estimateCardHeight(last.error ?? last.result ?? ''),
      }),
    );
  }

  private sendPayload(): void {
    const win = this.win;
    const last = this.last;
    if (!win || win.isDestroyed() || !last) return;
    // 页面仍在加载时跳过，待 did-finish-load 统一下发，避免渲染层尚未注册监听
    if (win.webContents.isLoadingMainFrame()) return;
    const payload: TranslateSelectionResultEvent = {
      tabId: last.tabId,
      source: last.source,
      result: last.result,
      error: last.error,
      theme: last.theme,
    };
    win.webContents.send('translate:selection-result', payload);
  }

  private attachParentListeners(parent: SelectionCardHostWindow): void {
    if (this.parentListenersAttached) return;
    const onMove = (): void => this.applyBounds();
    const onResize = (): void => this.applyBounds();
    const onHide = (): void => this.hide();
    const onMinimize = (): void => this.hide();
    const onClosed = (): void => {
      this.parentClosing = true;
      this.destroy();
    };
    const onClose = (): void => {
      // 主窗口开始关闭时标记，放行结果卡 close，避免阻止应用退出
      this.parentClosing = true;
    };
    parent.on('move', onMove);
    parent.on('resize', onResize);
    parent.on('hide', onHide);
    parent.on('minimize', onMinimize);
    parent.on('close', onClose);
    parent.on('closed', onClosed);
    this.parentListenersAttached = true;
    this.parentDisposers = [
      () => parent.removeListener?.('move', onMove),
      () => parent.removeListener?.('resize', onResize),
      () => parent.removeListener?.('hide', onHide),
      () => parent.removeListener?.('minimize', onMinimize),
      () => parent.removeListener?.('close', onClose),
      () => parent.removeListener?.('closed', onClosed),
    ];
  }

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
