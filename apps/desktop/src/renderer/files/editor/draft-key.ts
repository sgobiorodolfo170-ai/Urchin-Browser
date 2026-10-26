/**
 * 编辑草稿键生成（draft-key）
 *
 * 职责：由原文件绝对路径生成稳定、符合 IPC schema 白名单（仅字母/数字/连字符）
 * 的草稿键。设计理由（AGENTS.md §六 安全）：原路径不出本机——主进程只按 key
 * 拼接 editor-drafts 目录内路径（无路径入参），杜绝目录遍历；键含可读 basename
 * 前缀（人可排查）+ 完整路径 FNV-1a 哈希后 8 位（同名不同目录不冲突）。
 * 渲染层禁用 node:path（沙箱渲染进程无 node 内置模块），basename 自行切分。
 */

/** 键内非法字符（schema 白名单之外的一切）→ 连字符。 */
const KEY_ILLEGAL = /[^A-Za-z0-9-]/g;

/** FNV-1a 32 位哈希（十六进制 8 位）。选它：实现极简、分布均匀、无依赖。 */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 取文件名（兼容 \\ 与 / 分隔；无分隔符返回原串）。 */
function baseName(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * 生成草稿键：<净化 basename>-<路径哈希8位>（扩展名一并保留、点转连字符，
 * 如 notes.md → notes-md-xxxxxxxx）。CJK 等非白名单字符转连字符
 * （唯一性由哈希保证，前缀仅助人排查）。
 */
export function draftKey(absolutePath: string): string {
  const stem = baseName(absolutePath).replace(KEY_ILLEGAL, '-').slice(0, 40);
  const prefix = stem.length > 0 ? stem : 'draft';
  return `${prefix}-${fnv1a32(absolutePath)}`.slice(0, 80);
}
