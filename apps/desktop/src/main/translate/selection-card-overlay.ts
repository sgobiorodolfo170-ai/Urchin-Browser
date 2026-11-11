/**
 * 划词翻译结果卡（独立透明子窗口，悬浮于网页 BrowserView 之上）
 *
 * 设计（2026-11-07，网页翻译功能规划 §12.3 待办落地；2026-11-10 尺寸自适应改造）：
 * - 旧实现是主窗口 React 层的 fixed 结果卡（原 ContentArea.tsx），普通网页标签下
 *   被 BrowserView 覆盖——选区落在网页中部时结果卡不可见。Electron 中 BrowserView
 *   恒渲染在主窗口 webContents 之上，React 浮层无法盖住网页，因此照状态栏悬浮窗
 *   （status-bar-overlay.ts）同款架构改为独立透明 frameless 子 BrowserWindow。
 * - 透明 BrowserWindow 在仓库已有成功用例（capture-overlay / status-bar-overlay）；
 *   不用透明 BrowserView 以规避已记录的 Windows DWM/TDR 风险。
 * - 尺寸自适应（2026-11-10 用户需求，同日第二轮按用户反馈改正）：
 *   旧口径只按「译文自身排版」定尺寸——短译文会把卡片折叠成一个小方块，与用户选中的
 *   那段文字的宽高、行数完全不成比例，背景矩形与文本区也显得一大一小。现口径以选区
 *   几何为基准：卡片宽高至少覆盖选区矩形（宽取「选区宽 / 译文自然宽」较大者，高取
 *   「选区高 / 选区行数×行高 / 译文实测高」三者最大），背景矩形与文本区始终同一形状
 *   （文本区填满卡片内边距以内的全部空间，不再出现空腔或折叠）。主进程只有文本估算
 *   （CJK/拉丁字宽粗估）决定首帧，渲染层加载结果后按真实排版实测文本自然宽度与定宽
 *   折行高度，经 translate.cardResize 回报（seq 关联结果、过期测量丢弃），主进程与
 *   选区几何取并集后重设窗口 bounds。高度上限随内容区高度放大（见 maxCardHeightFor，
 *   硬上限 MAX_CARD_HEIGHT_LIMIT），避免长选区被压成内部滚动区；仍超限时结果区内部
 *   滚动兜底。
 * - 仅显示译文不显示原文（2026-11-10 用户需求），卡片内容即结果文本。
 * - 关闭方式（2026-11-10 用户需求）：点击卡片外任意位置关闭。卡片 show 时获取
 *   焦点，其后任何把焦点移出卡片的点击（网页 / 浏览器界面 / 其它应用窗口）都会
 *   触发 blur，blur 即隐藏——与 clipper panel（panel.ts）、书签面板（bookmark-panel）
 *   同款「点外关闭」模式。旧 ✕ 按钮已随原文行一并移除。
 * - 显示/隐藏策略：新结果替换旧内容并跟随选区锚点重定位；主窗口移动/缩放时跟随；
 *   最小化/隐藏/切换标签时隐藏；close 只隐藏不销毁（复用窗口避免反复重建闪烁）；
 *   主窗口关闭/退出时销毁。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';
import type { TranslateSelectionResultEvent } from '@urchin/ipc-contract';
import type { SelectionRect } from './selection-rect';

const log = createLogger('selection-card-overlay');

/** 卡片最大宽度（px）：超过按此宽折行，渲染层测量上限与之同步 */
export const CARD_WIDTH = 448;
/** 卡片最小宽度（px）：超短译文（单词/短语）避免卡片缩成一条 */
export const MIN_CARD_WIDTH = 96;
/** 卡片内边距（px），与渲染层 p-2（8px × 2）一致；2026-11-11 由 24 收紧到 16 */
export const CARD_PAD = 16;
/** 卡片四周透明阴影边距（px），用于 3D 阴影与圆角透出网页（与状态栏同值） */
export const SHADOW_PAD = 8;
/**
 * 卡片高度下限：单行结果 + 内边距（23 行高 + 16 内边距 ≈ 39，取 40 留 1px 余量），
 * 使单行小卡的上下留白与左右内边距一致，不再被固定的 48 撑出额外空白。
 */
export const MIN_CARD_HEIGHT = 40;
/** 卡片高度默认上限（px）：短结果不超过此高，超出部分由结果区内部滚动承接 */
export const MAX_CARD_HEIGHT = 264;
/**
 * 卡片高度硬上限（px）：窗口越高卡片可越高（长选区不被压成滚动区），
 * 但再大也不超过此值，避免结果卡铺满整个内容区。
 */
