/**
 * 收藏夹悬浮面板（独立子窗口，悬浮于网页之上）
 *
 * 2026-08-14 设计（用户原始设计意图）：
 * - 点击地址栏收藏夹按钮 → 由下往上弹出小窗口，悬浮置顶在网页之上
 * - 只覆盖网页右下角弹窗面积（280×430），不隐藏、不让出网页
 *
 * 实现原理（Electron 层级约束）：
 * - BrowserView（网页）永远渲染在主窗口 webContents（React）之上，React 浮层
 *   无法盖住网页——因此面板必须用独立 BrowserWindow（子窗口）。
 * - BrowserWindow 始终渲染在 BrowserView 之上（不同顶层窗口），天然"悬浮置顶"。
 * - 子窗口复用主窗口 preload：file:/urchin: 协议下暴露 window.urchin.invoke，
 *   面板 React 组件直接调 bookmark.list / history.list / download.list 等 IPC。
 * - 自下而上动画：面板 CSS slide-up keyframes（子窗口定位在目标位置，
 *   内容从 translateY 滑入）。
 * - 点击外部自动关闭：子窗口 blur 事件（点击网页/主窗口时失焦）。
 * - 跟随主窗口：监听主窗口 move / resize 重定位（右下角吸附）。
 *
 * 2026-10-25 dev.119 功能扩展（用户需求）：
 * - 收藏夹 tab 目录化：面包屑导航 + 文件夹下钻（任意层级）+ 新建文件夹 +
 *   重命名（书签/文件夹均可，经 bookmark.update）+ 删除文件夹（级联，confirm 确认）
 * - 历史 tab 按访问日期分组「今天 / 昨天 / 10月18日」，组头可折叠，
 *   默认最近一组展开、其余折叠；无下级目录（纯展示层分组，无数据模型改动）
 * - 下载 tab：进度条 + 已下载/总大小 + 实时速度（500ms 轮询采样 EMA 平滑）+
 *   completed 状态「📂 在文件夹中显示」按钮（download.showInFolder IPC）
 *
 * 2026-11-05 P2 Session 4：原 ~700 行内联 HTML/JS 迁移为 React 组件
 * （src/renderer/panel/，独立 vite 入口 panel.html）。本文件只保留子窗口管理
 * （创建/定位/跟随/blur 关闭/动画），页面加载经注入的 onLoad 回调（与
 * StatusBarOverlay / ClipperPanel 同模式）：dev 加载 vite dev server /panel.html，
 * prod loadFile dist/renderer/panel.html；picker 模式附 ?mode=picker 查询参数。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('bookmark-panel');

/** 面板窗口尺寸（悬浮小窗，避开底部地址栏与右侧边栏） */
export const PANEL_WIDTH = 280;
export const PANEL_HEIGHT = 430;
/**
 * 网页滚动条宽度（px）。
 *
 * 网页（BrowserView）的右/下滚动条紧贴两栏边界，面板需让出滚动条宽度，
 * 否则会盖住滑块。Windows 经典滚动条约 17px；overlay scrollbar（自动隐藏）为 0。
 * 取 17 覆盖经典样式。
 */
const SCROLLBAR_WIDTH = 17;
/** 面板与网页滚动条/两栏边界的间隙（px） */
const PANEL_GAP = 2;

/** 面板加载模式：'normal' = 三 tab 浏览；'picker' = 收藏夹 tab 进入「选择文件夹保存」 */
export type BookmarkPanelMode = 'normal' | 'picker';

/**
 * 收藏夹悬浮面板管理器。
 *
 * 通过依赖注入（getParentWindow / preloadPath / onLoad）保持可测试性：
 * 核心逻辑（toggle 状态机 / 定位计算）可单测，BrowserWindow 创建用 mock。
 *
 * PanelHostWindow 为最小结构类型：真实 Electron BrowserWindow 与
 * window-manager 的 BrowserWindowLike 均满足（均含 getContentBounds/on），
 * 避免强制 cast，同时便于测试注入 mock。
 */
