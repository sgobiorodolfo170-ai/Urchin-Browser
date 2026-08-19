/**
 * 框选截图 · 全屏覆盖窗口管理器（screenshot.capture 触发）
 *
 * 流程：地址栏截图按钮 → screenshot.capture → CaptureOverlay.start()：
 * 1. desktopCapturer 截主屏（thumbnailSize = 显示器物理尺寸，原始分辨率）
 * 2. 创建全屏透明置顶覆盖窗口（frame:false + transparent + alwaysOnTop + skipTaskbar）
 * 3. 加载 urchin://capture-overlay（内联 HTML：背景显示整屏截图 + 拖拽框选）
 * 4. 用户确认 → screenshot.confirm(rect 物理像素) → NativeImage.crop → 存
 *    <数据目录>/screenshots/<时间戳>.png → 打开所在文件夹 → 返回 { path }
 * 5. 取消 / Esc / 窗口关闭 → 销毁并清缓存
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - Electron 中 BrowserView 永远渲染在主窗口 webContents 之上，选区层无法用
 *   React 浮层实现，必须独立覆盖窗口（bookmark-panel 同模式）
 * - 覆盖窗口透明（transparent:true）：仅选区/遮罩可见，其余透出真实屏幕内容
 *   （背景图与真实屏幕重合，视觉上是"实时框选"）
 * - 依赖注入 createWindow 工厂（测试友好），单例防重复打开
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopCapturer, screen, shell, type BrowserWindow, type NativeImage } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('capture-overlay');

/** 截图保存子目录名（相对用户数据目录） */
const SCREENSHOTS_DIR = 'screenshots';

/** 覆盖窗口工厂（测试注入 mock，生产默认 new BrowserWindow） */
export type OverlayWindowFactory = (
  opts: Electron.BrowserWindowConstructorOptions,
) => BrowserWindow;

/** CaptureOverlay 构造依赖 */
export interface CaptureOverlayOptions {
  /** BrowserWindow 工厂（测试注入 mock） */
  createWindow: OverlayWindowFactory;
  /** preload 脚本绝对路径（urchin:// 下暴露 window.urchin） */
  preloadPath: string;
  /** 用户数据目录绝对路径（截图保存根） */
  dataDir: string;
}

/** 选区矩形（物理像素，来自覆盖窗口 dpr 换算后回传） */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CaptureOverlay {
  private window: BrowserWindow | null = null;
  /** 整屏截图缓存（物理像素 NativeImage） */
  private screenshot: NativeImage | null = null;
  /** 主显示器缩放因子（物理 → 逻辑换算） */
  private scaleFactor = 1;

  constructor(private readonly options: CaptureOverlayOptions) {}

  /** 是否已打开覆盖窗口 */
  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /**
   * 截主屏并弹出全屏覆盖窗口。
   * 已打开时不重复创建（返回 false）。
   */
  async start(): Promise<boolean> {
    if (this.isOpen) return false;

    const primary = screen.getPrimaryDisplay();
    this.scaleFactor = primary.scaleFactor;

    // 截主屏：thumbnailSize 用物理尺寸（原始分辨率），保证裁剪精度
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: primary.size.width,
        height: primary.size.height,
      },
      fetchWindowIcons: false,
    });
    const source = sources[0];
    if (!source) {
      throw new Error('No screen available to capture');
    }
    const image = source.thumbnail;
    if (image.isEmpty()) {
      throw new Error('Screen capture is empty');
    }
    this.screenshot = image;

    const win = this.options.createWindow({
      width: primary.size.width,
      height: primary.size.height,
      x: primary.bounds.x,
      y: primary.bounds.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.window = win;

    // 失焦兜底：透明全屏置顶窗口抢焦点后，用户 Alt-Tab / 点击主窗口可能使
    // 覆盖窗失焦，此时页面 keydown 不再可靠——失焦即取消，避免截图卡死
    // （2026-08-19 修复：Esc 失灵/卡死根因之一）。
    // 启动窗口期（show 后 300ms）内忽略 blur：覆盖窗抢焦点时系统可能短暂
    // 失焦再聚焦，避免误关。
    const focusStableAt = Date.now() + 300;
    win.on('blur', () => {
      if (Date.now() < focusStableAt) return;
      if (this.window === win) this.close();
    });

    // Esc 主进程兜底：before-input-event 在主进程侧拦截，不依赖渲染页焦点。
    // 页面正常时按 Esc 由页面调 screenshot.cancel；页面失焦/未注入 preload 时
    // 这里直接取消，双保险。
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        this.close();
      }
    });

    // 窗口关闭（用户 Alt+F4 / 系统）时清缓存
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.screenshot = null;
      }
    });

    await win.loadURL('urchin://capture-overlay');
    // ready-to-show 后再显示：transparent 窗口合成器未就绪直接 show 会黑屏/
    // 交互失效（卡死诱因之一），等页面首帧渲染完成再抢焦点。
    if (win.isDestroyed()) return true;
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    // 页面加载完成但 ready-to-show 未触发（如透明窗口在某些合成器下不触发）时兜底显示
    const fallbackShow = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.show();
        win.focus();
      }
    }, 500);
    // 清理兜底定时器（合并进上方 closed 清理逻辑，避免 Mock 单 handler 语义差异）
    const clearFallback = (): void => clearTimeout(fallbackShow);
    win.on('closed', clearFallback);
    log.info('capture overlay opened');
    return true;
  }

  /** 覆盖窗口拉取背景图（data URI）。 */
  getImageData(): string {
    if (!this.screenshot) {
      throw new Error('Capture overlay not started');
    }
    return this.screenshot.toDataURL();
  }

  /**
   * 确认框选：按选区（物理像素）裁剪截图 → 保存 PNG → 打开所在文件夹。
   *
   * @param rect 物理像素矩形（覆盖窗口已按 devicePixelRatio 换算）
   * @returns 保存的 PNG 文件绝对路径
   */
  confirm(rect: SelectionRect): string {
    if (!this.screenshot) {
      throw new Error('Capture overlay not started');
    }
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error('Invalid selection rect');
    }

    const cropped = this.screenshot.crop({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const png = cropped.toPNG();

    const dir = join(this.options.dataDir, SCREENSHOTS_DIR);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, screenshotFileName(new Date()));
    writeFileSync(filePath, png);

    this.close();
    log.info('screenshot saved', { path: filePath });
    shell.showItemInFolder(filePath);
    return filePath;
  }

  /** 取消框选：关闭覆盖窗口并清缓存。 */
  cancel(): void {
    this.close();
  }

  // 关闭并清理。
  private close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
    this.screenshot = null;
  }
}

/** 生成截图文件名：yyyyMMdd-HHmmss.png（同一秒内连截不会覆盖）。 */
function screenshotFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}.png`;
}
