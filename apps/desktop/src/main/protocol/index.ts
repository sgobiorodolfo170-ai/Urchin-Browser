/**
 * urchin:// 内部协议模块入口
 *
 * 依据：02-架构设计 §4 安全边界 / 04-模块全景 M7
 * 职责：
 * 1. 注册 urchin: scheme 为特权协议（支持 fetch、storage、cookies）
 * 2. 注册 urchin:// 协议处理器
 * 3. 路由 urchin://settings → 设置页 HTML
 *
 * 必须在 app.whenReady() 之前调用 registerSchemesAsPrivileged，
 * 在 app.whenReady() 之后调用 registerUrchinProtocol。
 */
import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createLogger } from '@urchin/logger';
import { getBookmarkPanelHtml } from '../panel/bookmark-panel';
import { getCaptureOverlayHtml } from '../screenshots/capture-overlay-html';
import { inferMimeType } from '../files/file-kind';

const log = createLogger('urchin-protocol');

/** urchin:// 协议的 scheme 名（不含冒号） */
export const URCHIN_SCHEME = 'urchin';

/**
 * 注册 urchin: 为特权协议（必须在 app ready 之前调用）。
 *
 * 特权：标准、支持 fetch、Bypass CSP、secure、允许 service workers。
 */
export function registerUrchinSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: URCHIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
  log.info('urchin scheme registered as privileged');
}

/**
 * 解析 file-resource URL 中的文件绝对路径。
 * URL 形态：urchin://file-resource/<encodeURIComponent(路径)>；解析失败返回 null。
 */
export function parseResourcePath(url: URL): string | null {
  // pathname 首字符是 '/'，decodeURIComponent 解码（保留真实路径）
  const raw = url.pathname.replace(/^\//, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 本地文件响应计划：决定状态码/响应头/是否分段流。 */
export interface FileResponsePlan {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** 非空时按 start/end 分段流返回；null 表示全量流。 */
  readonly streamRange: { start: number; end: number } | null;
}

/**
 * 计算本地文件响应计划（纯函数，可单测）。
 *
 * 来源校验（防外部网页跨源盗读本地文件，urchin: 已配 corsEnabled）：
 * - 空 Referer 放行——Chromium 媒体/图片子资源请求在跨源场景可能不携带
 *   Referer，误杀会导致 <video>/<img> 加载失败
 * - 非空 Referer 须命中可信白名单（urchin:// 内部页面、localhost 开发模式、
 *   file:// 生产主窗口），其余（任意 http/https 远程网页）拒绝 403
 * - 无 Range → 200 全量；Range 合法 → 206 + Content-Range/Content-Length；
 *   Range 非法/越界 → 416
 */
export function planLocalFileResponse(
  referer: string,
  rangeHeader: string | null,
  fileSize: number,
  mimeType: string,
): FileResponsePlan {
  if (referer !== '' && !isTrustedReferer(referer)) {
    return { status: 403, headers: { 'Content-Type': 'text/plain' }, streamRange: null };
  }
  if (!rangeHeader) {
    return {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(fileSize),
      },
      streamRange: null,
    };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return { status: 416, headers: { 'Content-Type': 'text/plain' }, streamRange: null };
  }
  const start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : fileSize - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
    return {
      status: 416,
      headers: { 'Content-Type': 'text/plain', 'Content-Range': `bytes */${fileSize}` },
      streamRange: null,
    };
  }
  end = Math.min(end, fileSize - 1);
  return {
    status: 206,
    headers: {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(end - start + 1),
    },
    streamRange: { start, end },
  };
}

/**
 * 本地文件来源白名单：urchin:// 内部页面、localhost 开发模式（http://localhost[:port] /
 * http://127.0.0.1[:port]）、file:// 生产主窗口。
 * FileViewer 是主窗口 React 组件——开发运行于 localhost:5173、生产为 file://，
 * 它的 <img>/<video>/<iframe> 资源请求 Referer 即来源页地址，必须放行；
 * 任意 http/https 远程网页一律拒绝（防盗读用户本地文件）。
 */
function isTrustedReferer(referer: string): boolean {
  if (referer.startsWith('urchin://')) return true;
  if (referer.startsWith('file://')) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(referer)) return true;
  return false;
}

/**
 * 服务本地文件（file-resource host）。
 *
 * 安全（agents.md §六 隐私）：
 * - 来源经 isTrustedReferer 白名单校验（urchin:// / localhost / file:// 放行，
 *   远程网页拒绝）——urchin: 已配 corsEnabled，不校验 = 任意网页可跨源盗读本地文件
 * - 路径来自 encodeURIComponent 编码后的绝对路径，不支持相对路径/目录遍历
 *
 * Range 支持（视频拖动 seek）：计划由 planLocalFileResponse 纯函数计算，
 * 本函数只做 IO（stat + createReadStream 分段流）。
 */
