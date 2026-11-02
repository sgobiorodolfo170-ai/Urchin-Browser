/**
 * M26 剪藏 · 图片本地化（CL11）
 *
 * 职责：
 * 1. 扫描 markdown 中的远程图片 URL（http/https）
 * 2. 并发下载（SSRF 防护 + browser headers + Referer + 重试 + 50MB 限速）
 * 3. 通过 GenOffice 的 writeImageIntoOwnedAssets 落盘 + 注册 manifest
 * 4. 重写 md 中的 ![](远程URL) → ![](assets/<name>)
 * 5. 通过 reconcileOwnedAssets 完成 pending → documents + GC
 * 6. 下载失败保留原远程 URL + 记 warning
 *
 * 设计理由（AGENTS.md §六 跨进程边界 + §三 IPC 契约）：
 * - 下载在主进程执行（渲染进程受 CORS 限制无法 fetch 跨域图片）
 * - 复用 GenOffice 的 asset-lifecycle，manifest 格式 / sanitize / sha256 / lock 全部复用
 * - GenOffice 打开剪藏 md 时自动识别 assets/ 图片（md-asset:// 协议 + assetsDirFor 约定）
 * - 删除 md 时 GenOffice Home 的 deleteFiles handler 调 reconcileOwnedAssets(path, []) 自动 GC
 */
import type { GenOfficeEmbedApi } from '../genoffice/loader';

/** 单张图片下载大小上限（与 GenOffice 粘贴 / 远程下载上限一致） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** 瞬态失败重试延迟（借鉴 vendor electron-utils/remote-image.ts） */
const RETRY_DELAYS_MS: readonly number[] = [500, 1500];

/** 并发下载上限 */
const DEFAULT_CONCURRENCY = 4;

/** 可注入的 fetch 类型（单测 mock） */
export type FetchImpl = typeof fetch;

export interface LocalizeOptions {
  /** 源页面 URL（用于 Referer 防盗链） */
  readonly pageUrl: string;
  /** md 文件最终路径（用于 writeImageIntoOwnedAssets + reconcileOwnedAssets） */
  readonly documentPath: string;
  /** Asset-lifecycle API 子集（null 时图片本地化跳过） */
  readonly assetApi: AssetLifecycleApi | null;
  /** 可注入 fetch（单测 mock；默认全局 fetch） */
  readonly fetchImpl?: FetchImpl;
  /** 并发下载数（默认 4） */
  readonly concurrency?: number;
}

export interface LocalizeResult {
  /** 重写后的 markdown（失败的图片保留原远程 URL） */
  readonly markdown: string;
  /** 非致命警告（如「3 张图片下载失败，已保留原链接」） */
  readonly warnings: readonly string[];
}

/**
 * 判断 hostname 是否为内网地址（SSRF 防护）。
 * 拒绝 localhost / 0.0.0.0 / 10.x / 172.16-31.x / 192.168.x / ::1 / fc/fd / fe80。
 */
function isSsrfBlocked(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '[::1]') return true;
  // IPv4
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  // IPv6 ULA / link-local
  if (hostname === '::1') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  if (hostname.startsWith('fe80')) return true;
  return false;
}

/** 从 URL 提取合理的图片文件名（去 query、取 basename、无扩展名时默认 .png） */
function imageFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const base = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || 'image';
    if (!/\.[a-z0-9]{1,10}$/i.test(base)) return `${base}.png`;
    return base;
  } catch {
    return 'image.png';
  }
}

/** 流式读取 response body，超 maxBytes 时取消并返回 null */
async function readBodyCapped(resp: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = resp.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    await resp.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!resp.body) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return Buffer.from(chunks[0]!);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(out);
}

/**
 * 下载单张图片。
 * - SSRF 防护：内网地址直接拒绝
 * - 防盗链：Referer 设为源页面 URL
 * - 重试：瞬态失败（网络错误 / 403 / 408 / 429 / 5xx）重试 500ms / 1500ms
 * - 大小上限：50MB（Content-Length 预检 + 流式计数）
 * 返回 null 表示下载失败（调用方保留原 URL）
 */
