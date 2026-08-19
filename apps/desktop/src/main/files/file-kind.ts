/**
 * 本地文件类型分类（file-kind）
 *
 * 职责：按扩展名把本地文件归类为 kind，决定打开方式：
 * - audio / video / pdf / image / html：Chromium 原生渲染（file:// 直开标签页）
 * - markdown / json / text：主窗口 React 查看器（urchin://file-viewer）读内容渲染
 * - binary：不支持网页预览（提示外部打开）
 *
 * 设计理由（安全优先）：
 * 未知/无扩展名文件一律归 binary，不做文本嗅探——避免二进制内容被当 UTF-8
 * 读入渲染层产生乱码与潜在渲染问题；用户可改扩展名或在外部程序中打开。
 * 纯函数模块，无 IO，便于单元测试。
 */
import type { FileKind } from '@urchin/ipc-contract';

/** 扩展名 → kind 分类表（key 一律小写、不含点）。 */
const EXT_KIND: Readonly<Record<string, FileKind>> = {
  // 音频
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  opus: 'audio',
  wma: 'audio',
  mid: 'audio',
  midi: 'audio',
  // 视频（mkv/avi 等 Chromium 不保证可解码，仍归 video 让原生播放器尝试）
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  mpg: 'video',
  mpeg: 'video',
  '3gp': 'video',
  mkv: 'video',
  avi: 'video',
  // 文档
  pdf: 'pdf',
  // 图片
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  apng: 'image',
  // HTML
  html: 'html',
  htm: 'html',
  // Markdown
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  // JSON
  json: 'json',
  jsonc: 'text',
  // 纯文本与常见配置文件
  txt: 'text',
  log: 'text',
  csv: 'text',
  tsv: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  ini: 'text',
  conf: 'text',
  cfg: 'text',
  env: 'text',
  toml: 'text',
  sql: 'text',
  bat: 'text',
  cmd: 'text',
  ps1: 'text',
  sh: 'text',
  js: 'text',
  mjs: 'text',
  cjs: 'text',
  ts: 'text',
  tsx: 'text',
  jsx: 'text',
  css: 'text',
  scss: 'text',
  py: 'text',
  go: 'text',
  rs: 'text',
  java: 'text',
  c: 'text',
  h: 'text',
  cpp: 'text',
  hpp: 'text',
  cs: 'text',
  rb: 'text',
  php: 'text',
  swift: 'text',
  kt: 'text',
  gitignore: 'text',
  editorconfig: 'text',
  lock: 'text',
};

/** 常见扩展名 → MIME 类型（未知回退 application/octet-stream）。 */
const EXT_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'text/xml',
  css: 'text/css',
  js: 'text/javascript',
};

/**
 * 取文件扩展名（小写、不含点）。无扩展名返回空字符串。
 *
 * @param name 文件名
 * @returns 小写扩展名，如 'MP4' → 'mp4'；'README' → ''
 */
export function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 按文件名分类文件类型。
 *
 * @param name 文件名
 * @returns kind：分类表命中返回对应类型，未知/无扩展名返回 binary
 */
export function classifyFileKind(name: string): FileKind {
  const ext = getExt(name);
  return EXT_KIND[ext] ?? 'binary';
}

/**
 * 按扩展名推断 MIME 类型。
 *
 * @param name 文件名
 * @returns MIME 类型，未知返回 application/octet-stream
 */
export function inferMimeType(name: string): string {
  return EXT_MIME[getExt(name)] ?? 'application/octet-stream';
}

/**
 * 反查某 kind 的扩展名清单（按字母序）。
 *
 * 供「默认应用」关联功能使用：把 EXT_KIND 分类表作为扩展名单一真源，
 * 关联注册的扩展名与查看器类型分类永远不漂移。
 * 注意：EXT_KIND 含 gitignore/editorconfig 等 dotfile 语义键（对应 .gitignore /
 * .editorconfig 整文件名，非文件后缀），已显式排除。
 *
 * @param kind 文件类型分类
 * @returns 该 kind 对应的扩展名数组（不含点、小写），未知 kind 返回空数组
 */
export function getExtensionsForKind(kind: FileKind): readonly string[] {
  // dotfile 整文件名键，不参与文件关联
  const NON_SUFFIX_KEYS: ReadonlySet<string> = new Set(['gitignore', 'editorconfig']);
  return Object.entries(EXT_KIND)
    .filter(([ext, k]) => k === kind && !NON_SUFFIX_KEYS.has(ext))
    .map(([ext]) => ext)
    .sort();
}
