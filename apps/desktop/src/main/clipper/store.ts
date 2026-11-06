/**
 * M26 剪藏 · 落盘与文件名管理
 *
 * 职责：
 * 1. 把所有剪藏文件写入剪藏目录：默认 <数据目录>/documents/clipper，
 *    可经设置 clipper.saveDir 自定义（2026-11-06 用户需求；空/非绝对路径
 *    回退默认）。每次落盘动态解析，设置改后立即生效。
 * 2. 文件名净化、扩展名归一、重名追加 (2)/(3)，避免覆盖既有文件。
 * 3. 只接受主进程计算出的绝对路径，渲染层无法传入任意目录。
 *
 * 设计理由（AGENTS.md §一 上下文边界 + §三 IPC 契约）：
 * - 路径拼接与写盘全部留在主进程，面板只传标题/内容。
 * - fs 操作依赖注入，便于单测在临时目录验证，不触碰真实用户数据。
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

/** 剪藏支持的扩展名（md 由 Markdown 保存；其余为快照格式） */
export type ClipperExtension = 'md' | 'mhtml' | 'pdf' | 'png';

/** 剪藏目录名（相对 documents 根） */
export const CLIPPER_DIR_NAME = 'clipper';

/**
 * 解析「剪藏保存路径」设置值（clipper.saveDir）：
 * 空 / 非绝对路径视为未设置，回退默认目录。
 *
 * store 的 clipDir getter 与 clipper.config 的 saveDirLabel 共用本函数，
 * 保证「实际落盘目录」与「面板展示」不漂移。
 */
export function resolveClipDirSetting(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !isAbsolute(trimmed)) return fallback;
  // resolve 归一化分隔符与 ..（设置值来自目录选择器/手输，不做信任假设）
  return resolve(trimmed);
}

/** Windows 非法文件名字符（含控制字符） */
// eslint-disable-next-line no-control-regex -- 文件名净化必须剔除控制字符
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** 已知剪藏扩展名：标题里带这些后缀时不重复追加 */
const KNOWN_EXTENSIONS = /\.(md|markdown|mhtml|mht|pdf|png)$/i;

/**
 * 文件名净化（不含扩展名）：
 * - 非法字符 → 下划线
 * - 去掉首尾空白与 Windows 不允许的结尾点
 * - 限长 100（按 UTF-16 code unit；中文标题足够）
 * - 空名回退 untitled
 */
export function sanitizeClipName(name: string): string {
  const stripped = name.replace(KNOWN_EXTENSIONS, '').replace(ILLEGAL_FILENAME_CHARS, '_').trim();
  const cleaned = stripped.replace(/[. ]+$/g, '');
  if (cleaned.length === 0) return 'untitled';
  return cleaned.slice(0, 100);
}

/** 路径是否已存在（目录/文件都算占用） */
export type ExistsFn = (path: string) => Promise<boolean>;

