/**
 * M26 剪藏 · IPC Handler 注册
 *
 * 通道：
 * - clipper.open：打开面板
 * - clipper.page：采集页面快照（主 frame + 子 frame + closed shadow 兜底）
 * - clipper.config：返回设置默认值、主题、保存目录标签
 * - clipper.saveMarkdown / clipper.saveSnapshot：落盘
 * - clipper.copy / clipper.close
 *
 * 安全边界：
 * - 只接受 tabId，不接收任意文件路径；保存目录由 ClipperStore 固定。
 * - 只允许 http/https 页面剪藏；内部页/本地页明确拒绝。
 * - 日志不记录页面 URL/标题/正文，只记录 tabId、格式与文件路径。
 */
import { clipboard, nativeTheme } from 'electron';
import { existsSync } from 'node:fs';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import type {
  ClipperConfigRes,
  ClipperFormat,
  ClipperPageRes,
  ClipperSnapshotMode,
} from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { ClipperStore } from './store';
import {
  capturePageSnapshot,
  type PageSnapshot,
  type SnapshotFrameLike,
  type SnapshotWebContents,
} from './page-snapshot';
import {
  collectClosedShadowHtml,
  collectSubFrames,
  shouldTryClosedShadow,
  type DeepExtractWebContents,
} from './deep-extract';
import { exportSnapshot, type SnapshotFormat } from './snapshot-export';
const log = createLogger('clipper-ipc');

/** 面板最小接口（真实 ClipperPanel / 单测 mock） */
export interface ClipperPanelLike {
  open(tabId: number): void;
  close(): void;
}

/** tab 最小接口 */
export interface ClipperTabLike {
  readonly id: number;
  readonly url: string;
  readonly webContents: SnapshotWebContents & DeepExtractWebContents;
}

export interface ClipperTabManagerLike {
  getTab(tabId: number): ClipperTabLike | undefined;
}

export interface ClipperSettingsLike {
  get(key: string): unknown;
}

export interface ClipperHandlerDeps {
  readonly ipcMain: Parameters<typeof registerHandler>[0];
  readonly tabManager: ClipperTabManagerLike;
  readonly settings: ClipperSettingsLike;
  readonly panel: ClipperPanelLike;
  readonly store: ClipperStore;
  readonly captureSnapshot?: (
    webContents: SnapshotWebContents,
    options: { readonly loadLazy: boolean; readonly frameList: readonly SnapshotFrameLike[] },
  ) => Promise<PageSnapshot>;
  readonly closedShadowHtml?: (webContents: DeepExtractWebContents) => Promise<string>;
  readonly shouldTryClosed?: (signals: ClipperPageRes['signals']) => boolean;
  /** 主题读取（默认 nativeTheme；单测可注入） */
  readonly getTheme?: () => 'light' | 'dark';
  /** 快照导出实现（默认 exportSnapshot；单测可注入） */
  readonly saveSnapshot?: typeof exportSnapshot;
  /** 复制实现（默认 Electron clipboard；单测可注入） */
  readonly copyText?: (text: string) => void;
  /** 用宿主只读查看器打开本地 MHTML（默认不提供；index.ts 注入 routeLocalFile） */
  readonly openMhtmlFile?: (path: string) => void;
}

/** 与 IPC schema 一致的 HTML 上限 */
const MAX_HTML_CHARS = 16 * 1024 * 1024;

/** 把补充 HTML 插入正文容器内（否则 Defuddle 只取 article/main，会丢弃 body 尾部内容） */
function appendHtmlCap(html: string, extra: string): string {
  if (!extra) return html;
  const lower = html.toLowerCase();
  // 优先插入 article/main 内，保证 Defuddle 选中正文时仍包含补抽内容；
  // 再退化到 </body> 前，最后才直接拼到末尾。
  for (const marker of ['</article>', '</main>', '</body>']) {
    const index = lower.lastIndexOf(marker);
    if (index >= 0) {
      const merged = `${html.slice(0, index)}\n${extra}\n${html.slice(index)}`;
      return merged.length > MAX_HTML_CHARS ? merged.slice(0, MAX_HTML_CHARS) : merged;
    }
  }
  const merged = `${html}\n${extra}`;
  return merged.length > MAX_HTML_CHARS ? merged.slice(0, MAX_HTML_CHARS) : merged;
}