export const MAX_CARD_HEIGHT_LIMIT = 560;
/** 文本区最大宽度（px）：卡片最大宽 - 内边距，渲染层测量上限与之同步 */
export const MAX_TEXT_WIDTH = CARD_WIDTH - CARD_PAD;
/** 结果区上下安全边距（窗口定位时夹边用） */
const CONTENT_EDGE_PAD = 8;

/** 卡片文本区尺寸（px） */
export interface CardSize {
  width: number;
  height: number;
}

/** 估算行高（px）：14px 字号 leading-relaxed 约 23px/行 */
const LINE_HEIGHT = 23;
/** 宽字符（CJK 表意/假名/谚文/全角标点等）估算字宽（px） */
const WIDE_CHAR_WIDTH = 15;
/** 窄字符（拉丁/数字/半角标点等）估算字宽（px） */
const NARROW_CHAR_WIDTH = 8;

/** CJK 宽字符粗判（覆盖表意文字、假名、谚文、全角形式；估算用途，不求精确） */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff01 && code <= 0xff60) ||
    code === 0x3000
  );
}

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
  /**
   * 选区几何（窗口相对坐标，2026-11-10 用户需求）：结果卡的宽高与行数以选中的文字
   * 为基准，背景矩形与译文文本区同一形状。缺省（脚本读取失败/无选区）时退回译文估算。
   */
  selection?: SelectionRect;
}

/**
 * 按结果文本估算文本区尺寸（px），作为首帧尺寸（渲染层实测回报前的兜底）。
 *
 * 宽字符按 15px、窄字符按 8px 粗估自然宽度；超过最大文本宽按上限折行。
 * 混排/换行场景偏差不大，且渲染层实测回报后会整体纠正。导出供单测验证边界。
 */
export function estimateCardSize(text: string): CardSize {
  let maxSegWidth = 0;
  let totalLines = 0;
  for (const seg of text.split('\n')) {
    let natural = 0;
    for (const ch of seg) {
      natural += isWideChar(ch.codePointAt(0) ?? 0) ? WIDE_CHAR_WIDTH : NARROW_CHAR_WIDTH;
    }
    maxSegWidth = Math.max(maxSegWidth, Math.min(natural, MAX_TEXT_WIDTH));
    totalLines += Math.max(1, Math.ceil(natural / MAX_TEXT_WIDTH));
  }
  return {
    width: Math.max(maxSegWidth, MIN_CARD_WIDTH - CARD_PAD),
    height: totalLines * LINE_HEIGHT,
  };
}

/**
 * 文本区尺寸 → 卡片尺寸夹边：宽度夹 [MIN_CARD_WIDTH, CARD_WIDTH]，高度夹
 * [MIN_CARD_HEIGHT, maxHeight]（默认 MAX_CARD_HEIGHT；超高由结果区内部滚动承接）。
 * 纯函数导出供单测验证边界，applyBounds 与估算兜底共用。
 */
export function clampCardSize(
  textWidth: number,
  textHeight: number,
  maxHeight: number = MAX_CARD_HEIGHT,
): { cardWidth: number; cardHeight: number } {
  return {
    cardWidth: Math.min(CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(textWidth) + CARD_PAD)),
    cardHeight: Math.min(
      Math.max(MIN_CARD_HEIGHT, maxHeight),
      Math.max(MIN_CARD_HEIGHT, Math.round(textHeight) + CARD_PAD),
    ),
  };
}

/**
 * 内容区高度 → 卡片高度上限：随窗口放大（长选区不被压成滚动区），
 * 下限保持 MAX_CARD_HEIGHT，上限 MAX_CARD_HEIGHT_LIMIT，且不超出内容区可容纳高度。
 * 导出供单测验证边界。
 */
export function maxCardHeightFor(contentHeight: number): number {
  return Math.max(
    MAX_CARD_HEIGHT,
    Math.min(MAX_CARD_HEIGHT_LIMIT, contentHeight - CONTENT_EDGE_PAD * 2),
  );
}

/**
 * 结果卡文本区尺寸决策：译文尺寸（估算或实测）与选区几何取并集。
 *
 * - 宽：至少覆盖选区宽度（选中 400px 宽的段落，结果卡不再缩成小方块）
 * - 高：至少覆盖选区高度与「选区行数 × 结果卡行高」，避免卡片比选区还扁
 * - 无选区几何（脚本读取失败 / 无选区）时原样返回译文尺寸
 *
 * 只做「取大」，不做折行重排：译文自然宽度更大时仍按译文的宽（不横向截断）；
 * 译文高度来自「自然宽度下的实测值」——并集只会把宽度变大，定宽折行不会因此增加
 * 行数，所以该高度对最终宽度仍然成立，不会出现被裁掉的文本。
 * 纯函数导出供单测验证。
 */
