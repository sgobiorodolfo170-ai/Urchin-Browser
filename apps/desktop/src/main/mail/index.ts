/**
 * M25 邮箱模块 · 主进程侧入口
 *
 * 依据：ADR-010 / 邮箱模块功能规划 §2
 * 导出 MailManager / MailStorage / registerMailHandlers
 */
export { MailManager, MAIL_EVENT_CHANNEL, MAIL_FOLDERS_UPDATED_CHANNEL } from './mail-manager';
export type { NotifyNewMessage, NotifyFoldersUpdated } from './mail-manager';
export { MailStorage } from './mail-storage';
export type { MailPersistence } from './mail-storage';
export { MailContentStore } from './mail-content-store';
export { prepareMailHtml, sanitizeMailHtml, rewriteCidImages } from './mail-html';
export { registerMailHandlers } from './register-handlers';
export type { MailHandlerDeps } from './register-handlers';
export { ImapClient } from './imap-client';
export type { ImapFolderInfo, ImapMessageSummary, ImapMessageBody } from './imap-client';
export { SmtpClient } from './smtp-client';
export type { SmtpConnectionConfig, SendMailParams } from './smtp-client';
