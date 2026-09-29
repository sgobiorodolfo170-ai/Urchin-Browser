/**
 * M25 邮箱模块 · IMAP 客户端封装（imapflow）
 *
 * 依据：ADR-010 ML1/ML2 / 邮箱模块功能规划 §2
 * 职责：
 * 1. 封装 imapflow ImapFlow 类的 connect/fetch/search/IDLE 操作
 * 2. 将 imapflow 原始返回值转换为 IPC 契约类型（MailFolder / MailMessageSummary）
 * 3. 将 imapflow 错误装箱为 IpcError（连接失败 → UNAVAILABLE，认证失败 → PERMISSION）
 *
 * 进程归属：主进程（imapflow 使用 Node net/tls，不可在渲染进程运行）
 */
import { ImapFlow } from 'imapflow';
import { IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import type { ImapConnectionConfig, MailAttachmentContent } from './types';

/** IMAP 文件夹信息（与 ipc-contract MailFolder 对齐） */
export interface ImapFolderInfo {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  exists: number;
  unseen: number;
}

/** IMAP 邮件信封（与 ipc-contract MailMessageEnvelope 对齐） */
export interface ImapEnvelope {
  subject: string;
  from: string;
  to: string[];
  date: string;
  size: number;
}

/** IMAP 邮件摘要（与 ipc-contract MailMessageSummary 对齐） */
export interface ImapMessageSummary {
  uid: number;
  envelope: ImapEnvelope;
  flags: string[];
  folder: string;
}

/** IMAP 邮件正文（与 ipc-contract MailMessageFetchRes 对齐 + 附件内容供 cid 重写） */
export interface ImapMessageBody {
  uid: number;
  html?: string;
  text?: string;
  attachments: MailAttachmentContent[];
  /** 邮件正文渲染 URL（urchin://mail-content/<token>，由 MailManager 填充） */
  contentUrl?: string;
}

/**
 * ImapClient 封装 imapflow，提供 Promise-based 的收信操作。
 *
 * 设计理由：将 imapflow 的 API 适配为项目 IPC 契约类型，
 * 同时统一错误装箱为 IpcError——渲染层只需处理 IpcErrorPayload。
 */
export class ImapClient {
  private client: ImapFlow | null = null;

  /** 当前是否已连接 */
  get isConnected(): boolean {
    return this.client !== null && this.client.usable === true;
  }

  /** 连接到 IMAP 服务器 */
  async connect(config: ImapConnectionConfig): Promise<void> {
    try {
      this.client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
        logger: false,
      });
      await this.client.connect();
    } catch (err) {
      this.client = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('authentication') ||
        msg.includes('auth') ||
        msg.includes('Invalid credentials')
      ) {
        throw new IpcError(IpcErrorCode.PERMISSION, `IMAP 认证失败: ${msg}`, {
          retryable: false,
        });
      }
      throw new IpcError(IpcErrorCode.UNAVAILABLE, `IMAP 连接失败: ${msg}`, {
        retryable: true,
      });
    }
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // logout 失败不抛出：断开是清理操作，不应阻塞调用方
    } finally {
      this.client = null;
    }
  }

  /** 列出所有文件夹 */
  async listFolders(): Promise<ImapFolderInfo[]> {
    this.ensureConnected();
    const client = this.client!;

    const mailboxes = await client.list();
    const folders: ImapFolderInfo[] = [];

    for (const mb of mailboxes) {
      if (mb.flags.has('\\Noselect')) continue;
      let exists = 0;
      try {
        const lock = await client.getMailboxLock(mb.path);
        try {
          const mbx = client.mailbox;
          if (mbx !== false) {
            exists = mbx.exists;
          }
        } finally {
          lock.release();
        }
      } catch {
        // 无法打开的文件夹跳过状态查询
      }

      folders.push({
        path: mb.path,
        name: mb.name,
        delimiter: mb.delimiter ?? '/',
        flags: [...mb.flags],
        exists,
        unseen: 0,
      });
    }

    return folders;
  }

  /** 分页拉取邮件列表（按 UID 降序，最新的在前） */
  async listMessages(
    folder: string,
    limit: number,
    offset: number,
  ): Promise<{ messages: ImapMessageSummary[]; total: number }> {
    this.ensureConnected();
    const client = this.client!;

    const lock = await client.getMailboxLock(folder);
    try {
      const mbx = client.mailbox;
      const total = mbx !== false ? mbx.exists : 0;
      if (total === 0) return { messages: [], total: 0 };

      // 从最新的邮件开始拉取：计算 UID 范围
      const startSeq = Math.max(1, total - offset - limit + 1);
      const endSeq = Math.max(1, total - offset);
      const range = `${startSeq}:${endSeq}`;

      const messages: ImapMessageSummary[] = [];
      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      })) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0]
          ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim()
          : '';
        messages.push({
          uid: msg.uid,
          envelope: {
            subject: env?.subject ?? '(无主题)',
            from: fromAddr,
            to: (env?.to ?? []).map((a) => a.address ?? '').filter(Boolean),
            date: env?.date ? new Date(env.date).toISOString() : '',
            size: msg.size ?? 0,
          },
          flags: [...(msg.flags ?? [])].map(String),
          folder,
        });
      }

      // 按 UID 降序排列
      messages.sort((a, b) => b.uid - a.uid);
      return { messages, total };
    } finally {
      lock.release();
    }
  }

  /** 拉取邮件完整正文 */
  async fetchMessage(folder: string, uid: number): Promise<ImapMessageBody> {
    this.ensureConnected();
    const client = this.client!;

    const lock = await client.getMailboxLock(folder);
    try {
      // 关键：第 3 参数 options.uid=true 才表示首参按 UID 解释；
      // 第 2 参数 query 里的 uid:true 仅表示「结果中包含 UID」字段。
      // 此前误把 uid:true 放在 query 中，导致 UID 被当作序号解释（生产 bug：
      // UID 3628 被当作序号 3628，邮箱无此序号 → NOT_FOUND）。
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!msg) {
        throw new IpcError(IpcErrorCode.NOT_FOUND, `邮件不存在: UID ${uid}`, {});
      }

      const source =
        msg.source instanceof Buffer ? msg.source : Buffer.from(msg.source as Uint8Array);

      // 延迟加载 postal-mime（减少首屏开销）
      const { default: PostalMime } = await import('postal-mime');
      const parsed = await PostalMime.parse(source);

      return {
        uid,
        html: parsed.html ?? undefined,
        text: parsed.text ?? undefined,
        attachments: (parsed.attachments ?? []).map((a): MailAttachmentContent => {
          const content = a.content;
          const size = typeof content === 'string' ? content.length : (content?.byteLength ?? 0);
          // cid 内嵌图片重写需要附件内容；base64 化（string 内容按 utf-8 转）
          const contentBase64 =
            content === undefined
              ? undefined
              : typeof content === 'string'
                ? Buffer.from(content, 'utf-8').toString('base64')
                : Buffer.from(content as Uint8Array).toString('base64');
          return {
            filename: a.filename ?? 'unnamed',
            contentType: a.mimeType ?? 'application/octet-stream',
            size,
            contentId: a.contentId ?? undefined,
            contentBase64,
          };
        }),
      };
    } finally {
      lock.release();
    }
  }

  /** 标记邮件已读/未读 */
  async markRead(folder: string, uid: number, seen: boolean): Promise<void> {
    this.ensureConnected();
    const client = this.client!;

    const lock = await client.getMailboxLock(folder);
    try {
      if (seen) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  }

  /** NOOP 保活 + 连接存活检测（heartbeat 用） */
  async noop(): Promise<void> {
    this.ensureConnected();
    await this.client!.noop();
  }

  /** 增量拉取：只取 UID > sinceUid 的邮件信封（Phase 2 增量同步用） */
  async fetchSinceUid(folder: string, sinceUid: number): Promise<ImapMessageSummary[]> {
    this.ensureConnected();
    const client = this.client!;

    const lock = await client.getMailboxLock(folder);
    try {
      const range = `${sinceUid + 1}:*`;
      const messages: ImapMessageSummary[] = [];
      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, flags: true, size: true },
        { uid: true },
      )) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0]
          ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim()
          : '';
        messages.push({
          uid: msg.uid,
          envelope: {
            subject: env?.subject ?? '(无主题)',
            from: fromAddr,
            to: (env?.to ?? []).map((a) => a.address ?? '').filter(Boolean),
            date: env?.date ? new Date(env.date).toISOString() : '',
            size: msg.size ?? 0,
          },
          flags: [...(msg.flags ?? [])].map(String),
          folder,
        });
      }
      messages.sort((a, b) => b.uid - a.uid);
      return messages;
    } finally {
      lock.release();
    }
  }

  /**
   * 启动 IDLE 监听新邮件（返回停止函数）。
   *
   * imapflow 的 auto-IDLE 机制：连接空闲后自动进入 IDLE，
   * 新邮件到达时触发 'exists' 事件。无需手动 idle()/idleStop()。
   * 停止时移除监听器并调用 noop() 打断可能的 IDLE 状态。
   */
  startIdle(
    folder: string,
    onNewMessage: (uid: number, envelope: ImapEnvelope) => void,
  ): Promise<() => Promise<void>> {
    this.ensureConnected();
    const client = this.client!;

    const handler = (data: { path: string; count: number }) => {
      if (data.path !== folder) return;
      void (async () => {
        try {
          const msg = await client.fetchOne(String(data.count), {
            uid: true,
            envelope: true,
            size: true,
          });
          if (msg) {
            const env = msg.envelope;
            const fromAddr = env?.from?.[0]
              ? `${env.from[0].name ?? ''} <${env.from[0].address ?? ''}>`.trim()
              : '';
            onNewMessage(msg.uid, {
              subject: env?.subject ?? '(无主题)',
              from: fromAddr,
              to: (env?.to ?? []).map((a) => a.address ?? '').filter(Boolean),
              date: env?.date ? new Date(env.date).toISOString() : '',
              size: msg.size ?? 0,
            });
          }
        } catch {
          // IDLE 回调中的错误不传播
        }
      })();
    };

    client.on('exists', handler);

    return Promise.resolve(async () => {
      client.off('exists', handler);
      try {
        await client.noop();
      } catch {
        // noop 失败不抛出（清理操作）
      }
    });
  }

  private ensureConnected(): void {
    if (!this.client?.usable) {
      throw new IpcError(IpcErrorCode.STATE, 'IMAP 未连接', {});
    }
  }
}
