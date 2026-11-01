/**
 * M26 剪藏 · 面板窗口
 *
 * 独立无边框子窗口，复用收藏夹面板/状态栏的窗口模式：
 * - 面板悬浮于网页之上，避免 BrowserView 遮挡 React 浮层的问题；
 * - 失焦即关闭（点击主窗口/网页后自动收起）；
 * - 跟随主窗口移动与缩放重新定位；
 * - 页面由渲染进程 `?view=clipper&tabId=<id>` 动态加载。
 */
import { BrowserWindow } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('clipper-panel');

/** 面板尺寸（px） */
const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 700;
/** 面板与状态栏/内容区边缘的间距 */
const PANEL_GAP = 8;

interface PanelHostWindow {
  getContentBounds(): { x: number; y: number; width: number; height: number };
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isDestroyed?(): boolean;
}
export type { PanelHostWindow };

export interface ClipperPanelOptions {
  readonly getParentWindow: () => PanelHostWindow | null;
  readonly preloadPath: string;
  readonly getLayout: () => { leftWidth: number; rightWidth: number; bottomHeight: number };
  /** 加载面板页面（dev: dev server + ?view=clipper；prod: loadFile + query） */
  readonly onLoad: (win: BrowserWindow, tabId: number) => Promise<void>;
  readonly createWindow?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
}

/** 计算面板位置：水平居中于中区，底部贴状态栏上方 */
export function computeClipperPanelBounds(params: {
  contentBounds: { x: number; y: number; width: number; height: number };
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
}): { x: number; y: number; width: number; height: number } {
  const { contentBounds, leftWidth, rightWidth, bottomHeight } = params;
  const middleWidth = Math.max(0, contentBounds.width - leftWidth - rightWidth);
  const width = Math.min(PANEL_WIDTH, Math.max(320, middleWidth - PANEL_GAP * 2));
  const height = Math.min(
    PANEL_HEIGHT,
    Math.max(360, contentBounds.height - bottomHeight - PANEL_GAP * 3),
  );
  const x = Math.round(contentBounds.x + leftWidth + (middleWidth - width) / 2);
  const y = Math.round(contentBounds.y + contentBounds.height - bottomHeight - height - PANEL_GAP);
  return { x, y, width, height };
}

export class ClipperPanel {
  private win: BrowserWindow | null = null;
  private readonly options: ClipperPanelOptions;

  constructor(options: ClipperPanelOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /** 打开面板；已打开时先关闭再按新 tabId 重载，避免旧页面残留 */
  open(tabId: number): void {
    if (this.isOpen) this.close();
    const parent = this.options.getParentWindow();
    if (!parent) {
      log.warn('clipper panel: parent window not available');
      return;
    }

    const create = this.options.createWindow ?? ((options) => new BrowserWindow(options));
    const win = create({
      ...computeClipperPanelBounds({
        contentBounds: parent.getContentBounds(),
        ...this.options.getLayout(),
      }),
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;

    // 点击面板外（主窗口/网页）→ 失焦关闭；与收藏夹面板一致。
    win.on('blur', () => this.close());
    const onParentMove = (): void => this.reposition(win, parent);
    parent.on('move', onParentMove);
    parent.on('resize', onParentMove);
    win.on('closed', () => {
      parent.removeListener?.('move', onParentMove);
      parent.removeListener?.('resize', onParentMove);
      this.win = null;
    });

    // 安全：面板页面只允许本应用内部页面，不允许导航/弹窗。
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    void this.options
      .onLoad(win, tabId)
      .then(() => {
        if (!win.isDestroyed()) win.show();
      })
      .catch((err: unknown) => {
        log.error('clipper panel load failed', { error: String(err) });
        if (!win.isDestroyed()) win.destroy();
        this.win = null;
      });
    log.info('clipper panel opened', { tabId });
  }

  /** 关闭并销毁面板窗口（幂等） */
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    log.info('clipper panel closed');
  }

  private reposition(win: BrowserWindow, parent: PanelHostWindow): void {
    if (win.isDestroyed()) return;
    const bounds = computeClipperPanelBounds({
      contentBounds: parent.getContentBounds(),
      ...this.options.getLayout(),
    });
    win.setBounds(bounds);
  }
}
