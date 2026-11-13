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
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点）：
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

import { getWindowBounds } from './window-bounds';

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
  private starting = false;
  /** 整屏截图缓存（物理像素 NativeImage） */
  private screenshot: NativeImage | null = null;
  /** 主显示器缩放因子（物理 → 逻辑换算） */
  private scaleFactor = 1;
  private windows: SelectionRect[] = [];

  getWindowRects(): SelectionRect[] {
    return this.windows;
  }

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
    if (this.isOpen || this.starting) return false;
    this.starting = true;
    try {
      return await this.open();
    } catch (error) {
      this.close();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async open(): Promise<boolean> {
    const primary = screen.getPrimaryDisplay();
    this.scaleFactor = primary.scaleFactor;

    this.windows = (await getWindowBounds())
      .map((r) => ({
        x: Math.max(0, r.x / this.scaleFactor - primary.bounds.x),
        y: Math.max(0, r.y / this.scaleFactor - primary.bounds.y),
        width:
          Math.min(primary.bounds.width, (r.x + r.width) / this.scaleFactor - primary.bounds.x) -
          Math.max(0, r.x / this.scaleFactor - primary.bounds.x),
        height:
          Math.min(primary.bounds.height, (r.y + r.height) / this.scaleFactor - primary.bounds.y) -
          Math.max(0, r.y / this.scaleFactor - primary.bounds.y),
      }))
      .filter((r) => r.width > 0 && r.height > 0);

    // 截主屏：thumbnailSize 用物理尺寸（原始分辨率），保证裁剪精度
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(primary.size.width * this.scaleFactor),
        height: Math.round(primary.size.height * this.scaleFactor),
      },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0];
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
      transparent: false,
      show: false,
      enableLargerThanScreen: true,
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

    // 页面背景图解码后才显示，避免先显示空白透明窗。
    await win.loadURL('urchin://capture-overlay');
    if (win.isDestroyed()) return true;
    await win.webContents.executeJavaScript(`(async () => {
      const img = document.getElementById('screen');
      if (!img.complete || !img.src) await new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', reject, { once: true });
      });
      await img.decode();
    })()`);
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.show();
      win.focus();
    }
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

  /**
   * 拖拽框选：裁剪截图 → 保存 PNG → 发起 OS 级文件拖拽（webContents.startDrag）
   * → 关闭覆盖窗口。用户拖到中转区松开后由中转区 onDrop 接收文件路径。
   *
   * 与 confirm 的区别：不打开文件夹，而是通过 startDrag 让用户拖到目标区域。
   *
   * @param rect 物理像素矩形（覆盖窗口已按 devicePixelRatio 换算）
   * @returns 保存的 PNG 文件绝对路径
   */
  dragStart(rect: SelectionRect): string {
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

    // 发起 OS 级文件拖拽：用户拖到中转区松开即存入（真实存储位置仍在 screenshots/）
    const win = this.window;
    if (win && !win.isDestroyed()) {
      const iconImg = cropped.resize({ width: 120 });
      win.webContents.startDrag({
        file: filePath,
        icon: iconImg,
      });
    }

    this.close();
    log.info('screenshot drag started', { path: filePath });
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
