/**
 * M25 邮箱模块 · 业务编排核心（缓存持久化版）
 *
 * 依据：ADR-010 ML2 / 邮箱模块功能规划 §2 / Phase 1-3 缓存方案
 * 职责：
 * 1. 账户 CRUD（密码经 SecretStore 加密存储，不落 SQLite）
 * 2. IMAP 连接管理（按账户维护 ImapClient 实例 + heartbeat 保活 + 断线重连）
 * 3. Cache-First 读路径：文件夹/邮件列表/正文 先读 SQLite 即时返回，后台 IMAP 增量同步
 * 4. IDLE 推送桥接（新邮件 → onNewMessage 回调 → IPC 事件推送）
 * 5. 离线降级：IMAP 不可达时只读 SQLite 缓存
 *
 * 设计理由（AGENTS.md §六 Single Source of Truth）：
 * 主进程是邮箱状态的权威源，渲染层 store 只是镜像。
 * SQLite 是缓存层（信封 + 已读正文持久化），IMAP 是同步源（增量拉取新邮件）。
 */
import { randomUUID } from 'node:crypto';
import { IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import type { SecretStore } from '../storage/types';
import type { MailPersistence } from './mail-storage';
import {
  ImapClient,
  type ImapFolderInfo,
  type ImapMessageSummary,
  type ImapMessageBody,
} from './imap-client';
import { SmtpClient } from './smtp-client';
import { MailContentStore } from './mail-content-store';
import { prepareMailHtml } from './mail-html';
import { mailPasswordKey, type MailAccountRecord, type MailMessageRow } from './types';

/** 新邮件通知函数类型（依赖注入，生产环境推送 IPC 事件，单测注入收集数组） */
export type NotifyNewMessage = (
  accountId: string,
  folder: string,
  uid: number,
  envelope: {
    subject: string;
    from: string;
    to: string[];
    date: string;
    size: number;
  },
) => void;

/** 文件夹更新通知（后台刷新后推送，UI 刷新文件夹列表） */
export type NotifyFoldersUpdated = (accountId: string) => void;

/** 心跳间隔：10 分钟（IMAP 服务器通常 15-30 分钟断空闲连接） */
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

export class MailManager {
  private readonly persistence: MailPersistence;
  private readonly secrets: SecretStore;
  private readonly connections = new Map<string, ImapClient>();
  private readonly idleStoppers = new Map<string, () => Promise<void>>();
  private notifyNewMessage: NotifyNewMessage | null = null;
  private notifyFoldersUpdated: NotifyFoldersUpdated | null = null;
  readonly contentStore: MailContentStore;

  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 后台同步去重：`accountId:folder` → 进行中的 Promise */
  private readonly syncingFolders = new Map<string, Promise<void>>();

  constructor(persistence: MailPersistence, secrets: SecretStore, contentStore?: MailContentStore) {
    this.persistence = persistence;
    this.secrets = secrets;
    this.contentStore = contentStore ?? new MailContentStore();
  }

  setNotifyNewMessage(fn: NotifyNewMessage): void {
    this.notifyNewMessage = fn;
  }

  setNotifyFoldersUpdated(fn: NotifyFoldersUpdated): void {
    this.notifyFoldersUpdated = fn;
  }

  // ────────────── 账户管理 ──────────────

  listAccounts(): MailAccountRecord[] {
    return this.persistence.loadAccounts();
  }

  async addAccount(params: {
    name: string;
    email: string;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    password: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
  }): Promise<MailAccountRecord> {
    const id = randomUUID();
    const account: MailAccountRecord = {
      id,
      name: params.name,
      email: params.email,
      imapHost: params.imapHost,
      imapPort: params.imapPort,
      imapSecure: params.imapSecure,
      smtpHost: params.smtpHost ?? null,
      smtpPort: params.smtpPort ?? null,
      smtpSecure: params.smtpSecure ?? null,
      createdAt: Date.now(),
    };
    this.persistence.insertAccount(account);
    await this.secrets.set(mailPasswordKey(id), params.password);
    return account;
  }

  async deleteAccount(accountId: string): Promise<void> {
    const stopper = this.idleStoppers.get(accountId);
    if (stopper) {
      await stopper();
      this.idleStoppers.delete(accountId);
    }
    const conn = this.connections.get(accountId);
    if (conn) {
      await conn.disconnect();
      this.connections.delete(accountId);
    }
    await this.secrets.delete(mailPasswordKey(accountId));
    this.persistence.deleteAccount(accountId);
  }

  async testConnection(params: {
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    email: string;
    password: string;
  }): Promise<{ ok: true; folders: string[] }> {
    const testClient = new ImapClient();
    try {
      await testClient.connect({
        host: params.imapHost,
        port: params.imapPort,
        secure: params.imapSecure,
        auth: { user: params.email, pass: params.password },
      });
      const folders = await testClient.listFolders();
      return { ok: true, folders: folders.map((f) => f.path) };
    } finally {
      await testClient.disconnect();
    }
  }

  // ────────────── Cache-First 读路径 ──────────────

  /**
   * 列出文件夹（Cache-First）：
   * 有缓存 → 立即返回 + 后台刷新；无缓存 → 同步从 IMAP 拉取。
   */
  async listFolders(accountId: string): Promise<{ folders: ImapFolderInfo[]; fromCache: boolean }> {
    const cached = this.persistence.loadFolders(accountId);
    if (cached.length > 0) {
      void this.refreshFoldersFromImap(accountId).catch(() => {
        // 后台刷新失败静默：不影响 UI（缓存仍可用）
      });
      return { folders: cached.map(folderRowToInfo), fromCache: true };
    }
    const folders = await this.refreshFoldersFromImap(accountId);
    return { folders, fromCache: false };
  }

  /**
   * 分页拉取邮件列表（Cache-First）：
   * 有缓存 → 立即返回 SQLite 分页 + 后台增量同步新邮件；
   * 无缓存 → 从 IMAP 拉取首批 + 写入缓存。
   */
  async listMessages(
    accountId: string,
    folder: string,
    limit: number,
    offset: number,
  ): Promise<{ messages: ImapMessageSummary[]; total: number; fromCache: boolean }> {
    const cached = this.persistence.loadMessages(accountId, folder);
    if (cached.length > 0) {
      const page = cached.slice(offset, offset + limit).map(messageRowToSummary);
      void this.syncNewMessages(accountId, folder).catch(() => {
        // 后台同步失败静默：不影响 UI（缓存仍可用）
      });
      return { messages: page, total: cached.length, fromCache: true };
    }
    // 无缓存：从 IMAP 拉取首批
    const result = await this.fetchAndCacheMessages(accountId, folder, limit, offset);
    return { ...result, fromCache: false };
  }

  /**
   * 拉取邮件正文（Cache-First）：
   * fetched_at 非空 + body_html 有值 → 直接从缓存返回（不连 IMAP）；
   * 否则 → IMAP 拉取 + postal-mime 解析 + sanitize + 缓存正文。
   */
  async fetchMessage(accountId: string, folder: string, uid: number): Promise<ImapMessageBody> {
    const cached = this.persistence.getMessage(accountId, folder, uid);
    if (cached?.fetched_at != null && cached.body_html != null) {
      const html = cached.body_html ?? undefined;
      const text = cached.body_text ?? undefined;
      let contentUrl: string | undefined;
      if (html) {
        const token = this.contentStore.put(html);
        contentUrl = `urchin://mail-content/${token}`;
      }
      return { uid, html, text, contentUrl, attachments: [] };
    }
    // 未缓存：从 IMAP 拉取
    const conn = await this.ensureConnection(accountId);
    const body = await conn.fetchMessage(folder, uid);
    // 缓存信封（如果首次拉取时未缓存）
    if (cached) {
      if (body.html) {
        const prepared = prepareMailHtml(body.html, body.attachments);
        body.html = prepared;
        this.persistence.updateMessageBody(accountId, folder, uid, prepared, body.text ?? null);
      } else {
        this.persistence.updateMessageBody(accountId, folder, uid, null, body.text ?? null);
      }
    } else {
      // 邮件不在缓存中（可能新到的）：写入完整行
      const row: MailMessageRow = {
        account_id: accountId,
        folder,
        uid,
        subject: '',
        from_addr: '',
        to_addrs: '[]',
        date: new Date().toISOString(),
        size: 0,
        flags: '[]',
        fetched_at: Date.now(),
        body_html: body.html ? prepareMailHtml(body.html, body.attachments) : null,
        body_text: body.text ?? null,
      };
      if (body.html) {
        body.html = row.body_html ?? undefined;
      }
      this.persistence.upsertMessages([row]);
    }
    // 生成 contentUrl
    if (body.html) {
      const token = this.contentStore.put(body.html);
      body.contentUrl = `urchin://mail-content/${token}`;
    }
    return body;
  }

  /** 标记已读/未读（同步更新 SQLite flags 缓存） */
  async markRead(accountId: string, folder: string, uid: number, seen: boolean): Promise<void> {
    const conn = await this.ensureConnection(accountId);
    await conn.markRead(folder, uid, seen);
    // 同步更新 SQLite flags
    const row = this.persistence.getMessage(accountId, folder, uid);
    if (row) {
      const flags = JSON.parse(row.flags) as string[];
      const updated = seen
        ? [...new Set([...flags, '\\Seen'])]
        : flags.filter((f) => f !== '\\Seen');
      this.persistence.updateMessageFlags(accountId, folder, uid, JSON.stringify(updated));
    }
  }

  /**
   * 发送邮件（SMTP）。
   *
   * 流程：取账户 SMTP 配置 + 解密密码 → 创建 SMTP transport → 发送 → 关闭。
   * transport 为短连接（发完即关），不需要保活。
   */
  async sendMessage(params: {
    accountId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyToUid?: number;
    attachments?: { filename: string; contentType?: string; contentBase64: string }[];
  }): Promise<{ ok: true; messageId?: string }> {
    const accounts = this.persistence.loadAccounts();
    const account = accounts.find((a) => a.id === params.accountId);
    if (!account) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `账户不存在: ${params.accountId}`, {});
    }
    if (!account.smtpHost) {
      throw new IpcError(IpcErrorCode.STATE, '该账户未配置 SMTP（请在设置中填写发信服务器）', {});
    }
    const password = await this.secrets.get(mailPasswordKey(params.accountId));
    if (!password) {
      throw new IpcError(IpcErrorCode.STATE, `账户密码缺失: ${params.accountId}`, {});
    }

    const smtp = new SmtpClient();
    try {
      await smtp.connect({
        host: account.smtpHost,
        port: account.smtpPort ?? 587,
        secure: account.smtpSecure ?? false,
        auth: { user: account.email, pass: password },
      });
      const fromAddr = `${account.name} <${account.email}>`;
      const messageId = await smtp.sendMail({
        from: fromAddr,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        text: params.text,
        html: params.html,
        inReplyTo: params.inReplyToUid ? String(params.inReplyToUid) : undefined,
        attachments: params.attachments,
      });
      return { ok: true, messageId };
    } finally {
      smtp.disconnect();
    }
  }

  /** 启动 IDLE 监听（新邮件推送） */
  async startIdle(accountId: string, folder: string): Promise<void> {
    const existing = this.idleStoppers.get(accountId);
    if (existing) {
      await existing();
      this.idleStoppers.delete(accountId);
    }
    const conn = await this.ensureConnection(accountId);
    const stopFn = await conn.startIdle(folder, (uid, envelope) => {
      this.notifyNewMessage?.(accountId, folder, uid, envelope);
    });
    this.idleStoppers.set(accountId, stopFn);
  }

  // ────────────── 后台同步 ──────────────

  /** 从 IMAP 刷新文件夹列表并写入 SQLite */
  private async refreshFoldersFromImap(accountId: string): Promise<ImapFolderInfo[]> {
    const conn = await this.ensureConnection(accountId);
    const folders = await conn.listFolders();
    const rows = folders.map((f) => ({
      account_id: accountId,
      path: f.path,
      name: f.name,
      delimiter: f.delimiter,
      flags: JSON.stringify(f.flags),
      msg_count: f.exists,
      unseen: f.unseen,
      last_synced_at: Date.now(),
    }));
    this.persistence.upsertFolders(accountId, rows);
    this.notifyFoldersUpdated?.(accountId);
    return folders;
  }

  /** 从 IMAP 拉取首批邮件并写入缓存 */
  private async fetchAndCacheMessages(
    accountId: string,
    folder: string,
    limit: number,
    offset: number,
  ): Promise<{ messages: ImapMessageSummary[]; total: number }> {
    const conn = await this.ensureConnection(accountId);
    const result = await conn.listMessages(folder, limit, offset);
    // 写入 SQLite 缓存
    const rows: MailMessageRow[] = result.messages.map((m) => ({
      account_id: accountId,
      folder: m.folder,
      uid: m.uid,
      subject: m.envelope.subject,
      from_addr: m.envelope.from,
      to_addrs: JSON.stringify(m.envelope.to),
      date: m.envelope.date,
      size: m.envelope.size,
      flags: JSON.stringify(m.flags),
      fetched_at: null,
      body_html: null,
      body_text: null,
    }));
    if (rows.length > 0) {
      this.persistence.upsertMessages(rows);
    }
    return result;
  }

  /**
   * 增量同步：拉取 UID > max_cached_uid 的新邮件信封，写入缓存。
   * 去重：同一 account+folder 的并发调用合并为一个 Promise。
   */
  private async syncNewMessages(accountId: string, folder: string): Promise<void> {
    const key = `${accountId}:${folder}`;
    const existing = this.syncingFolders.get(key);
    if (existing) return existing;

    const task = (async () => {
      try {
        const maxUid = this.persistence.getMaxUid(accountId, folder);
        if (maxUid === null) return; // 无缓存，交给 listMessages 首次全量拉取

        const conn = await this.ensureConnection(accountId);
        const newMessages = await conn.fetchSinceUid(folder, maxUid);
        if (newMessages.length === 0) return;

        const rows: MailMessageRow[] = newMessages.map((m) => ({
          account_id: accountId,
          folder: m.folder,
          uid: m.uid,
          subject: m.envelope.subject,
          from_addr: m.envelope.from,
          to_addrs: JSON.stringify(m.envelope.to),
          date: m.envelope.date,
          size: m.envelope.size,
          flags: JSON.stringify(m.flags),
          fetched_at: null,
          body_html: null,
          body_text: null,
        }));
        this.persistence.upsertMessages(rows);

        // 推送最新一封的事件 → 渲染层刷新列表
        const latest = newMessages[0]!;
        this.notifyNewMessage?.(accountId, folder, latest.uid, latest.envelope);
      } catch {
        // 后台同步失败静默：不影响 UI（缓存仍可用）
      } finally {
        this.syncingFolders.delete(key);
      }
    })();

    this.syncingFolders.set(key, task);
    return task;
  }

  // ────────────── 连接管理 ──────────────

  /** 确保账户已连接（未连接则自动连接） */
  private async ensureConnection(accountId: string): Promise<ImapClient> {
    let conn = this.connections.get(accountId);
    if (conn?.isConnected) return conn;

    const accounts = this.persistence.loadAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      throw new IpcError(IpcErrorCode.NOT_FOUND, `账户不存在: ${accountId}`, {});
    }
    const password = await this.secrets.get(mailPasswordKey(accountId));
    if (!password) {
      throw new IpcError(IpcErrorCode.STATE, `账户密码缺失: ${accountId}`, {});
    }

    conn = new ImapClient();
    await conn.connect({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.email, pass: password },
    });
    this.connections.set(accountId, conn);
    this.startHeartbeat();
    return conn;
  }

  /** 启动心跳保活（每 10 分钟 noop，断线自动清理） */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        for (const [accountId, conn] of this.connections) {
          if (!conn.isConnected) {
            this.connections.delete(accountId);
            continue;
          }
          try {
            await conn.noop();
          } catch {
            this.connections.delete(accountId);
          }
        }
      })();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** 清理所有连接 + 心跳（应用退出时调用） */
  async dispose(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [, stopper] of this.idleStoppers) {
      try {
        await stopper();
      } catch {
        /* ignore */
      }
    }
    this.idleStoppers.clear();
    for (const [, conn] of this.connections) {
      try {
        await conn.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }
}

// ────────────── 行映射工具函数 ──────────────

function folderRowToInfo(row: import('./types').MailFolderRow): ImapFolderInfo {
  return {
    path: row.path,
    name: row.name,
    delimiter: row.delimiter,
    flags: JSON.parse(row.flags) as string[],
    exists: row.msg_count,
    unseen: row.unseen,
  };
}

function messageRowToSummary(row: MailMessageRow): ImapMessageSummary {
  return {
    uid: row.uid,
    envelope: {
      subject: row.subject ?? '(无主题)',
      from: row.from_addr ?? '',
      to: JSON.parse(row.to_addrs ?? '[]') as string[],
      date: row.date ?? '',
      size: row.size ?? 0,
    },
    flags: JSON.parse(row.flags) as string[],
    folder: row.folder,
  };
}

/** IPC 事件通道名 */
export const MAIL_EVENT_CHANNEL = 'mail.event.newMessage';
export const MAIL_FOLDERS_UPDATED_CHANNEL = 'mail.event.foldersUpdated';
