/**
 * M26 剪藏 · MHTML / PDF / 截图 导出
 *
 * 核心策略：
 * - original：直接对当前 tab 的 webContents 导出，保留原页版式；
 * - clean：面板先用 Defuddle 生成清洗后的 HTML，这里写入临时文件，用隐藏
 *   BrowserWindow 加载后再导出，从而剔除广告/导航/侧栏等非正文。
 *
 * 安全与边界：
 * - 清洗 HTML 由本项目的面板生成，导出窗口 javascript 开启仅用于等待图片加载；
 *   页面脚本/iframe 已在面板侧移除。
 * - 原页导出不执行页面脚本，只调用 Electron 原生 savePage/printToPDF/CDP 截图。
 */
import { BrowserWindow } from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClipperSnapshotMode } from '@urchin/ipc-contract';
import type { ClipperStore } from './store';

/** 快照格式（不含 markdown；ocr 为占位） */
export type SnapshotFormat = 'mhtml' | 'pdf' | 'screenshot';

/** 全页截图最大高度（px）；超过时截取顶部并提示由调用方处理 */
const MAX_SCREENSHOT_HEIGHT = 16_000;
/** 等待图片/字体加载的上限（毫秒） */
const ASSET_WAIT_TIMEOUT_MS = 10_000;
/** 隐藏导出窗口尺寸（CSS px） */
const EXPORT_WINDOW_WIDTH = 1_200;
const EXPORT_WINDOW_HEIGHT = 900;

/** PDF 导出选项：A4、保留背景色、四边 0.4 英寸边距 */
const PDF_OPTIONS = {
  printBackground: true,
  pageSize: 'A4',
  margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
} as const;

interface DebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

interface NativeImageLike {
  toPNG(): Buffer;
}

/** 导出所需的 webContents 最小接口 */
export interface SnapshotWebContents {
  savePage?(path: string, type: 'HTMLOnly' | 'HTMLComplete' | 'MHTML'): Promise<void>;
  printToPDF?(options?: unknown): Promise<Buffer>;
  capturePage?(): Promise<NativeImageLike>;
  executeJavaScript?<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  readonly debugger?: DebuggerLike;
  isDestroyed?(): boolean;
  close?(): void;
}

/** 隐藏窗口最小接口 */
interface HiddenWindowLike {
  readonly webContents: SnapshotWebContents;
  loadFile(path: string): Promise<void>;
  destroy(): void;
  isDestroyed?(): boolean;
}

export interface SnapshotExportDeps {
  readonly store: ClipperStore;
  /** 隐藏窗口工厂（单测注入 mock） */
  readonly createWindow?: (options: Electron.BrowserWindowConstructorOptions) => HiddenWindowLike;
  readonly mkdtemp?: typeof mkdtemp;
  readonly writeFile?: typeof writeFile;
  readonly rm?: typeof rm;
  readonly tempDir?: string;
}

export interface SnapshotExportInput {
  /** original 模式必需；clean 模式不使用（面板已生成清洗 HTML） */
  readonly tabWebContents?: SnapshotWebContents;
  readonly format: SnapshotFormat;
  readonly mode: ClipperSnapshotMode;
  readonly noteName: string;
  readonly cleanedHtml?: string;
  /** 保存子目录（空=clipper 根目录） */
  readonly subDir?: string;
}

interface LayoutMetrics {
  readonly cssContentSize?: { readonly width: number; readonly height: number };
  readonly contentSize?: { readonly width: number; readonly height: number };
}

interface ScreenshotResult {
  readonly data?: string;
}

/** 截图结果：可能因超长拆成多段 */
interface ScreenshotCaptureResult {
  readonly buffers: Buffer[];
  readonly warnings: string[];
}

/** 导出结果：路径（截图可能多段）+ 非致命提示 */
export interface SnapshotExportResult {
  readonly paths: string[];
  readonly warnings: string[];
}