/** 默认存在性检查：stat 成功即存在，ENOENT 视为不存在 */
async function defaultExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 生成唯一路径：name.ext → name (2).ext → name (3).ext … */
export async function uniqueClipPath(
  dir: string,
  name: string,
  ext: ClipperExtension,
  exists: ExistsFn = defaultExists,
): Promise<string> {
  const base = sanitizeClipName(name);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = join(dir, index === 1 ? `${base}.${ext}` : `${base} (${index}).${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  // 极端情况：用时间戳兜底，避免死循环
  return join(dir, `${base}-${Date.now()}.${ext}`);
}

/** 存储依赖（fs 可注入，便于单测） */
export interface ClipperStoreDeps {
  /** 用户数据目录（<数据目录>/documents/clipper 的父级 documents 根） */
  readonly documentsRoot: string;
  /**
   * 自定义剪藏目录读取器（设置 clipper.saveDir，主进程注入 SettingsManager 读取）。
   * 每次落盘调用，设置改后立即生效；空/非绝对路径由 resolveClipDirSetting 回退默认。
   */
  readonly customDir?: () => string;
  readonly mkdir?: typeof mkdir;
  readonly readdir?: typeof readdir;
  readonly writeFile?: typeof writeFile;
  readonly exists?: ExistsFn;
}

/**
 * 子目录名净化（防路径穿越）：
 * - 路径分隔符 → 下划线（禁止子目录嵌套）
 * - 控制字符 / 非法字符 → 下划线
 * - 空名 / "." / ".." → 返回空（= 根目录）
 */
export function sanitizeSubDirName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned.slice(0, 100);
}

/**
 * 剪藏存储：默认/自定义目录 + 唯一文件名 + 可选子目录。
 *
 * 不提供"任意路径写入"能力——自定义目录仅来自设置页保存的 clipper.saveDir
 * （经 resolveClipDirSetting 校验为绝对路径），渲染层无法指定；MHTML/PDF/截图
 * 由导出器拿到 reservePath 返回的绝对路径后自行写盘。子目录名经
 * sanitizeSubDirName 净化后拼接到 clipDir 下。
 */
export class ClipperStore {
  /** 默认剪藏目录（设置未自定义时的落盘位置） */
  readonly defaultClipDir: string;
  private readonly customDirFn?: () => string;
  private readonly mkdirFn: typeof mkdir;
  private readonly readdirFn: typeof readdir;
  private readonly writeFileFn: typeof writeFile;
  private readonly existsFn: ExistsFn;

  constructor(deps: ClipperStoreDeps) {
    this.defaultClipDir = join(deps.documentsRoot, CLIPPER_DIR_NAME);
    this.customDirFn = deps.customDir;
    this.mkdirFn = deps.mkdir ?? mkdir;
    this.readdirFn = deps.readdir ?? readdir;
    this.writeFileFn = deps.writeFile ?? writeFile;
    this.existsFn = deps.exists ?? defaultExists;
  }

  /** 当前生效的剪藏目录（动态解析：设置改后立即生效，无需重启） */
  get clipDir(): string {
    if (!this.customDirFn) return this.defaultClipDir;
    return resolveClipDirSetting(this.customDirFn(), this.defaultClipDir);
  }

  /** 确保剪藏目录存在（幂等） */
  async ensureDir(): Promise<void> {
    await this.mkdirFn(this.clipDir, { recursive: true });
  }

  /** 解析子目录为绝对路径（空名 = 根目录） */
  resolveSubDir(subDir?: string): string {
    const cleaned = subDir ? sanitizeSubDirName(subDir) : '';
    if (!cleaned) return this.clipDir;
    return join(this.clipDir, cleaned);
  }

  /** 列出 clipper 目录下的子文件夹名（排序） */
  async listSubDirs(): Promise<string[]> {
    try {
      const entries = await this.readdirFn(this.clipDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** 预留一个唯一绝对路径（不创建文件）；subDir 可选指定子目录 */
  async reservePath(noteName: string, ext: ClipperExtension, subDir?: string): Promise<string> {
    const dir = this.resolveSubDir(subDir);
    await this.mkdirFn(dir, { recursive: true });
    return uniqueClipPath(dir, noteName, ext, this.existsFn);
  }

  /** 保存 Markdown 文本，返回最终绝对路径；subDir 可选指定子目录 */
  async saveMarkdown(noteName: string, markdown: string, subDir?: string): Promise<string> {
    const path = await this.reservePath(noteName, 'md', subDir);
    await this.writeFileFn(path, markdown, 'utf-8');
    return path;
  }

  /**
   * 写 Markdown 文本到已预留的路径（CL11 图片本地化用）。
   *
   * 图片本地化流程需要先 reservePath 拿到路径（供 writeImageIntoOwnedAssets
   * 定位 assets/ 目录），图片下载落盘后再写 md 文件。本方法避免重复 reserve。
   */
  async writeMarkdownTo(path: string, markdown: string): Promise<void> {
    await this.writeFileFn(path, markdown, 'utf-8');
  }
}
