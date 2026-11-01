/**
 * M26 剪藏 · MHTML 只读查看器
 *
 * MHTML 是 Chromium 支持的 MIME 快照格式。这里用独立 BrowserView 承载：
 * - javascript:false：MHTML 来自不可信网页，禁止其中脚本执行；
 * - 不注入 preload：即使页面有脚本也无法访问 window.urchin / IPC；
 * - 禁止本视图导航：点击链接改为在新标签打开普通网页，避免后续页面在禁用
 *   JS 的查看器中运行。
 *
 * 若当前 Electron 版本无法渲染 file:// MHTML，调用方回落外部浏览器/自研解析器
 * （见 docs/网页剪藏功能规划.md 的兜底方案）。
 */
import { BrowserView } from 'electron';
import { createLogger } from '@urchin/logger';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const log = createLogger('clipper-mhtml-viewer');

export interface MhtmlViewerOptions {
  /** 打开 MHTML 内的外部链接（由宿主创建普通标签） */
  readonly openUrl: (url: string) => void;
  /** 页面背景色（与主题一致） */
  readonly backgroundColor?: string;
  /**
   * 是否由本函数立即加载 MHTML。
   * routeLocalFile 通过 TabManager 创建标签时会由 TabManager 加载 URL，
   * 此时传 false 避免二次加载闪烁。
   */
  readonly autoLoad?: boolean;
}

/**
 * 创建 MHTML 只读 BrowserView。
 *
 * @param filePath MHTML 绝对路径
 * @param options 链接打开回调与背景色
 */
export function createMhtmlView(filePath: string, options: MhtmlViewerOptions): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 关键：MHTML 可能携带脚本；只读快照不需要任何脚本执行。
      javascript: false,
      // 不注入 preload：外部快照页面绝不暴露宿主 API。
    },
  });
  try {
    view.setBackgroundColor(options.backgroundColor ?? '#ffffff');
  } catch {
    // 老版本 Electron 可能没有该方法；忽略即可
  }

  const contents = view.webContents;
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      options.openUrl(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) options.openUrl(url);
    return { action: 'deny' };
  });

  const url = pathToFileURL(filePath).toString();
  if (options.autoLoad !== false) {
    void contents.loadURL(url).catch((err: unknown) => {
      log.warn('mhtml load failed', { error: String(err) });
      // 保留错误页空白；调用方可改用外部浏览器打开。
    });
  }
  log.info('mhtml viewer created', { bytes: safeSize(filePath) });
  return view;
}

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