/** 等待页面图片/字体加载（超时返回，不阻断导出） */
async function waitForAssets(contents: SnapshotWebContents): Promise<void> {
  if (!contents.executeJavaScript) return;
  const script = `
(async function () {
  function waitImage(img) {
    if (img.complete) return Promise.resolve();
    return new Promise(function (resolve) {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  }
  try {
    await Promise.all(Array.from(document.images).map(waitImage));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (e) { console.warn('[urchin snapshot-export]', e); }
  return true;
})();
`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      contents.executeJavaScript(script, true),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ASSET_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 通过 CDP 截取整页；超长页面按 MAX_SCREENSHOT_HEIGHT 分段，CDP 失败回退视口截图 */
async function captureFullPage(contents: SnapshotWebContents): Promise<ScreenshotCaptureResult> {
  const dbg = contents.debugger;
  if (dbg) {
    let attachedByUs = false;
    try {
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        attachedByUs = true;
      }
      const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as LayoutMetrics;
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size && size.width > 0 && size.height > 0) {
        const width = Math.ceil(size.width);
        const totalHeight = Math.ceil(size.height);
        const segments = Math.max(1, Math.ceil(totalHeight / MAX_SCREENSHOT_HEIGHT));
        const buffers: Buffer[] = [];
        for (let index = 0; index < segments; index += 1) {
          const y = index * MAX_SCREENSHOT_HEIGHT;
          const height = Math.min(MAX_SCREENSHOT_HEIGHT, totalHeight - y);
          const result = (await dbg.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: 0, y, width, height, scale: 1 },
          })) as ScreenshotResult;
          if (result.data) buffers.push(Buffer.from(result.data, 'base64'));
        }
        if (buffers.length > 0) {
          return {
            buffers,
            warnings:
              segments > 1
                ? [`页面高度超过 ${MAX_SCREENSHOT_HEIGHT}px，已分段保存为 ${buffers.length} 张截图`]
                : [],
          };
        }
      }
    } catch {
      // CDP 失败（页面过大/调试器冲突）→ 回退 viewport 截图
    } finally {
      if (attachedByUs) {
        try {
          dbg.detach();
        } catch {
          // ignore
        }
      }
    }
  }
  if (contents.capturePage) {
    const image = await contents.capturePage();
    return {
      buffers: [image.toPNG()],
      warnings: ['全页截图不可用，已回退为可视区域截图'],
    };
  }
  throw new Error('当前页面无法截图');
}

/** 创建隐藏导出窗口（真实 Electron） */
function createDefaultWindow(options: Electron.BrowserWindowConstructorOptions): HiddenWindowLike {
  return new BrowserWindow(options);
}

/** 导出快照并返回最终文件路径（截图可能多段） */
export async function exportSnapshot(
  deps: SnapshotExportDeps,
  input: SnapshotExportInput,
): Promise<SnapshotExportResult> {
  if (input.mode === 'original') {
    if (!input.tabWebContents) throw new Error('原页快照缺少目标标签页');
    return exportFromContents(
      input.tabWebContents,
      input.format,
      input.noteName,
      deps,
      input.subDir,
    );
  }

  if (!input.cleanedHtml) {
    throw new Error('清洗快照缺少正文 HTML');
  }

  const makeTempDir = deps.mkdtemp ?? mkdtemp;
  const write = deps.writeFile ?? writeFile;
  const remove = deps.rm ?? rm;
  const tempDir = await makeTempDir(join(deps.tempDir ?? tmpdir(), 'urchin-clipper-'));
  const htmlPath = join(tempDir, 'document.html');
  let win: HiddenWindowLike | null = null;
  try {
    await write(htmlPath, input.cleanedHtml, 'utf-8');
    const create = deps.createWindow ?? createDefaultWindow;
    win = create({
      width: EXPORT_WINDOW_WIDTH,
      height: EXPORT_WINDOW_HEIGHT,
      show: false,
      frame: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    await win.loadFile(htmlPath);
    await waitForAssets(win.webContents);
    return await exportFromContents(
      win.webContents,
      input.format,
      input.noteName,
      deps,
      input.subDir,
    );
  } finally {
    try {
      if (win && !win.isDestroyed?.()) win.destroy();
    } catch {
      // ignore
    }
    await remove(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 对指定 webContents 执行具体导出 */
async function exportFromContents(
  contents: SnapshotWebContents,
  format: SnapshotFormat,
  noteName: string,
  deps: SnapshotExportDeps,
  subDir?: string,
): Promise<SnapshotExportResult> {
  if (format === 'mhtml') {
    if (!contents.savePage) throw new Error('当前页面不支持 MHTML 导出');
    const target = await deps.store.reservePath(noteName, 'mhtml', subDir);
    await contents.savePage(target, 'MHTML');
    return { paths: [target], warnings: [] };
  }
  if (format === 'pdf') {
    if (!contents.printToPDF) throw new Error('当前页面不支持 PDF 导出');
    const target = await deps.store.reservePath(noteName, 'pdf', subDir);
    const buffer = await contents.printToPDF(PDF_OPTIONS);
    await (deps.writeFile ?? writeFile)(target, buffer);
    return { paths: [target], warnings: [] };
  }

  const screenshot = await captureFullPage(contents);
  const paths: string[] = [];
  for (let index = 0; index < screenshot.buffers.length; index += 1) {
    const name = index === 0 ? noteName : `${noteName}-part${index + 1}`;
    const target = await deps.store.reservePath(name, 'png', subDir);
    await (deps.writeFile ?? writeFile)(target, screenshot.buffers[index]!);
    paths.push(target);
  }
  return { paths, warnings: screenshot.warnings };
}