function getString(settings: ClipperSettingsLike, key: string, fallback: string): string {
  const value = settings.get(key);
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(settings: ClipperSettingsLike, key: string, fallback: boolean): boolean {
  const value = settings.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

function getFormat(settings: ClipperSettingsLike): ClipperFormat {
  const value = settings.get('clipper.defaultFormat');
  return value === 'mhtml' || value === 'pdf' || value === 'screenshot' || value === 'ocr'
    ? value
    : 'markdown';
}

/** 仅 http/https 页面可剪藏（内部页/本地文件明确拒绝） */
export function isClipableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function requireClipableTab(
  tabManager: ClipperTabManagerLike,
  tabId: number,
  channel: string,
): ClipperTabLike {
  const tab = tabManager.getTab(tabId);
  if (!tab) {
    throw new IpcError(IpcErrorCode.NOT_FOUND, `Tab not found: ${tabId}`, { channel });
  }
  if (!isClipableUrl(tab.url)) {
    throw new IpcError(IpcErrorCode.VALIDATION, '当前页面不支持剪藏（仅 http/https）', {
      channel,
    });
  }
  return tab;
}

/** 注册 clipper 域 handler */
export function registerClipperHandlers(deps: ClipperHandlerDeps): void {
  const { ipcMain, tabManager, settings, panel, store } = deps;
  const captureSnapshot = deps.captureSnapshot ?? capturePageSnapshot;
  const closedShadowHtml = deps.closedShadowHtml ?? collectClosedShadowHtml;
  const shouldTryClosed = deps.shouldTryClosed ?? shouldTryClosedShadow;
  const getTheme = deps.getTheme ?? (() => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  const saveSnapshot = deps.saveSnapshot ?? exportSnapshot;
  const copyText = deps.copyText ?? ((text: string) => clipboard.writeText(text));

  registerHandler(ipcMain, 'clipper.open', (req) => {
    requireClipableTab(tabManager, req.tabId, 'clipper.open');
    panel.open(req.tabId);
    return { ok: true as const };
  });

  registerHandler(ipcMain, 'clipper.page', async (req): Promise<ClipperPageRes> => {
    const tab = requireClipableTab(tabManager, req.tabId, 'clipper.page');
    const loadLazy = getBoolean(settings, 'clipper.loadLazyContent', false);
    const frameList = collectSubFrames(tab.webContents);
    let snapshot = await captureSnapshot(tab.webContents, { loadLazy, frameList });

    // closed shadow 只在文本很少/有 canvas 时尝试；CDP 失败返回空串。
    if (shouldTryClosed(snapshot.signals)) {
      const extra = await closedShadowHtml(tab.webContents);
      if (extra) {
        snapshot = {
          ...snapshot,
          html: appendHtmlCap(snapshot.html, extra),
          signals: { ...snapshot.signals, hasClosedShadow: true },
        };
      }
    }

    log.info('clipper.page snapshot', {
      tabId: req.tabId,
      htmlChars: snapshot.html.length,
      textLength: snapshot.signals.textLength,
      frames: frameList.length,
    });

    return {
      url: snapshot.url,
      title: snapshot.title,
      ...(snapshot.favicon ? { favicon: snapshot.favicon } : {}),
      html: snapshot.html,
      selectionHtml: snapshot.selectionHtml,
      selectionText: snapshot.selectionText,
      signals: snapshot.signals,
    };
  });

  registerHandler(ipcMain, 'clipper.config', (): ClipperConfigRes => {
    const format = getFormat(settings);
    return {
      theme: getTheme(),
      // ocr 只是占位：配置层允许返回，面板会禁用该选项。
      defaultFormat: format,
      cleanSnapshot: getBoolean(settings, 'clipper.cleanSnapshot', true),
      selectionPriority: getBoolean(settings, 'clipper.selectionPriority', true),
      loadLazyContent: getBoolean(settings, 'clipper.loadLazyContent', false),
      noteNameFormat: getString(settings, 'clipper.noteNameFormat', '{{title}}'),
      properties: getString(settings, 'clipper.properties', ''),
      content: getString(settings, 'clipper.content', '{{content}}'),
      saveDirLabel: 'documents/clipper',
    };
  });

  registerHandler(ipcMain, 'clipper.saveMarkdown', async (req) => {
    const path = await store.saveMarkdown(req.noteName, req.markdown);
    log.info('clipper markdown saved', { path, bytes: Buffer.byteLength(req.markdown, 'utf-8') });
    return { path };
  });

  registerHandler(ipcMain, 'clipper.saveSnapshot', async (req) => {
    // zod schema 已把 format 限定为 mhtml/pdf/screenshot，这里直接作为快照格式使用。
    const format: SnapshotFormat = req.format;
    const mode: ClipperSnapshotMode = req.mode;
    if (mode === 'clean' && !req.cleanedHtml) {
      throw new IpcError(IpcErrorCode.VALIDATION, '清洗快照缺少正文 HTML', {
        channel: 'clipper.saveSnapshot',
      });
    }
    // original 必须依赖存活 tab；clean 已由面板生成 HTML，tab 关闭仍可保存。
    if (mode === 'original' && !req.tabId) {
      throw new IpcError(IpcErrorCode.VALIDATION, '原页快照缺少 tabId', {
        channel: 'clipper.saveSnapshot',
      });
    }
    const tab =
      mode === 'original'
        ? requireClipableTab(tabManager, req.tabId ?? 0, 'clipper.saveSnapshot')
        : undefined;
    const result = await saveSnapshot(
      { store },
      {
        ...(tab ? { tabWebContents: tab.webContents } : {}),
        format,
        mode,
        noteName: req.noteName,
        ...(req.cleanedHtml ? { cleanedHtml: req.cleanedHtml } : {}),
      },
    );
    log.info('clipper snapshot saved', {
      tabId: req.tabId,
      format,
      files: result.paths.length,
    });
    return result;
  });

  registerHandler(ipcMain, 'clipper.copy', (req) => {
    copyText(req.text);
    return { ok: true as const };
  });

  registerHandler(ipcMain, 'clipper.close', () => {
    panel.close();
    return { ok: true as const };
  });

  registerHandler(ipcMain, 'clipper.openMhtmlFile', (req) => {
    if (!/\.(mhtml|mht)$/i.test(req.path)) {
      throw new IpcError(IpcErrorCode.VALIDATION, '仅支持 .mhtml / .mht 文件', {
        channel: 'clipper.openMhtmlFile',
      });
    }
    if (!existsSync(req.path)) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, 'MHTML 文件不存在', {
        channel: 'clipper.openMhtmlFile',
      });
    }
    if (!deps.openMhtmlFile) {
      throw new IpcError(IpcErrorCode.UNAVAILABLE, 'MHTML 查看器不可用', {
        channel: 'clipper.openMhtmlFile',
      });
    }
    deps.openMhtmlFile(req.path);
    return { ok: true as const };
  });

  log.info('clipper ipc handlers registered');
}
