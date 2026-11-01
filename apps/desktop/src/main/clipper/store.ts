/**
 * M26 剪藏 · 落盘与文件名管理
 *
 * 职责：
 * 1. 把所有剪藏文件固定写入 <数据目录>/documents/clipper（用户要求）。
 * 2. 文件名净化、扩展名归一、重名追加 (2)/(3)，避免覆盖既有文件。
 * 3. 只接受主进程计算出的绝对路径，渲染层无法传入任意目录。
 *
 * 设计理由（AGENTS.md §一 上下文边界 + §三 IPC 契约）：
 * - 路径拼接与写盘全部留在主进程，面板只传标题/内容。
 * - fs 操作依赖注入，便于单测在临时目录验证，不触碰真实用户数据。
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 剪藏支持的扩展名（md 由 Markdown 保存；其余为快照格式） */
export type ClipperExtension = 'md' | 'mhtml' | 'pdf' | 'png';

/** 剪藏目录名（相对 documents 根） */
export const CLIPPER_DIR_NAME = 'clipper';

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
  readonly mkdir?: typeof mkdir;
  readonly writeFile?: typeof writeFile;
  readonly exists?: ExistsFn;
}

/**
 * 剪藏存储：固定目录 + 唯一文件名。
 *
 * 不提供“任意路径写入”能力；MHTML/PDF/截图由导出器拿到 reservePath 返回的
 * 绝对路径后自行写盘。
 */
export class ClipperStore {
  readonly clipDir: string;
  private readonly mkdirFn: typeof mkdir;
  private readonly writeFileFn: typeof writeFile;
  private readonly existsFn: ExistsFn;

  constructor(deps: ClipperStoreDeps) {
    this.clipDir = join(deps.documentsRoot, CLIPPER_DIR_NAME);
    this.mkdirFn = deps.mkdir ?? mkdir;
    this.writeFileFn = deps.writeFile ?? writeFile;
    this.existsFn = deps.exists ?? defaultExists;
  }

  /** 确保剪藏目录存在（幂等） */
  async ensureDir(): Promise<void> {
    await this.mkdirFn(this.clipDir, { recursive: true });
  }

  /** 预留一个唯一绝对路径（不创建文件） */
  async reservePath(noteName: string, ext: ClipperExtension): Promise<string> {
    await this.ensureDir();
    return uniqueClipPath(this.clipDir, noteName, ext, this.existsFn);
  }

  /** 保存 Markdown 文本，返回最终绝对路径 */
  async saveMarkdown(noteName: string, markdown: string): Promise<string> {
    const path = await this.reservePath(noteName, 'md');
    await this.writeFileFn(path, markdown, 'utf-8');
    return path;
  }
}
