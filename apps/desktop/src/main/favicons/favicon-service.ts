/**
 * M2 Tabs · Favicon 缓存服务
 *
 * 职责：
 * 1. 校验页面上报的 favicon 候选地址（仅 http/https/data:image 与内部品牌图标）
 * 2. 使用标签所属 session 拉取图标（工作区分区下仍带登录态）
 * 3. 校验响应体确为受支持的位图格式，限制超时与大小
 * 4. 以源 URL 的 SHA-256 为文件名落盘缓存，供 urchin://favicon/<hash> 协议读取
 *
 * 设计理由（agents.md §七.2 + 安全边界）：
 * - 渲染层直接加载远程 favicon 会落入默认 session，工作区 Cookie 不生效；
 *   主进程按 tab.workspaceId 解析 session，网络请求与标签真实上下文一致。
 * - 缓存 URL 只暴露哈希，不把源站点 URL 写进 DOM / 书签 / 历史。
 * - 只接受位图（PNG/JPEG/GIF/WebP/ICO），拒绝 SVG：远程 SVG 作为顶层文档
 *   打开时可能执行脚本，而 urchin: 是特权协议；宁缺毋滥，避免引入特权域 XSS。
 * - 下载失败/超时/格式错误返回 undefined，由 UI 回退到内置图标或占位图。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@urchin/logger';

const log = createLogger('favicon-service');

/** 单个图标最大字节数（防止恶意站点用超大响应耗尽内存/磁盘）。 */
const MAX_ICON_BYTES = 1024 * 1024;

/** 下载超时（毫秒）：图标属装饰资源，不能拖慢标签加载/历史记录。 */
const FETCH_TIMEOUT_MS = 8000;

/** 缓存有效期：过期后重新拉取，失败时继续使用旧图。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 缓存文件上限：超出后按最久未修改清理，避免无限增长。 */
const MAX_CACHE_FILES = 4096;

/** 每写入多少次检查一次缓存上限（避免每次下载都 readdir）。 */
const PRUNE_EVERY_WRITES = 64;

/** favicon 协议 URL 的 pathname 只接受 64 位小写十六进制哈希。 */
const CACHE_NAME_RE = /^[a-f0-9]{64}$/;

/** 可信内部品牌图标 host：由协议模块自身提供，无需下载/缓存。 */
const INTERNAL_ICON_HOSTS = new Set(['pi-icon', 'dsh-icon']);

/** 页面可上报的候选 URL 最大长度（data:image 可能较长）。 */
const MAX_CANDIDATE_URL_LENGTH = 64 * 1024;

/** 单次事件最多尝试的候选数（恶意页面可声明大量 <link rel=icon>）。 */
const MAX_CANDIDATES = 8;

/** 协议读取结果：响应体 + 嗅探出的 MIME。 */
export interface FaviconResponse {
  readonly data: Uint8Array;
  readonly contentType: string;
}

/** 标签所属 session 的最小 fetch 接口（Electron Session 结构化满足）。 */
export interface FaviconFetchSession {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface FaviconResolveOptions {
  /** 页面 URL，用于解析相对 favicon 地址。 */
  readonly pageUrl: string;
  /** page-favicon-updated 上报的候选（按页面/Chromium 优先级）。 */
  readonly candidates: readonly string[];
  /** 标签所属 session；缺省时使用全局 fetch（无 Cookie，仅测试/兜底）。 */
  readonly session?: FaviconFetchSession;
}

/** 缓存条目元信息。 */
interface CacheEntry {
  readonly filePath: string;
  readonly mtimeMs: number;
}

/**
 * favicon 缓存服务。
 *
 * 构造后缓存目录为 `<dataDir>/favicons`。所有方法均异步，避免同步磁盘 IO
 * 阻塞主进程事件循环；协议读取的同步性由调用方以 Promise 包装。
 */
export class FaviconService {
  private readonly cacheDir: string;

