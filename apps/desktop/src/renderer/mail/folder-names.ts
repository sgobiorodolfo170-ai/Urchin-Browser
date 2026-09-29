/**
 * M25 邮箱模块 · 文件夹中文显示名映射（渲染进程纯函数）
 *
 * 依据：用户指令「文件夹分类名请使用中文显示」（2026-09-25）
 * 职责：把 IMAP 文件夹的英文路径/名称映射为中文显示名。
 *
 * 判定优先级：
 * 1. 特殊用途标志（\Inbox / \Sent / \Drafts / \Trash / \Junk / \Archive，RFC 6154）——
 *    服务器支持 SPECIAL-USE 扩展时最可靠，不受文件夹名语言影响
 * 2. 常见英文名称映射（INBOX / Sent Messages / Deleted Messages 等，大小写不敏感）
 * 3. 无法识别 → 返回原名（用户自建文件夹/中文名文件夹不受影响）
 */

/** 特殊用途标志 → 中文名 */
const SPECIAL_USE_MAP: Readonly<Record<string, string>> = {
  '\\inbox': '收件箱',
  '\\sent': '已发送',
  '\\drafts': '草稿箱',
  '\\trash': '已删除',
  '\\junk': '垃圾邮件',
  '\\archive': '归档',
  '\\all': '全部邮件',
  '\\flagged': '星标邮件',
  '\\important': '重要邮件',
};

/** 常见英文文件夹名（小写）→ 中文名 */
const NAME_MAP: Readonly<Record<string, string>> = {
  inbox: '收件箱',
  sent: '已发送',
  'sent messages': '已发送',
  'sent items': '已发送',
  drafts: '草稿箱',
  draft: '草稿箱',
  trash: '已删除',
  'deleted messages': '已删除',
  'deleted items': '已删除',
  deleted: '已删除',
  junk: '垃圾邮件',
  'junk email': '垃圾邮件',
  'junk e-mail': '垃圾邮件',
  spam: '垃圾邮件',
  'bulk mail': '垃圾邮件',
  archive: '归档',
  outbox: '发件箱',
  notes: '备忘录',
  'junk folder': '垃圾邮件',
  'all mail': '全部邮件',
  starred: '星标邮件',
  important: '重要邮件',
};

/**
 * 取文件夹的中文显示名。
 *
 * @param folder 文件夹信息（path / name / flags）
 * @returns 中文显示名；无法识别时返回 name 原值
 */
export function folderDisplayName(folder: {
  path: string;
  name: string;
  flags: readonly string[];
}): string {
  // 1. 特殊用途标志优先
  for (const flag of folder.flags) {
    const mapped = SPECIAL_USE_MAP[flag.toLowerCase()];
    if (mapped) return mapped;
  }

  // 2. 名称映射（name 与 path 都试——有的服务器 name 为空但 path 可识别）
  const byName = NAME_MAP[folder.name.trim().toLowerCase()];
  if (byName) return byName;
  const byPath = NAME_MAP[folder.path.trim().toLowerCase()];
  if (byPath) return byPath;

  // 3. 原名
  return folder.name || folder.path;
}
