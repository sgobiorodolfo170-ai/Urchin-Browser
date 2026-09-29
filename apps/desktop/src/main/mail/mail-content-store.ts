/**
 * M25 邮箱模块 · 邮件正文内容存储（主进程，内存态）
 *
 * 依据：用户反馈「邮件图片无法显示、格式丢失」（2026-09-25）
 * 职责：为 urchin://mail-content/<token> 协议路由提供 HTML 内容存取。
 *
 * 设计理由：
 * - 邮件 HTML 经协议路由以独立 CSP 下发（与主窗口 CSP 解耦），需要一个
 *   token → html 的暂存处；内存态 + TTL，不落盘（邮件正文属隐私数据，
 *   §六 隐私审查点：不落不必要的持久化）。
 * - token 为 UUID，不可枚举；过期自动清理。
 */
import { randomUUID } from 'node:crypto';

/** 默认内容有效期：10 分钟（阅读窗口足够，过期后重新 fetch 即可） */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 单次 sweep 的最大容量上限（防爆内存：超过则全量清理过期项） */
const MAX_ENTRIES = 200;

interface ContentEntry {
  html: string;
  expiresAt: number;
}

export class MailContentStore {
  private readonly entries = new Map<string, ContentEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** 存入 HTML，返回 token */
  put(html: string): string {
    if (this.entries.size >= MAX_ENTRIES) {
      this.sweep();
    }
    const token = randomUUID();
    this.entries.set(token, { html, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** 取 HTML（过期即删并返回 null） */
  get(token: string): string | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(token);
      return null;
    }
    return entry.html;
  }

  /** 清理过期项 */
  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(token);
      }
    }
  }

  /** 当前条目数（测试用） */
  get size(): number {
    return this.entries.size;
  }
}
