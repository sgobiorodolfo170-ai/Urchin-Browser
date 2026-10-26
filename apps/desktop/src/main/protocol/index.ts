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
import type { CustomScheme, Session } from 'electron';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app } from 'electron';
import { createLogger } from '@urchin/logger';
import { getBookmarkPanelHtml } from '../panel/bookmark-panel';
import { getCaptureOverlayHtml } from '../screenshots/capture-overlay-html';
import { inferMimeType } from '../files/file-kind';

import { buildUiStateResponse, UI_STATE_HOST } from '../pi-web/ui-state';
import type { FaviconResponse } from '../favicons/favicon-service';

const log = createLogger('urchin-protocol');

/** urchin:// 协议的 scheme 名（不含冒号） */
export const URCHIN_SCHEME = 'urchin';

/**
 * 注册 urchin: 为特权协议（必须在 app ready 之前调用）。
 *
 * 特权：标准、支持 fetch、Bypass CSP、secure、允许 service workers。
 *
 * 阶段 2：GenOffice 编辑器渲染页需要 genoffice-app: 等自定义 scheme 特权，
 * 而 Electron 的 registerSchemesAsPrivileged 每个进程只允许调用一次——
 * 由调用方把 GenOffice 的特权列表经 extraSchemes 并入本单次调用。
 */
export function registerUrchinSchemePrivileged(extraSchemes: readonly CustomScheme[] = []): void {
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
    ...extraSchemes,
  ]);
  log.info('urchin scheme registered as privileged', {
    extraSchemes: extraSchemes.map((s) => s.scheme),
  });
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
 * 安全（AGENTS.md §六 隐私）：
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
 * - urchin://favicon/<hash> → 主进程缓存的网站图标（标签栏/书签/历史共用）
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
 * @param targetSession 可选：注册到指定 Session（TP7 自定义工作区分区 session）。
 *   缺省时注册到全局协议栈（影响默认 session）。
 */