async function downloadImage(
  url: string,
  pageUrl: string,
  fetchImpl: FetchImpl,
): Promise<Buffer | null> {
  if (isSsrfBlocked(url)) return null;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5',
  };
  try {
    headers.Referer = new URL(pageUrl).origin + '/';
  } catch {
    // pageUrl 无效时不设 Referer
  }
  for (let attempt = 0; ; attempt++) {
    let resp: Response | null = null;
    let threw = false;
    try {
      resp = await fetchImpl(url, { headers, redirect: 'follow' });
    } catch {
      threw = true;
    }
    if (resp?.ok) {
      return readBodyCapped(resp, MAX_IMAGE_BYTES);
    }
    const transient =
      threw ||
      (resp !== null &&
        (resp.status === 403 || resp.status === 408 || resp.status === 429 || resp.status >= 500));
    const delay = RETRY_DELAYS_MS[attempt];
    if (!transient || delay === undefined) return null;
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** 匹配 markdown 图片语法 ![alt](http...) 的正则（含可选 title） */
const REMOTE_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;

/** 提取 markdown 中所有远程图片 URL（去重） */
export function extractRemoteImageUrls(markdown: string): string[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  REMOTE_IMAGE_RE.lastIndex = 0;
  while ((match = REMOTE_IMAGE_RE.exec(markdown)) !== null) {
    urls.add(match[2]!);
  }
  return [...urls];
}

/** 用 URL→localPath 映射重写 markdown 中的图片路径（失败的保留原 URL） */
function rewriteImageSources(markdown: string, mapping: Map<string, string>): string {
  REMOTE_IMAGE_RE.lastIndex = 0;
  return markdown.replace(REMOTE_IMAGE_RE, (full, alt: string, url: string) => {
    const local = mapping.get(url);
    if (local) return `![${alt}](${local})`;
    return full;
  });
}

/** 简单并发池：限制并发数执行异步任务 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Asset-lifecycle API 子集（CL11 图片本地化所需的最小接口）。
 * 从 GenOfficeEmbedApi 中提取三个 asset-lifecycle 方法；
 * 旧版产物可能缺失，用 getAssetLifecycleApi 判空。
 */
export interface AssetLifecycleApi {
  writeImageIntoOwnedAssets(
    documentPath: string,
    preferredName: string,
    bytes: Buffer,
  ): Promise<string>;
  reconcileOwnedAssets(documentPath: string, imageSources: readonly string[]): Promise<unknown>;
  extractMarkdownImageSources(markdown: string): string[];
}

/**
 * 从 embedApi 中提取 asset-lifecycle API 子集。
 * 返回 null 表示不可用（加载失败/旧版产物/缺方法）——图片本地化跳过。
 */
export function getAssetLifecycleApi(embedApi: GenOfficeEmbedApi | null): AssetLifecycleApi | null {
  if (!embedApi) return null;
  if (typeof embedApi.writeImageIntoOwnedAssets !== 'function') return null;
  if (typeof embedApi.reconcileOwnedAssets !== 'function') return null;
  if (typeof embedApi.extractMarkdownImageSources !== 'function') return null;
  return embedApi as unknown as AssetLifecycleApi;
}

/**
 * 图片本地化主入口。
 *
 * 流程：
 * 1. embedApi 不可用 → 原样返回（图片本地化不可用）
 * 2. 提取远程图片 URL → 去重
 * 3. 并发下载 → writeImageIntoOwnedAssets 落盘 + 注册 manifest pending
 * 4. 重写 md 中的图片路径为 assets/<name>
 * 5. reconcileOwnedAssets：pending → documents + GC 无引用文件
 * 6. 失败的图片保留原 URL + warning
 */
export async function localizeMarkdownImages(
  markdown: string,
  options: LocalizeOptions,
): Promise<LocalizeResult> {
  const {
    pageUrl,
    documentPath,
    assetApi,
    fetchImpl = fetch,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  if (!assetApi) {
    return { markdown, warnings: [] };
  }

  const urls = extractRemoteImageUrls(markdown);
  if (urls.length === 0) {
    return { markdown, warnings: [] };
  }

  const mapping = new Map<string, string>();
  const warnings: string[] = [];
  let failedCount = 0;

  await mapWithConcurrency(urls, concurrency, async (url) => {
    const bytes = await downloadImage(url, pageUrl, fetchImpl);
    if (!bytes) {
      failedCount++;
      return;
    }
    const preferredName = imageFilenameFromUrl(url);
    try {
      const rel = await assetApi.writeImageIntoOwnedAssets(documentPath, preferredName, bytes);
      mapping.set(url, rel);
    } catch {
      failedCount++;
    }
  });

  if (failedCount > 0) {
    warnings.push(`${failedCount} 张图片下载失败，已保留原链接`);
  }

  const rewritten = rewriteImageSources(markdown, mapping);

  // reconcile：把 pending 转为 documents + GC 不再被引用的 owned 文件。
  // 用重写后 md 的 imageSources（含本地化后的 assets/ 路径 + 保留的远程 URL）。
  // 失败时静默——图片已在 assets/ 中，只是 manifest 可能不完整（不影响显示）。
  try {
    const imageSources = assetApi.extractMarkdownImageSources(rewritten);
    await assetApi.reconcileOwnedAssets(documentPath, imageSources);
  } catch {
    // reconcile 失败不阻断保存——manifest 不完整时 GenOffice 仍能显示图片
  }

  return { markdown: rewritten, warnings };
}