export function resolveTextSize(
  translated: CardSize,
  selection?: Pick<SelectionRect, 'width' | 'height' | 'lines'>,
): CardSize {
  if (!selection) return translated;
  return {
    width: Math.ceil(Math.max(translated.width, selection.width)),
    height: Math.ceil(Math.max(translated.height, selection.height, selection.lines * LINE_HEIGHT)),
  };
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
  cardWidth: number;
  cardHeight: number;
}): { x: number; y: number; width: number; height: number } {
  const { contentBounds, anchorX, anchorY, cardWidth, cardHeight } = params;
  const width = cardWidth + SHADOW_PAD * 2;
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

/** last（缓存结果）附加字段：递增序号（测量关联）与已解析主题 */
type CachedResult = SelectionCardShowPayload & { theme: 'light' | 'dark'; seq: number };

export class SelectionCardOverlay {
  private win: BrowserWindow | null = null;
  private parentClosing = false;
  private parentListenersAttached = false;
  private parentDisposers: (() => void)[] = [];
  /** 首帧渲染就绪标志：透明窗口 ready-to-show 前显示会白闪/合成未就绪 */
  private ready = false;
  /** 最近一次结果（含锚点/序号）：父窗口移动/缩放时跟随重定位 */
  private last: CachedResult | null = null;
  /** 结果卡序号源：每展示一个新结果自增，渲染层实测回报按 seq 关联 */
  private seqCounter = 0;
  /** 渲染层最近一次实测回报（按 seq 关联到结果；新结果展示时作废旧测量） */
  private measured: (CardSize & { seq: number }) | null = null;
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

    this.last = { ...payload, theme: this.options.getTheme(), seq: ++this.seqCounter };
    // 新结果作废旧测量：渲染层实测回报（seq 匹配）后按实测重设尺寸
    this.measured = null;
    this.applyBounds();
    // 未 ready（首帧未渲染）时暂不显示，待 ready-to-show 回调补显示。
    // 必须获取焦点（非 showInactive）：点外关闭依赖卡片失焦信号，见文件头设计说明。
    if (!win.isVisible() && this.ready) win.show();
    this.sendPayload();
  }

  /** 渲染层实测文本尺寸回报：仅接受当前结果的测量（seq 匹配），随后重定位 */
  applyMeasuredSize(seq: number, width: number, height: number): void {
    if (this.last?.seq !== seq) return;
    this.measured = { seq, width, height };
    this.applyBounds();
  }

  /** 隐藏结果卡（保留窗口复用；切换标签/最小化/失焦/HTML5 全屏时调用） */
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
    this.measured = null;
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

    // ✕ 已移除，close 仍只隐藏不销毁（复用窗口避免重建闪烁）；主窗口关闭时放行
    win.on('close', (e) => {
      if (this.parentClosing) return;
      e.preventDefault();
      this.hide();
    });

    // 点外关闭：卡片持有焦点期间，点击卡片外任何位置（网页/浏览器界面/其它应用）
    // 都会使卡片失焦，blur 即隐藏。hide() 自身可能再触发一次 blur，无副作用
    // （isVisible 守卫）。
    win.on('blur', () => this.hide());

    win.on('closed', () => {
      this.win = null;
    });

    // 透明窗口建议 ready-to-show 后显示，避免首帧白闪/合成未就绪
    win.once('ready-to-show', () => {
      this.ready = true;
      if (this.last && !win.isDestroyed() && !win.isVisible()) {
        this.applyBounds();
        win.show();
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

  /** 按最近锚点与尺寸重定位：实测值优先（seq 匹配），估算值兜底，再与选区几何取并集 */
  private applyBounds(): void {
    const win = this.win;
    const last = this.last;
    if (!win || win.isDestroyed() || !last) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    const contentBounds = parent.getContentBounds();
    const measured = this.measured?.seq === last.seq ? this.measured : null;
    const est = estimateCardSize(last.error ?? last.result ?? '');
    // 译文尺寸（实测优先）+ 选区几何（宽高/行数）取并集：短译文不再折叠成小方块，
    // 长选区不被压扁；两者都在同一文本宽度下成立，并集后无裁切。
    const textSize = resolveTextSize(measured ?? est, last.selection);
    const { cardWidth, cardHeight } = clampCardSize(
      textSize.width,
      textSize.height,
      maxCardHeightFor(contentBounds.height),
    );
    win.setBounds(
      computeSelectionCardBounds({
        contentBounds,
        anchorX: last.x,
        anchorY: last.y,
        cardWidth,
        cardHeight,
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
      seq: last.seq,
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
