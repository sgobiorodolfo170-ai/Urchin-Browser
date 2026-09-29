/**
 * M25 邮箱模块 · SQLite 持久化
 *
 * 依据：ADR-010 ML3 / 邮箱模块功能规划 §4
 * 职责：mail_accounts / mail_folders / mail_messages 三表的 CRUD
 *
 * 隔离保证（新模块接入约束声明 §4）：
 * - 表名以 mail_ 前缀隔离，与其他模块无外键关联
 * - 使用 mainStore.query/run（复用 M8 main 库连接）
 */
import type { MailAccountRecord, MailFolderRow, MailMessageRow } from './types';

/** 持久化接口（便于测试 mock） */
export interface MailPersistence {
  loadAccounts(): MailAccountRecord[];
  insertAccount(account: MailAccountRecord): void;
  deleteAccount(accountId: string): void;

  loadFolders(accountId: string): MailFolderRow[];
  upsertFolders(accountId: string, folders: readonly MailFolderRow[]): void;

  loadMessages(accountId: string, folder: string): MailMessageRow[];
  upsertMessages(rows: readonly MailMessageRow[]): void;
  getMessage(accountId: string, folder: string, uid: number): MailMessageRow | null;
  updateMessageBody(
    accountId: string,
    folder: string,
    uid: number,
    bodyHtml: string | null,
    bodyText: string | null,
  ): void;
  updateMessageFlags(accountId: string, folder: string, uid: number, flags: string): void;
  getMaxUid(accountId: string, folder: string): number | null;
}

/** 基于 mainStore（SQLite main 库 query/run）的实现 */
export class MailStorage implements MailPersistence {
  constructor(
    private readonly query: <T>(sql: string, ...params: readonly unknown[]) => readonly T[],
    private readonly run: (sql: string, ...params: readonly unknown[]) => void,
  ) {}

  loadAccounts(): MailAccountRecord[] {
    // 注意：SQLite 无布尔类型——imap_secure/smtp_secure 存 INTEGER 0/1，
    // better-sqlite3 读出为 number，必须转回 boolean，否则 IPC 出参 zod 校验
    // （z.boolean()）会失败（2026-09-25 生产 bug：list 出参校验失败导致
    // 保存后 UI 卡在配置表单、用户重复点击产生 55 条重复账户）。
    const rows = this.query<
      Omit<MailAccountRecord, 'imapSecure' | 'smtpSecure'> & {
        imapSecure: number;
        smtpSecure: number | null;
      }
    >(
      'SELECT id, name, email, imap_host AS imapHost, imap_port AS imapPort, imap_secure AS imapSecure, smtp_host AS smtpHost, smtp_port AS smtpPort, smtp_secure AS smtpSecure, created_at AS createdAt FROM mail_accounts ORDER BY created_at ASC',
    );
    return rows.map((r) => ({
      ...r,
      imapSecure: r.imapSecure === 1,
      smtpSecure: r.smtpSecure === null ? null : r.smtpSecure === 1,
    }));
  }

  insertAccount(account: MailAccountRecord): void {
    this.run(
      `INSERT INTO mail_accounts (id, name, email, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      account.id,
      account.name,
      account.email,
      account.imapHost,
      account.imapPort,
      account.imapSecure ? 1 : 0,
      account.smtpHost,
      account.smtpPort,
      account.smtpSecure === null ? null : account.smtpSecure ? 1 : 0,
      account.createdAt,
    );
  }

  deleteAccount(accountId: string): void {
    this.run('DELETE FROM mail_accounts WHERE id = ?', accountId);
  }

  loadFolders(accountId: string): MailFolderRow[] {
    const rows = this.query<MailFolderRow>(
      'SELECT account_id, path, name, delimiter, flags, msg_count, unseen, last_synced_at FROM mail_folders WHERE account_id = ?',
      accountId,
    );
    return [...rows];
  }

  upsertFolders(accountId: string, folders: readonly MailFolderRow[]): void {
    for (const f of folders) {
      this.run(
        `INSERT INTO mail_folders (account_id, path, name, delimiter, flags, msg_count, unseen, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, path) DO UPDATE SET
           name = excluded.name, delimiter = excluded.delimiter, flags = excluded.flags,
           msg_count = excluded.msg_count, unseen = excluded.unseen, last_synced_at = excluded.last_synced_at`,
        f.account_id,
        f.path,
        f.name,
        f.delimiter,
        f.flags,
        f.msg_count,
        f.unseen,
        f.last_synced_at,
      );
    }
  }

  loadMessages(accountId: string, folder: string): MailMessageRow[] {
    const rows = this.query<MailMessageRow>(
      'SELECT account_id, folder, uid, subject, from_addr, to_addrs, date, size, flags, fetched_at, body_html, body_text FROM mail_messages WHERE account_id = ? AND folder = ? ORDER BY date DESC',
      accountId,
      folder,
    );
    return [...rows];
  }

  upsertMessages(rows: readonly MailMessageRow[]): void {
    for (const row of rows) {
      this.run(
        `INSERT INTO mail_messages (account_id, folder, uid, subject, from_addr, to_addrs, date, size, flags, fetched_at, body_html, body_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
           subject = excluded.subject, from_addr = excluded.from_addr, to_addrs = excluded.to_addrs,
           date = excluded.date, size = excluded.size, flags = excluded.flags,
           fetched_at = excluded.fetched_at, body_html = excluded.body_html, body_text = excluded.body_text`,
        row.account_id,
        row.folder,
        row.uid,
        row.subject,
        row.from_addr,
        row.to_addrs,
        row.date,
        row.size,
        row.flags,
        row.fetched_at,
        row.body_html,
        row.body_text,
      );
    }
  }

  getMessage(accountId: string, folder: string, uid: number): MailMessageRow | null {
    const rows = this.query<MailMessageRow>(
      'SELECT account_id, folder, uid, subject, from_addr, to_addrs, date, size, flags, fetched_at, body_html, body_text FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?',
      accountId,
      folder,
      uid,
    );
    return rows[0] ?? null;
  }

  updateMessageBody(
    accountId: string,
    folder: string,
    uid: number,
    bodyHtml: string | null,
    bodyText: string | null,
  ): void {
    this.run(
      'UPDATE mail_messages SET body_html = ?, body_text = ?, fetched_at = ? WHERE account_id = ? AND folder = ? AND uid = ?',
      bodyHtml,
      bodyText,
      Date.now(),
      accountId,
      folder,
      uid,
    );
  }

  updateMessageFlags(accountId: string, folder: string, uid: number, flags: string): void {
    this.run(
      'UPDATE mail_messages SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?',
      flags,
      accountId,
      folder,
      uid,
    );
  }

  getMaxUid(accountId: string, folder: string): number | null {
    const rows = this.query<{ max_uid: number | null }>(
      'SELECT MAX(uid) AS max_uid FROM mail_messages WHERE account_id = ? AND folder = ?',
      accountId,
      folder,
    );
    return rows[0]?.max_uid ?? null;
  }
}
