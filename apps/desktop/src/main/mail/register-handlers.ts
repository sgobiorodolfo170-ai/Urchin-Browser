/**
 * M25 邮箱模块 · IPC Handler 注册
 *
 * 依据：邮箱模块功能规划 §3 / 契约 B §3 mail.* 通道
 * 职责：注册 mail.account.* / mail.folder.* / mail.message.* IPC handler
 *
 * 设计理由（AGENTS.md §七.2 + 项目特化审查点）：
 * - IPC handler 只做协议适配，业务逻辑委托给 MailManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 * - 新邮件推送经 WebContents.send 单向事件（不走 registerHandler）
 */
import type { IpcMain, WebContents } from 'electron';
import { BrowserWindow, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { MailManager } from './mail-manager';
import { MAIL_EVENT_CHANNEL, MAIL_FOLDERS_UPDATED_CHANNEL } from './mail-manager';
import { translateMailBody } from './mail-translate';
import type { TranslateManager } from '../translate/translate-manager';

const log = createLogger('mail-ipc');

export interface MailHandlerDeps {
  ipcMain: IpcMain;
  mailManager: MailManager;
  getMainWindow: () => WebContents | null;
  /** M24 翻译管理器（邮件翻译复用引擎层，2026-09-26） */
  translateManager: TranslateManager;
}

/**
 * 注册 mail 域 IPC handler。
 *
 * 注册后自动通过 createTypedInvoke 暴露到渲染进程（preload 无需手动修改）。
 */
export function registerMailHandlers(deps: MailHandlerDeps): void {
  const { ipcMain, mailManager, getMainWindow, translateManager } = deps;

  // 注入新邮件推送函数：MailManager → WebContents.send（依赖注入，与 translate 模式一致）
  mailManager.setNotifyNewMessage((accountId, folder, uid, envelope) => {
    const wc = getMainWindow();
    if (wc && !wc.isDestroyed()) {
      wc.send(MAIL_EVENT_CHANNEL, { accountId, folder, uid, envelope });
      log.info('new mail pushed', { accountId, folder, uid });
    }
  });

  // 注入文件夹更新推送：后台刷新文件夹后通知渲染层
  mailManager.setNotifyFoldersUpdated((accountId) => {
    const wc = getMainWindow();
    if (wc && !wc.isDestroyed()) {
      wc.send(MAIL_FOLDERS_UPDATED_CHANNEL, { accountId });
    }
  });

  // mail.account.list：列出已配置的邮件账户
  registerHandler(ipcMain, 'mail.account.list', () => {
    const accounts = mailManager.listAccounts();
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        imapSecure: a.imapSecure,
        smtpHost: a.smtpHost ?? undefined,
        smtpPort: a.smtpPort ?? undefined,
        smtpSecure: a.smtpSecure ?? undefined,
        createdAt: a.createdAt,
      })),
    };
  });

  // mail.account.add：添加 IMAP 账户（密码经 safeStorage 加密）
  registerHandler(ipcMain, 'mail.account.add', async (req) => {
    log.info('mail.account.add', { email: req.email });
    const account = await mailManager.addAccount({
      name: req.name,
      email: req.email,
      imapHost: req.imapHost,
      imapPort: req.imapPort,
      imapSecure: req.imapSecure,
      password: req.password,
      smtpHost: req.smtpHost,
      smtpPort: req.smtpPort,
      smtpSecure: req.smtpSecure,
    });
    return {
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
        imapHost: account.imapHost,
        imapPort: account.imapPort,
        imapSecure: account.imapSecure,
        smtpHost: account.smtpHost ?? undefined,
        smtpPort: account.smtpPort ?? undefined,
        smtpSecure: account.smtpSecure ?? undefined,
        createdAt: account.createdAt,
      },
    };
  });

  // mail.account.delete：删除账户（清理连接 + 密码 + 数据库记录）
  registerHandler(ipcMain, 'mail.account.delete', async (req) => {
    log.info('mail.account.delete', { accountId: req.accountId });
    await mailManager.deleteAccount(req.accountId);
    return { ok: true as const };
  });

  // mail.account.test：测试 IMAP 连接（不持久化）
  registerHandler(ipcMain, 'mail.account.test', async (req) => {
    log.info('mail.account.test', { imapHost: req.imapHost, email: req.email });
    const result = await mailManager.testConnection({
      imapHost: req.imapHost,
      imapPort: req.imapPort,
      imapSecure: req.imapSecure,
      email: req.email,
      password: req.password,
    });
    return result;
  });

  // mail.folder.list：列出账户的文件夹（cache-first）
  registerHandler(ipcMain, 'mail.folder.list', async (req) => {
    log.info('mail.folder.list', { accountId: req.accountId });
    const result = await mailManager.listFolders(req.accountId);
    return {
      folders: result.folders.map((f) => ({
        path: f.path,
        name: f.name,
        delimiter: f.delimiter,
        flags: f.flags,
        exists: f.exists,
        unseen: f.unseen,
      })),
      fromCache: result.fromCache,
    };
  });

  // mail.message.list：分页拉取邮件列表（cache-first）
  registerHandler(ipcMain, 'mail.message.list', async (req) => {
    const result = await mailManager.listMessages(req.accountId, req.folder, req.limit, req.offset);
    return {
      messages: result.messages,
      total: result.total,
      fromCache: result.fromCache,
    };
  });

  // mail.message.fetch：拉取邮件完整正文
  registerHandler(ipcMain, 'mail.message.fetch', async (req) => {
    const body = await mailManager.fetchMessage(req.accountId, req.folder, req.uid);
    log.info('mail.message.fetch', {
      uid: req.uid,
      hasHtml: !!body.html,
      hasText: !!body.text,
      contentUrl: body.contentUrl ?? null,
      attachmentCount: body.attachments.length,
    });
    // 附件内容（contentBase64）不经 IPC 回传——仅元数据；正文 HTML 经 contentUrl 协议路由下发
    return {
      uid: body.uid,
      text: body.text,
      contentUrl: body.contentUrl,
      attachments: body.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  });

  // mail.message.markRead：标记已读/未读
  registerHandler(ipcMain, 'mail.message.markRead', async (req) => {
    await mailManager.markRead(req.accountId, req.folder, req.uid, req.seen);
    return { ok: true as const };
  });

  // mail.message.send：SMTP 发送邮件
  registerHandler(ipcMain, 'mail.message.send', async (req) => {
    log.info('mail.message.send', {
      accountId: req.accountId,
      to: req.to.length,
      cc: req.cc?.length ?? 0,
      subject: req.subject.slice(0, 50),
      attachments: req.attachments?.length ?? 0,
    });
    const result = await mailManager.sendMessage({
      accountId: req.accountId,
      to: req.to,
      cc: req.cc,
      bcc: req.bcc,
      subject: req.subject,
      text: req.text,
      html: req.html,
      inReplyToUid: req.inReplyToUid,
      attachments: req.attachments,
    });
    return result;
  });

  // mail.attachment.select：附件文件选择器（多选，读取 base64 内容）
  registerHandler(ipcMain, 'mail.attachment.select', async () => {
    log.info('mail.attachment.select');
    const focused = BrowserWindow.getFocusedWindow();
    const result = focused
      ? await dialog.showOpenDialog(focused, {
          title: '选择附件',
          buttonLabel: '添加',
          properties: ['openFile', 'multiSelections'],
        })
      : await dialog.showOpenDialog({
          title: '选择附件',
          properties: ['openFile', 'multiSelections'],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { attachments: [] };
    }
    const attachments = result.filePaths.map((filePath) => {
      const buffer = readFileSync(filePath);
      const filename = filePath.split(/[/\\]/).pop() ?? 'attachment';
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      const contentTypeMap: Record<string, string> = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        bmp: 'image/bmp',
        zip: 'application/zip',
        rar: 'application/x-rar-compressed',
        '7z': 'application/x-7z-compressed',
        txt: 'text/plain',
        csv: 'text/csv',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
      };
      return {
        filename,
        contentType: contentTypeMap[ext] ?? 'application/octet-stream',
        contentBase64: buffer.toString('base64'),
        size: buffer.length,
      };
    });
    log.info('mail.attachment.select done', { count: attachments.length });
    return { attachments };
  });

  // mail.message.translate：邮件翻译（复用 M24 引擎层；中英互译自动判定）
  registerHandler(ipcMain, 'mail.message.translate', async (req) => {
    log.info('mail.message.translate', { uid: req.uid, folder: req.folder });
    const body = await mailManager.fetchMessage(req.accountId, req.folder, req.uid);
    const result = await translateMailBody(
      { html: body.html, text: body.text },
      (texts, targetLang) => translateManager.translateTexts(texts, targetLang),
      req.targetLang,
    );
    let contentUrl: string | undefined;
    if (result.html) {
      const token = mailManager.contentStore.put(result.html);
      contentUrl = `urchin://mail-content/${token}`;
    }
    log.info('mail.message.translate done', {
      uid: req.uid,
      engine: result.engine,
      targetLang: result.targetLang,
      hasHtml: !!result.html,
    });
    return {
      contentUrl,
      text: result.text,
      detectedLang: result.detectedLang,
      engine: result.engine,
      targetLang: result.targetLang,
    };
  });

  log.info('mail ipc handlers registered');
}

export { MAIL_EVENT_CHANNEL };
