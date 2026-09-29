/**
 * M25 邮箱模块 · 内部类型
 *
 * 依据：ADR-010 / 邮箱模块功能规划 §2-§3
 * 职责：定义主进程侧邮箱模块的内部数据结构（不跨进程暴露，跨进程类型见 ipc-contract）
 */

/** 邮箱账户内部表示（含安全敏感字段标记） */
export interface MailAccountRecord {
  id: string;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  createdAt: number;
}

/** safeStorage key 命名格式：mail-account/<accountId>/password */
export function mailPasswordKey(accountId: string): string {
  return `mail-account/${accountId}/password`;
}

/** IMAP 连接配置（从 MailAccountRecord + 解密后的密码构造） */
export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

/** 从 MailAccountRecord 提取 IMAP 连接配置 */
export function toImapConfig(account: MailAccountRecord, password: string): ImapConnectionConfig {
  return {
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: {
      user: account.email,
      pass: password,
    },
  };
}

/** 文件夹缓存行 */
export interface MailFolderRow {
  account_id: string;
  path: string;
  name: string;
  delimiter: string;
  flags: string;
  msg_count: number;
  unseen: number;
  last_synced_at: number | null;
}

/** 邮件缓存行 */
export interface MailMessageRow {
  account_id: string;
  folder: string;
  uid: number;
  subject: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  date: string | null;
  size: number | null;
  flags: string;
  fetched_at: number | null;
  /** Phase 1：sanitized HTML 正文缓存（已读过的邮件不重新拉取） */
  body_html: string | null;
  /** Phase 1：纯文本正文缓存 */
  body_text: string | null;
}

/** 附件内容（含 base64，用于 cid: 内嵌图片重写；不经 IPC 传输给渲染层） */
export interface MailAttachmentContent {
  filename: string;
  contentType: string;
  size: number;
  /** MIME Content-ID（cid: 引用键，可能带 <>） */
  contentId?: string;
  /** base64 编码内容 */
  contentBase64?: string;
}
