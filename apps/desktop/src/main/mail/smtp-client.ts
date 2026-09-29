/**
 * M25 邮箱模块 · SMTP 客户端封装（nodemailer）
 *
 * 依据：ADR-010 ML1 / 邮箱模块功能规划 W2
 * 职责：
 * 1. 创建 SMTP transport（按账户配置）
 * 2. 发送邮件（to/cc/bcc/subject/text/html）
 * 3. 将 nodemailer 错误装箱为 IpcError
 *
 * 进程归属：主进程（nodemailer 使用 Node net/tls，不可在渲染进程运行）
 */
import { createTransport, type Transporter } from 'nodemailer';
import { IpcError, IpcErrorCode } from '@urchin/ipc-contract';

/** SMTP 连接配置 */
export interface SmtpConnectionConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface SendMailParams {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  attachments?: {
    filename: string;
    contentType?: string;
    contentBase64: string;
  }[];
}

/**
 * SmtpClient 封装 nodemailer Transporter。
 *
 * 设计理由：transport 为短连接（发完即关），不需要像 IMAP 那样保活——
 * 发信是低频操作，每次创建 transport 的开销可接受。
 */
export class SmtpClient {
  private transporter: Transporter | null = null;

  /** 创建并验证 SMTP transport */
  async connect(config: SmtpConnectionConfig): Promise<void> {
    try {
      this.transporter = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.auth.user,
          pass: config.auth.pass,
        },
      });
      await this.transporter.verify();
    } catch (err) {
      this.transporter = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('auth') || msg.includes('EAUTH') || msg.includes('Invalid login')) {
        throw new IpcError(IpcErrorCode.PERMISSION, `SMTP 认证失败: ${msg}`, {});
      }
      throw new IpcError(IpcErrorCode.UNAVAILABLE, `SMTP 连接失败: ${msg}`, {
        retryable: true,
      });
    }
  }

  /** 发送邮件 */
  async sendMail(params: SendMailParams): Promise<string> {
    if (!this.transporter) {
      throw new IpcError(IpcErrorCode.STATE, 'SMTP 未连接', {});
    }
    try {
      const info = (await this.transporter.sendMail({
        from: params.from,
        to: params.to.join(', '),
        cc: params.cc?.join(', '),
        bcc: params.bcc?.join(', '),
        subject: params.subject,
        text: params.text,
        html: params.html,
        inReplyTo: params.inReplyTo,
        attachments: params.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.contentBase64, 'base64'),
        })),
      })) as { messageId: string };
      return info.messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new IpcError(IpcErrorCode.INTERNAL, `邮件发送失败: ${msg}`, {});
    }
  }

  /** 关闭 transport */
  disconnect(): void {
    if (!this.transporter) return;
    try {
      this.transporter.close();
    } catch {
      // 清理操作，忽略错误
    } finally {
      this.transporter = null;
    }
  }
}