export function registerUrchinProtocol(
  opts?: {
    onZoom?: (direction: 'in' | 'out', target: 'tab' | 'main') => void;
    /** pi 页目录选择回调（dev.44）：弹原生目录选择器，返回所选路径或 null（取消） */
    onPickDirectory?: () => Promise<string | null>;
    /** pi 品牌图标 PNG 绝对路径（dev.45，dist/renderer/pi-icon.png；缺省 404） */
    piIconPath?: string;
    /** dsh 品牌图标 SVG 绝对路径（dist/renderer/dsh-icon.svg；缺省 404） */
    dshIconPath?: string;
    /** 浏览器当前主题是否暗色（dev.48：pi 页主题跟随浏览器，主进程读 nativeTheme） */
    isBrowserDarkTheme?: () => boolean;
    /** pi 页 UI 状态文件路径（dev.67：urchin://pi-ui-state 读写端点落盘位置） */
    piUiStateFile?: string;
    /** M25 邮箱正文内容查询（urchin://mail-content/<token> → 已 sanitize 的 HTML） */
    getMailContent?: (token: string) => string | null;
    /** favicon 缓存读取（urchin://favicon/<hash> → 位图字节；缺失返回 null） */
    getFavicon?: (name: string) => Promise<FaviconResponse | null>;
  },
  targetSession?: Session,
): void {
  /**
   * pi 页主题跟随端点（pi-theme host，dev.48）：返回浏览器当前主题
   * {dark:boolean}。pi 页注入脚本轮询此端点并驱动 pi 主题切换
   * （亮=white.css 浅色主题，暗=移除样式表回默认；dev.84 适配 0.90.0
   * 主题引擎重构）。只读、无副作用。
   */
  const handlePiTheme = (): Response => {
    const dark = opts?.isBrowserDarkTheme?.() ?? false;
    return new Response(JSON.stringify({ dark }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  };

  /**
   * 服务 pi 品牌图标（pi-icon host）：首读后缓存（favicon 请求频繁）。
   * 未配置/文件缺失返回 404——调用方（favicon 重定向）将显示原图标回退。
   */
  let piIconCache: Buffer | null | undefined;
  const servePiIcon = (iconPath: string | undefined): Response => {
    if (piIconCache === undefined) {
      try {
        piIconCache = iconPath ? readFileSync(iconPath) : null;
      } catch {
        piIconCache = null;
      }
    }
    if (!piIconCache) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response(new Uint8Array(piIconCache), {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' },
    });
  };

  let dshIconCache: Buffer | null | undefined;
  const serveDshIcon = (iconPath: string | undefined): Response => {
    if (dshIconCache === undefined) {
      try {
        dshIconCache = iconPath ? readFileSync(iconPath) : null;
      } catch {
        dshIconCache = null;
      }
    }
    if (!dshIconCache) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response(new Uint8Array(dshIconCache), {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' },
    });
  };

  const handleZoom = (request: Request, target: 'tab' | 'main'): Response => {
    const url = new URL(request.url);
    const direction = url.searchParams.get('d');
    if (direction === 'in' || direction === 'out') {
      opts?.onZoom?.(direction, target);
    }
    // 缩放信号请求：无页面需要读取的响应体，返回空 200
    return new Response('', { status: 200 });
  };

  const handler = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;

      if (host === 'zoom' || host === 'zoom-main') {
        return handleZoom(request, host === 'zoom-main' ? 'main' : 'tab');
      }

      if (host === 'pi-icon') {
        // pi 模块品牌图标 PNG（dev.45）：favicon 网络重定向的目标——pi 网页
        // 标签/历史/主页的 favicon 请求（127.0.0.1:<pi端口>/favicon.svg）被
        // webRequest 重定向到此，统一显示与左侧栏入口一致的 π 图标。
        return servePiIcon(opts?.piIconPath);
      }

      if (host === 'dsh-icon') {
        // dsh 模块品牌图标 SVG：favicon 重定向目标——dsh 网页标签的
        // favicon 请求被 webRequest 重定向到此，统一显示与左侧栏入口一致的图标。
        return serveDshIcon(opts?.dshIconPath);
      }

      if (host === 'favicon') {
        // 主进程缓存图标（M2）：标签栏/书签/历史统一经此读取，
        // 渲染层不直接请求远程站点，避免工作区 Cookie 丢失与隐私泄露。
        const name = url.pathname.replace(/^\//, '');
        const favicon = name ? await opts?.getFavicon?.(name) : null;
        if (!favicon) {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return new Response(new Uint8Array(favicon.data), {
          status: 200,
          headers: {
            'Content-Type': favicon.contentType,
            // 哈希由源 URL 决定；图标内容可能更新，缓存 1 小时平衡刷新与开销。
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            // 即使被直接导航为文档，也禁止脚本执行（防御纵深；SVG 已在服务层拒绝）。
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          },
        });
      }

      if (host === 'pi-theme') {
        // pi 页主题跟随浏览器（dev.48）：注入脚本轮询读取 {dark}
        return handlePiTheme();
      }

      if (host === UI_STATE_HOST) {
        // pi 页 UI 状态持久化（dev.67）：分割线宽度/折叠状态/项目排序——
        // pi 服务端口随机致页面 localStorage 不可跨会话，经主进程落盘。
        // 文件未配置时返回 404（读端点），注入脚本回退默认值。
        const file = opts?.piUiStateFile;
        if (!file) {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return buildUiStateResponse(request.headers.get('Referer') ?? '', request.url, file);
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

      if (host === 'mail') {
        // M25 邮箱模块页由主窗口 React 组件渲染（MailView），BrowserView 仅加载空白页面。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>邮箱</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }

      if (host === 'mail-content') {
        // M25 邮件正文渲染文档：独立 CSP 下发——default-src 'none' 阻断脚本/连接，
        // 仅放行图片/样式/字体/媒体（http/https/data），与主窗口 CSP 解耦（主窗口不放宽）。
        // 内容由 mail-html.ts sanitize + cid 重写预处理，渲染侧 iframe sandbox 兜底。
        // token 为 UUID 一次性映射（MailContentStore 内存态，TTL 10min），不可枚举。
        const token = url.pathname.replace(/^\//, '');
        const html = token ? opts?.getMailContent?.(token) : null;
        log.info('mail-content request', { token, hit: html != null });
        if (html == null) {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline' http: https:; font-src http: https: data:; media-src http: https: data:",
          },
        });
      }

      if (host === 'app-icon') {
        // 应用主图标（build/icon.png），供悬浮球等 UI 加载。
        const iconPath = join(app.getAppPath(), 'build', 'icon.png');
        try {
          const data = readFileSync(iconPath);
          return new Response(data, {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
          });
        } catch (err) {
          log.warn('app-icon read failed', { error: String(err) });
          return new Response('icon not found', { status: 404 });
        }
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

      if (host === 'genoffice-home') {
        // GenOffice 文档主页由主窗口 React 组件渲染（GenOfficeHome），
        // BrowserView 仅加载空白页面（与 settings/ai/file-viewer 同机制）。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>GenOffice 文档</title></head><body></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
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

      if (host === 'workspaces') {
        // 工作区总览页由主窗口 React 组件渲染（WorkspaceOverviewPage），
        // BrowserView 仅加载空白页面（与 settings/newtab/file-viewer 同机制，
        // 避免无 preload 环境下调用 window.urchin 而报错）。
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>工作区</title></head><body></body></html>',
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
  };

  if (targetSession) {
    // TP7：自定义工作区持久化分区 session 也需可访问 urchin:// 内部页
    //（settings/ai/newtab/file-viewer 等 React 覆盖渲染占位页 + 本地资源转发）
    targetSession.protocol.handle(URCHIN_SCHEME, handler);
  } else {
    protocol.handle(URCHIN_SCHEME, handler);
  }
  log.info('urchin protocol handler registered');
}