async function serveLocalFile(request: Request, url: URL): Promise<Response> {
  const referer = request.headers.get('Referer') ?? '';
  const path = parseResourcePath(url);
  if (!path) {
    return new Response('Bad Request', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }
  // 空 Referer 放行（媒体子资源请求可能不带）；非空须命中可信白名单
  if (referer !== '' && !isTrustedReferer(referer)) {
    log.warn('file-resource denied', { referer });
    return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  }

  let info;
  try {
    info = await stat(path);
  } catch {
    log.warn('file-resource not found', { path });
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  if (!info.isFile()) {
    log.warn('file-resource not a file', { path });
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const mimeType = inferMimeType(basename(path));
  const rangeHeader = request.headers.get('Range');
  const plan = planLocalFileResponse(referer, rangeHeader, info.size, mimeType);
  log.info('file-resource serve', {
    path,
    referer,
    range: rangeHeader ?? null,
    status: plan.status,
  });
  const body = plan.streamRange
    ? (createReadStream(path, {
        start: plan.streamRange.start,
        end: plan.streamRange.end,
      }) as unknown as BodyInit)
    : (createReadStream(path) as unknown as BodyInit);
  return new Response(body, { status: plan.status, headers: plan.headers });
}

/**
 * 注册 urchin:// 协议处理器（必须在 app ready 之后调用）。
 *
 * 路由：
 * - urchin://settings → 设置页 HTML（由主窗口 React SettingsPage 渲染，BrowserView 仅占位）
 * - urchin://ai → AI 模块页 HTML（由主窗口 React AiChatView 渲染，BrowserView 仅占位）
 * - urchin://panel → 收藏夹悬浮面板 HTML（独立子窗口加载，preload 在 urchin: 协议下暴露 API）
 * - urchin://file-viewer → 本地文件查看器占位 HTML（由主窗口 React FileViewer 渲染，
 *   文件路径经 ?path= 参数传入，BrowserView 仅占位）
 * - urchin://file-resource → 本地文件资源转发（FileViewer 内嵌媒体/PDF/图片加载）
 * - urchin://zoom / urchin://zoom-main → Ctrl+滚轮缩放信号（页面注入脚本 fetch，
 *   主进程按方向调整 zoomFactor；zoom 作用于网页 tab、zoom-main 作用于主窗口内部页）
 * - urchin://newtab → 空白页（占位，v0.1 返回简单 HTML）
 * - 其他 → 404
 *
 * 设计理由（阶段2 解耦决策）：
 * settings 和 ai 都作为「React 渲染的内部页面」，BrowserView 加载空白 HTML 仅作为占位，
 * 实际 UI 由主窗口 React 组件覆盖渲染。这样：
 * 1. 不需要在 BrowserView 中注入 preload（避免沙箱问题）
 * 2. AI 模块作为独立标签页存在，与浏览器核心 UI 解耦
 * 3. 设置页与 AI 页共享同一渲染机制，便于统一管理
 *
 * @param opts.onZoom 缩放信号回调：页面 Ctrl+滚轮注入脚本 fetch 触发。
 *   target 'tab' = 网页 BrowserView 缩放、'main' = 主窗口内部页缩放。
 */
export function registerUrchinProtocol(opts?: {
  onZoom?: (direction: 'in' | 'out', target: 'tab' | 'main') => void;
}): void {
  const handleZoom = (request: Request, target: 'tab' | 'main'): Response => {
    const url = new URL(request.url);
    const direction = url.searchParams.get('d');
    if (direction === 'in' || direction === 'out') {
      opts?.onZoom?.(direction, target);
    }
    // 缩放信号请求：无页面需要读取的响应体，返回空 200
    return new Response('', { status: 200 });
  };

  protocol.handle(URCHIN_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;

      if (host === 'zoom' || host === 'zoom-main') {
        return handleZoom(request, host === 'zoom-main' ? 'main' : 'tab');
      }

      if (host === 'settings') {
        // 设置页由主窗口 React 组件渲染（SettingsPage），BrowserView 仅加载空白页面。
        // 这样避免 BrowserView 在无 preload 环境下调用 window.urchin 而报错。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>设置</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'ai') {
        // AI 模块页由主窗口 React 组件渲染（AiChatView），BrowserView 仅加载空白页面。
        // AI 模块作为独立标签页应用，与浏览器核心 UI 解耦。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>AI 助手</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'panel') {
        // 收藏夹悬浮面板（独立子窗口加载）。preload 在 urchin: 协议下暴露
        // window.urchin.invoke，面板内联 JS 通过它拉取书签/历史/下载数据并操作。
        return new Response(getBookmarkPanelHtml(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (host === 'capture-overlay') {
        // 框选截图覆盖窗口（独立透明 BrowserWindow 加载）：背景显示整屏截图 +
        // 拖拽框选 + 取消/确认。preload 在 urchin: 协议下暴露 window.urchin.invoke，
        // 页内通过 screenshot.getImageData / screenshot.confirm / screenshot.cancel 与主进程交互。
        return new Response(getCaptureOverlayHtml(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      if (host === 'file-viewer') {
        // 本地文件查看器由主窗口 React 组件渲染（FileViewer），BrowserView 仅加载空白页面。
        // 文件路径经 URL 的 ?path= 参数传入（encodeURIComponent 编码），由 React 解析。
        // 与 settings/ai 同机制：避免 BrowserView 在无 preload 环境下调用 window.urchin 而报错。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>文件查看</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'file-resource') {
        // 本地文件资源转发：FileViewer 内嵌 <img>/<video>/<audio>/<iframe> 经此加载本地文件。
        // URL 形态：urchin://file-resource/<encodeURIComponent(绝对路径)>
        // - 支持 Range 请求（视频拖动 seek 必需），206 分段返回
        // - 流式返回（createReadStream），大文件不整读进主进程内存
        return serveLocalFile(request, url);
      }

      if (host === 'newtab') {
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>新标签页</title><style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#666;background:#fff}h1{font-weight:300}</style></head><body><h1>Urchin Browser</h1></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    } catch (err) {
      log.error('protocol handler error', { error: String(err) });
      return new Response(`Protocol handler error: ${String(err)}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });
  log.info('urchin protocol handler registered');
}
