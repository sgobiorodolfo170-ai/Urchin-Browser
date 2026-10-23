/**
 * 工作区窗口快照合成（工作区总览页卡片用）。
 *
 * 为什么不是单张截图：
 * - 窗口 UI（左/右侧栏、底部地址栏）由渲染进程 webContents 渲染 → window.captureUi；
 * - 网页内容由独立 BrowserView 渲染，不在窗口 webContents 的截图里
 *   → tab.captureThumbnail 抓激活标签，再按内容区 DOM 矩形叠加；
 * - 两者在 canvas 上合成为「该工作区整个浏览器窗口」的截图（含激活标签网页）。
 *
 * 纯展示用途（display-only hint）：任一 IPC 失败返回 null，卡片降级为占位图，
 * 不影响标签/工作区功能。内部页（设置/主页等）由 React 渲染，shell 截图已包含，
 * 调用方传 activeTabId=null 跳过叠加，避免重复绘制。
 */

/** 合成图最大宽度（px）：控制内存与 dataURL 体积（卡片预览足够清晰）。 */
const MAX_SNAPSHOT_WIDTH = 1280;

/** JPEG 质量：窗口截图含大量文字/渐变，0.85 在体积与清晰度间平衡。 */
const JPEG_QUALITY = 0.85;

export interface WindowSnapshotContentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CaptureWindowSnapshotOptions {
  readonly windowId: number;
  /** 需要叠加的网页标签 id；内部页/无标签传 null（shell 截图已包含内容）。 */
  readonly activeTabId: number | null;
  /** 网页 BrowserView 对应的内容区 DOM 矩形（CSS px，视口坐标）。 */
  readonly contentRect: WindowSnapshotContentRect | null;
}

/** 加载 dataURL 为 HTMLImageElement。 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('snapshot image load failed'));
    img.src = src;
  });
}

/**
 * 抓取并合成当前窗口快照。
 *
 * @returns JPEG data URL；失败（无窗口/截图空白/canvas 不可用）返回 null。
 */
export async function captureWindowSnapshot(
  opts: CaptureWindowSnapshotOptions,
): Promise<string | null> {
  try {
    const shell = (await window.urchin.invoke('window.captureUi', {
      windowId: opts.windowId,
    })) as { dataUrl: string | null };
    if (!shell?.dataUrl) return null;

    const shellImg = await loadImage(shell.dataUrl);
    if (shellImg.naturalWidth <= 0 || shellImg.naturalHeight <= 0) return null;

    const scale = Math.min(1, MAX_SNAPSHOT_WIDTH / shellImg.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(shellImg.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(shellImg.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(shellImg, 0, 0, canvas.width, canvas.height);

    // 网页叠加：把 BrowserView 截图画到内容区矩形位置。
    // canvas 坐标 = CSS 坐标 × (画布宽 / 窗口 CSS 宽)，兼容 DPR 与缩放；
    // shell 宽高比与窗口一致，故 x/y 换算使用同一比例。
    const rect = opts.contentRect;
    if (opts.activeTabId !== null && rect && rect.width > 0 && rect.height > 0) {
      const page = (await window.urchin.invoke('tab.captureThumbnail', {
        tabId: opts.activeTabId,
      })) as { dataUrl: string | null };
      if (page?.dataUrl) {
        const pageImg = await loadImage(page.dataUrl);
        const cssToCanvas = canvas.width / Math.max(1, window.innerWidth);
        ctx.drawImage(
          pageImg,
          rect.x * cssToCanvas,
          rect.y * cssToCanvas,
          rect.width * cssToCanvas,
          rect.height * cssToCanvas,
        );
      }
    }

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch (err) {
    console.error('captureWindowSnapshot failed:', err);
    return null;
  }
}