export interface PanelHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface BookmarkPanelOptions {
  /** 获取宿主主窗口（null = 主窗口尚未创建） */
  getParentWindow: () => PanelHostWindow | null;
  /** 主窗口 preload 脚本路径（子窗口复用，file/urchin 下暴露 window.urchin） */
  preloadPath: string;
  /**
   * 读取浏览器布局尺寸（右侧栏宽度 / 底部地址栏高度）。
   *
   * 面板定位避开两栏：x = 内容区右缘 - rightWidth - 面板宽 - 2px，
   * y = 内容区下缘 - bottomHeight - 面板高 - 2px（地址栏上方、右侧栏左侧）。
   */
  getLayout?: () => { rightWidth: number; bottomHeight: number };
  /**
   * 加载面板页面（dev: vite dev server /panel.html；prod: loadFile
   * dist/renderer/panel.html + query）。mode='picker' 时页面以 ?mode=picker 加载，
   * React 面板据此进入「选择文件夹保存」模式。
   */
  onLoad: (win: BrowserWindow, mode: BookmarkPanelMode) => Promise<void>;
  /** BrowserWindow 工厂（测试注入 mock，生产默认 new BrowserWindow） */
  createWindow?: (opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

export class BookmarkPanel {
  private panel: BrowserWindow | null = null;
  private readonly options: BookmarkPanelOptions;
  /** blur 关闭的时间戳：用于抑制"按钮 toggle 重开"竞态（见 toggle） */
  private blurClosedAt = 0;

  constructor(options: BookmarkPanelOptions) {
    this.options = options;
  }

  /** 是否已打开 */
  get isOpen(): boolean {
    return this.panel !== null && !this.panel.isDestroyed();
  }

  /** 切换开/关。返回切换后的状态。 */
  toggle(): boolean {
    // 竞态抑制：面板打开时点击收藏夹按钮，mousedown 会先使主窗口获得焦点 →
    // 面板 blur 关闭，随后 toggle IPC 才到达。若 300ms 内刚被 blur 关闭，
    // 本次 toggle 视为"按钮点击已通过 blur 关闭面板"，不重开（避免关后又开）。
    if (Date.now() - this.blurClosedAt < 300) {
      this.blurClosedAt = 0;
      return false;
    }
    if (this.isOpen) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  /**
   * 打开面板（懒创建子窗口）。
   *
   * @param mode 'normal' = 三 tab 浏览（默认）；'picker' = 收藏夹 tab 进入「选择文件夹保存」模式
   *             （星标按钮未收藏时调用，页面以 ?mode=picker 加载，React 据此渲染选择器）
   */
  open(mode: BookmarkPanelMode = 'normal'): void {
    if (this.isOpen) return;
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('bookmark panel: parent window not available');
      return;
    }

    const create = this.options.createWindow ?? ((opts) => new BrowserWindow(opts));
    const panel = create({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
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

    // 定位：地址栏上方、右侧栏左侧（避开两栏）
    this.reposition(panel, parent);
    // 点击面板外任意处（主窗口/网页）自动关闭：
    // 面板以 show() 抢焦点 → 点击外部使主窗口获得焦点 → 面板 blur → 关闭
    panel.on('blur', () => {
      this.blurClosedAt = Date.now();
      this.close();
    });
    // 跟随主窗口移动/缩放
    const onParentMove = (): void => {
      if (this.isOpen && !panel.isDestroyed()) {
        this.reposition(panel, parent);
      }
    };
    parent.on('move', onParentMove);
    parent.on('resize', onParentMove);
    panel.on('closed', () => {
      parent.removeListener?.('move', onParentMove);
      parent.removeListener?.('resize', onParentMove);
      this.panel = null;
    });

    this.panel = panel;
    // 加载失败（如 dev 模式 vite dev server 未启动）：销毁面板，避免留下不可见僵尸窗口
    void this.options.onLoad(panel, mode).catch((err: unknown) => {
      log.error('bookmark panel load failed', { error: String(err) });
      if (!panel.isDestroyed()) {
        panel.destroy();
        this.panel = null;
      }
    });
    // 等页面加载完成再显示，避免白屏；show() 抢焦点，使外部点击可触发 blur 关闭
    panel.once('ready-to-show', () => {
      if (!panel.isDestroyed()) panel.show();
    });
    log.info('bookmark panel opened', { mode });
  }

  /**
   * 以 picker 模式打开面板（星标按钮未收藏时调用）。
   *
   * 已打开（任意模式）则原地按 picker 模式重新加载（复用窗口、避免重建闪烁）；
   * 未打开则新建并以 picker 模式加载。
   */
  openPicker(): void {
    if (this.isOpen && this.panel && !this.panel.isDestroyed()) {
      void this.options.onLoad(this.panel, 'picker').catch((err: unknown) => {
        log.error('bookmark panel picker reload failed', { error: String(err) });
      });
      log.info('bookmark panel reloaded in picker mode');
      return;
    }
    this.open('picker');
  }

  /** 关闭并销毁面板窗口。 */
  close(): void {
    if (this.panel && !this.panel.isDestroyed()) {
      this.panel.destroy();
    }
    this.panel = null;
    log.info('bookmark panel closed');
  }

  /**
   * 布局变化后刷新面板位置（如右侧栏宽度拖拽调节）。
   * 面板打开时按最新布局（右侧栏宽/地址栏高）重新定位。
   */
  refreshPosition(): void {
    if (!this.isOpen || !this.panel) return;
    const parent = this.options.getParentWindow();
    if (!parent) return;
    this.reposition(this.panel, parent);
  }

  /**
   * 计算面板位置：地址栏上方、右侧边栏左侧，且不遮挡网页的右/下滚动条。
   *
   * 网页（BrowserView）区域为 [leftWidth, 右缘-rightWidth] × [0, 下缘-bottomHeight]，
   * 其右/下滚动条紧贴两栏边界。面板需让出滚动条宽度（Windows 经典滚动条约 17px），
   * 再留 2px 间隙，避免盖住滑块：
   * - x = 内容区右缘 - 右侧栏宽 - 滚动条宽 - 面板宽 - 2
   * - y = 内容区下缘 - 地址栏高 - 滚动条宽 - 面板高 - 2
   * 布局尺寸来自 getLayout()（默认视为两栏折叠 44/48，与 view-integration 初始一致）。
   */
  private reposition(panel: BrowserWindow, parent: PanelHostWindow): void {
    const parentBounds = parent.getContentBounds();
    const layout = this.options.getLayout?.() ?? { rightWidth: 44, bottomHeight: 48 };
    const x =
      parentBounds.x +
      parentBounds.width -
      layout.rightWidth -
      SCROLLBAR_WIDTH -
      PANEL_WIDTH -
      PANEL_GAP;
    const y =
      parentBounds.y +
      parentBounds.height -
      layout.bottomHeight -
      SCROLLBAR_WIDTH -
      PANEL_HEIGHT -
      PANEL_GAP;
    panel.setPosition(Math.round(x), Math.round(y));
  }
}