  /** 目录初始化 Promise：下载/读取前等待，避免首次写入与 mkdir 竞态。 */
  private readonly ready: Promise<void>;

  /** 同一源 URL 的并发下载合并为一个 Promise，避免重复网络请求。 */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  /** 写入计数（用于周期性清理超限缓存）。 */
  private writeCount = 0;

  constructor(dataDir: string) {
    this.cacheDir = join(dataDir, 'favicons');
    // 启动时异步建目录并清理一次；失败不阻断浏览器启动（图标只是装饰）。
    this.ready = mkdir(this.cacheDir, { recursive: true })
      .then(() => this.pruneIfNeeded())
      .catch((err: unknown) => {
        log.warn('failed to initialize favicon cache dir', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * 依次尝试候选地址，返回可用的 `urchin://favicon/<hash>`。
   *
   * 成功下载（或命中未过期缓存）即停止；全部失败返回 undefined。
   * 过期缓存下载失败时保留旧图，保证离线/临时故障下图标不闪没。
   */
  async resolve(options: FaviconResolveOptions): Promise<string | undefined> {
    await this.ready;
    const seen = new Set<string>();
    for (const candidate of options.candidates.slice(0, MAX_CANDIDATES)) {
      const normalized = normalizeCandidate(candidate, options.pageUrl);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      // 内部品牌图标直接透传（urchin://pi-icon / dsh-icon 由协议模块服务）。
      if (normalized.startsWith('urchin://')) {
        return normalized;
      }

      const key = hashUrl(normalized);
      const cached = await this.lookup(key);
      if (cached && Date.now() - cached.mtimeMs < CACHE_TTL_MS) {
        return buildFaviconUrl(key);
      }

      const downloaded = await this.downloadAndCache(normalized, key, options.session);
      if (downloaded) return downloaded;
      if (cached) return buildFaviconUrl(key);
    }
    return undefined;
  }

  /**
   * 供 urchin://favicon/<hash> 协议读取缓存文件。
   *
   * 哈希格式不合法、文件不存在或内容不是受支持位图时返回 null（协议层 404）。
   * 每次读取都重新嗅探 MIME，避免缓存目录被外部替换成 HTML 后以图片类型下发。
   */
  async serve(name: string): Promise<FaviconResponse | null> {
    if (!CACHE_NAME_RE.test(name)) return null;
    await this.ready;
    try {
      const data = await readFile(join(this.cacheDir, `${name}.bin`));
      const contentType = sniffImageMime(data);
      if (!contentType) return null;
      return { data, contentType };
    } catch {
      return null;
    }
  }

  /** 查询缓存文件（不存在返回 null）。 */
  private async lookup(key: string): Promise<CacheEntry | null> {
    const filePath = join(this.cacheDir, `${key}.bin`);
    try {
      const info = await stat(filePath);
      return { filePath, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * 下载并原子写盘。
   *
   * 同一 URL 并发调用共享同一 Promise；成功后返回协议 URL。
   */
  private downloadAndCache(
    url: string,
    key: string,
    session: FaviconFetchSession | undefined,
  ): Promise<string | null> {
    const existing = this.inFlight.get(url);
    if (existing) return existing;

    const task = this.download(url, session)
      .then(async (data) => {
        if (!data) return null;
        await this.writeAtomic(key, data);
        return buildFaviconUrl(key);
      })
      .catch((err: unknown) => {
        log.debug('favicon download failed', {
          host: safeHost(url),
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });

    this.inFlight.set(url, task);
    return task;
  }

  /** 执行网络下载并校验大小/格式。 */
  private async download(url: string, session?: FaviconFetchSession): Promise<Uint8Array | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchIcon(url, session, controller.signal);
      if (!response.ok) return null;

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES) return null;

      const data = await readBodyWithCap(response);
      if (!data || data.byteLength === 0) return null;
      if (!sniffImageMime(data)) return null;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 临时文件 + rename 原子替换，避免协议读取到半截文件。 */
  private async writeAtomic(key: string, data: Uint8Array): Promise<void> {
    const target = join(this.cacheDir, `${key}.bin`);
    const tmp = join(this.cacheDir, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      // rename 在 Windows/POSIX 均覆盖已存在目标，且不会出现「先删后写」的空窗。
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }

    this.writeCount += 1;
    if (this.writeCount % PRUNE_EVERY_WRITES === 0) {
      void this.pruneIfNeeded();
    }
  }

  /** 缓存文件超过上限时删除最久未修改的条目。 */
  private async pruneIfNeeded(): Promise<void> {
    try {
      const names = (await readdir(this.cacheDir)).filter((name) => name.endsWith('.bin'));
      if (names.length <= MAX_CACHE_FILES) return;

      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const info = await stat(join(this.cacheDir, name));
            return { name, mtimeMs: info.mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      const valid = entries.filter((entry): entry is { name: string; mtimeMs: number } => !!entry);
      valid.sort((a, b) => a.mtimeMs - b.mtimeMs);

      const removeCount = names.length - MAX_CACHE_FILES;
      await Promise.all(
        valid
          .slice(0, removeCount)
          .map((entry) => rm(join(this.cacheDir, entry.name), { force: true })),
      );
      log.info('favicon cache pruned', { removed: removeCount, kept: MAX_CACHE_FILES });
    } catch (err) {
      // 目录被外部清理（测试/数据目录迁移）不算故障，下次写入前会重新创建。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn('favicon cache prune failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 构造协议 URL。 */
function buildFaviconUrl(key: string): string {
  return `urchin://favicon/${key}`;
}

/** SHA-256 小写十六进制。 */
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * 规范化候选地址：
 * - 相对地址按页面 URL 补全
 * - 仅允许 http/https 与 data:image
 * - 内部品牌图标（pi-icon / dsh-icon）原样保留
 */
function normalizeCandidate(candidate: string, pageUrl: string): string | null {
  const raw = candidate.trim();
  if (!raw || raw.length > MAX_CANDIDATE_URL_LENGTH) return null;

  try {
    const parsed = new URL(raw, pageUrl);
    if (parsed.protocol === 'urchin:') {
      return INTERNAL_ICON_HOSTS.has(parsed.hostname) ? parsed.toString() : null;
    }
    if (parsed.protocol === 'data:') {
      return raw.startsWith('data:image/') ? parsed.toString() : null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // fragment 不影响资源内容，去掉以提高缓存命中。
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** 使用 tab session 拉取；data: 与无 session 时使用全局 fetch。 */
function fetchIcon(
  url: string,
  session: FaviconFetchSession | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const init: RequestInit = {
    method: 'GET',
    signal,
    redirect: 'follow',
    credentials: 'include',
  };
  if (session && !url.startsWith('data:')) {
    return session.fetch(url, init);
  }
  return fetch(url, init);
}

/**
 * 带上限读取响应体。
 *
 * 优先流式累计，避免无 content-length 的超大响应被一次性读入内存；
 * 响应无 body 时回退 arrayBuffer（data: URL 常见）。
 */
async function readBodyWithCap(response: Response): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength <= MAX_ICON_BYTES ? new Uint8Array(buffer) : null;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!chunk || chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (total > MAX_ICON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 通过魔数嗅探图片类型。
 *
 * 不信任响应头 Content-Type；只接受常见位图。SVG 被显式排除（见文件头注释）。
 */
export function sniffImageMime(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    data.length >= 4 &&
    data[0] === 0x00 &&
    data[1] === 0x00 &&
    data[2] === 0x01 &&
    data[3] === 0x00
  ) {
    return 'image/x-icon';
  }
  return null;
}

/** 日志只记录 host，避免把带 token 的图标 URL 写入日志。 */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}
