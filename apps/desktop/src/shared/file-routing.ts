/**
 * 本地文件打开路由（单一真源，主进程与渲染层共用）
 *
 * 依据：[ADR-021](../docs/decisions/ADR-021-打开文件职责划分.md)（FA4-FA8）
 *
 * 职责：把「文件类型 + 打开来源」映射为「渲染通道」，并给出各通道的标签 URL。
 * 为什么放在 shared：此前主进程 `main/index.ts` 与渲染层 `renderer/App.tsx`
 * 各维护一份 kind→通道映射，靠人工同步；新增格式时漏改一处就会出现
 * 「同一个文件从侧栏打开进查看器、从文件关联打开进编辑器」的漂移。
 *
 * 分界线是**入口**而不是格式（ADR-021 FA4）：
 * - `external`：Windows 文件关联 / 命令行 %1 / Ctrl+O / 拖放 → 浏览器通道；
 *   **唯一例外**是 Office 三类（docx/pptx/xlsx）直进 GenOffice。
 * - `genoffice`：GenOffice 主页（文档目录 / 最近 / 收藏 / 打开本地文件）→
 *   GenOffice 通道；GenOffice 打不开的格式转交浏览器通道。
 */
import type { FileKind } from '@urchin/ipc-contract';

/** GenOffice 编辑器 app（与 main/genoffice/paths.ts 的 GENOFFICE_KINDS 对齐）。 */
export type GenOfficeAppKind = 'markdown' | 'pdf' | 'html' | 'docs' | 'slides' | 'sheets';

/** 打开请求来源。 */
export type OpenOrigin = 'external' | 'genoffice';

/** 路由目标通道。 */
export type OpenTarget =
  /** 浏览器内置查看器（urchin://file-viewer，React 渲染：媒体/图片/PDF/文本/目录）。 */
  | { readonly channel: 'viewer' }
  /** 普通网页标签（file:// 直开；html 专用——经查看器内嵌 iframe 时相对资源解析有问题）。 */
  | { readonly channel: 'browser' }
  /** MHTML 只读查看器（禁用 JS、无 preload，由 clipper 的 createMhtmlView 承载）。 */
  | { readonly channel: 'mhtml' }
  /** GenOffice 编辑器视图（genoffice-app:// 协议 + vendor preload）。 */
  | { readonly channel: 'genoffice'; readonly app: GenOfficeAppKind };

/**
 * GenOffice 可编辑/可打开的扩展名 → 编辑器（能力表，单一真源）。
 *
 * 两个消费点（ADR-021 FA6）：
 * 1. `origin='genoffice'`：命中即进 GenOffice，未命中转交浏览器通道；
 * 2. 最近打开（recents）：命中才记入 `genoffice-home.json`。
 *
 * 为后续留空间：GenOffice 上线图片/音视频等新编辑器时，**只在本表追加一行**
 * （如 `['mp4', 'video']`），路由与 recents 同时生效，不需要再改第二处。
 *
 * 为什么不用 kind 判定：`kind='text'` 同时覆盖 `.txt/.json/.csv`（该入 recents）
 * 与 `.js/.sh/.ps1/.css` 等脚本配置类（不该入）——粒度太粗，必须按扩展名。
 * 当前批次不含 `.doc/.xls/.ppt` 等旧二进制格式：GenOffice 帮助页声称支持，
 * 但 Urchin 的分类表未收录、也未实测，先不声明能力（登记为后续待评估项）。
 */
export const GENOFFICE_EDITABLE_EXTENSIONS: ReadonlyMap<string, GenOfficeAppKind> = new Map([
  ['docx', 'docs'],
  ['xlsx', 'sheets'],
  ['xlsm', 'sheets'],
  ['csv', 'sheets'],
  ['tsv', 'sheets'],
  ['pptx', 'slides'],
  ['pdf', 'pdf'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['txt', 'markdown'],
  ['json', 'markdown'],
  ['html', 'html'],
  ['htm', 'html'],
]);

/**
 * 外部入口直进 GenOffice 的类型（唯一例外）。
 *
 * 刻意保持窄：ADR-021 的规则是「外部入口归浏览器」。GenOffice 将来若新增
 * 图片/音视频编辑器，是否把对应 kind 加进来需要**另行决策**（默认仍走浏览器
 * 阅读通道），不要因为能力表加了扩展名就自动扩大这个集合。
 */
export const EXTERNAL_GENOFFICE_KINDS: ReadonlySet<FileKind> = new Set(['docx', 'pptx', 'xlsx']);

/** kind → GenOffice 编辑器的兜底映射（扩展名不在能力表时按 kind 兜底）。 */
const KIND_TO_GENOFFICE_APP: Readonly<Partial<Record<FileKind, GenOfficeAppKind>>> = {
  docx: 'docs',
  pptx: 'slides',
  xlsx: 'sheets',
};

/**
 * 取文件名的扩展名（小写、不含点）。
 *
 * @param nameOrPath 文件名或绝对路径
 * @returns 扩展名；无扩展名（`README`）或以点开头的整名（`.gitignore`）返回空串
 */
export function extOf(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? nameOrPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** 该文件 GenOffice 是否能编辑（决定 recents 是否记入、内部入口是否直进）。 */
export function isGenOfficeEditable(nameOrPath: string): boolean {
  return GENOFFICE_EDITABLE_EXTENSIONS.has(extOf(nameOrPath));
}

/**
 * 解析打开目标通道（路由单一真源）。
 *
 * @param kind 文件类型分类（`classifyFileKind`）
 * @param nameOrPath 文件名或绝对路径（用于扩展名能力判定）
 * @param origin 打开来源（external = 外部入口，genoffice = GenOffice 主页）
 */
export function resolveOpenTarget(
  kind: FileKind,
  nameOrPath: string,
  origin: OpenOrigin,
): OpenTarget {
  const ext = extOf(nameOrPath);

  if (origin === 'genoffice') {
    const app = GENOFFICE_EDITABLE_EXTENSIONS.get(ext);
    if (app) return { channel: 'genoffice', app };
    // GenOffice 打不开（图片/音视频/二进制/脚本等）→ 转交浏览器通道
    return { channel: 'viewer' };
  }

  // 外部入口
  if (kind === 'mhtml') return { channel: 'mhtml' };
  if (kind === 'html') return { channel: 'browser' };
  if (EXTERNAL_GENOFFICE_KINDS.has(kind)) {
    const app = GENOFFICE_EDITABLE_EXTENSIONS.get(ext) ?? KIND_TO_GENOFFICE_APP[kind];
    if (app) return { channel: 'genoffice', app };
  }
  return { channel: 'viewer' };
}

/** 构造内置查看器标签地址（`?path=` 形态）。 */
export function buildFileViewerUrl(filePath: string): string {
  return `urchin://file-viewer/?path=${encodeURIComponent(filePath)}`;
}

/** 构造内置查看器目录浏览地址（`?dir=` 形态）。 */
export function buildDirViewerUrl(dirPath: string): string {
  return `urchin://file-viewer/?dir=${encodeURIComponent(dirPath)}`;
}

/** 构造 GenOffice 编辑器标签伪地址（标签标识 + 主进程分流用）。 */
export function buildGenOfficeUrl(app: string, filePath: string): string {
  return `urchin://genoffice/?kind=${encodeURIComponent(app)}&path=${encodeURIComponent(filePath)}`;
}
