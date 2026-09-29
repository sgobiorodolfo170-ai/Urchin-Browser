/**
 * M25 邮箱模块 · 邮件详情视图（阅读器）
 *
 * 依据：用户反馈「排版不如 QQ 邮箱原生、功能单一」（2026-09-26）
 * 布局参考 Gmail / QQ 邮箱阅读器：
 *   主题（大标题）
 *   发件人卡片（头像 + 名称/地址 + 时间 + 收件人）
 *   操作工具栏（回复 / 转发 / 标记未读 / 删除——v0.2 接线，W1 仅展示态）
 *   正文（urchin://mail-content 协议路由渲染，独立 CSP）
 *   附件卡片列表
 */
import { useEffect, useState } from 'react';
import {
  Loader2,
  Mail,
  Reply,
  Forward,
  Trash2,
  MailOpen,
  Paperclip,
  Languages,
  AlertTriangle,
} from 'lucide-react';

interface MailMessageSummary {
  uid: number;
  envelope: {
    subject: string;
    from: string;
    to: string[];
    date: string;
    size: number;
  };
  flags: string[];
  folder: string;
}

interface MailMessageBody {
  uid: number;
  html?: string;
  text?: string;
  contentUrl?: string;
  attachments: { filename: string; contentType: string; size: number }[];
}

/** 邮件翻译结果（与 ipc-contract mailMessageTranslateResSchema 对齐） */
interface MailTranslateResult {
  contentUrl?: string;
  text?: string;
  detectedLang?: string;
  engine: 'microsoft' | 'google' | 'mymemory';
  targetLang: string;
}

/** 翻译状态机：idle → translating → done / error */
type TranslateState =
  | { status: 'idle' }
  | { status: 'translating' }
  | { status: 'done'; result: MailTranslateResult; showingTranslated: boolean }
  | { status: 'error'; message: string };

export interface MessageDetailProps {
  message: MailMessageSummary | null;
  body: MailMessageBody | null;
  loading: boolean;
  /** 当前账户 ID（翻译 IPC 需要） */
  accountId?: string;
}

function formatFullDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 从 "Name <addr@x.com>" 或裸地址提取显示名与地址 */
function parseAddress(raw: string): { name: string; addr: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);
  if (m?.[2]) {
    const name = m[1]?.trim();
    return { name: name === undefined || name === '' ? m[2] : name, addr: m[2] };
  }
  return { name: raw.trim(), addr: raw.trim() };
}

/** 头像背景色（按地址稳定取色） */
const AVATAR_COLORS = [
  'bg-red-500',
  'bg-blue-500',
  'bg-green-600',
  'bg-purple-500',
  'bg-orange-500',
  'bg-teal-500',
  'bg-pink-500',
  'bg-indigo-500',
] as const;

function avatarColor(addr: string): string {
  let hash = 0;
  for (let i = 0; i < addr.length; i++) {
    hash = (hash * 31 + addr.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function MessageDetail({ message, body, loading, accountId }: MessageDetailProps) {
  const [translate, setTranslate] = useState<TranslateState>({ status: 'idle' });

  // 切换邮件时重置翻译态
  useEffect(() => {
    setTranslate({ status: 'idle' });
  }, [message?.uid]);

  const handleTranslate = async () => {
    if (!message || !accountId) return;
    // done 态：原文/译文切换
    if (translate.status === 'done') {
      setTranslate({ ...translate, showingTranslated: !translate.showingTranslated });
      return;
    }
    setTranslate({ status: 'translating' });
    try {
      const result = (await window.urchin.invoke('mail.message.translate', {
        accountId,
        folder: message.folder,
        uid: message.uid,
      })) as MailTranslateResult;
      setTranslate({ status: 'done', result, showingTranslated: true });
    } catch (e) {
      setTranslate({
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (!message) {
    return (
      <div className="flex flex-1 items-center justify-center text-text-secondary">
        <div className="flex flex-col items-center">
          <Mail className="mb-2 h-10 w-10" />
          <span className="text-sm">选择一封邮件查看</span>
        </div>
      </div>
    );
  }

  const sender = parseAddress(message.envelope.from);

  // 译文态显示内容：done + showingTranslated 时用译文 URL/文本
  const showTranslated = translate.status === 'done' && translate.showingTranslated;
  const displayContentUrl = showTranslated ? translate.result.contentUrl : body?.contentUrl;
  const displayText = showTranslated ? translate.result.text : body?.text;

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface">
      {/* 主题 + 操作工具栏 */}
      <div className="shrink-0 border-b border-border px-6 pt-4 pb-3">
        <h2 className="mb-3 text-lg font-semibold leading-snug text-text">
          {message.envelope.subject || '(无主题)'}
        </h2>

        {/* 发件人卡片 */}
        <div className="flex items-start gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${avatarColor(sender.addr)}`}
          >
            {sender.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium text-text">{sender.name}</span>
              <span className="truncate text-xs text-text-secondary">&lt;{sender.addr}&gt;</span>
            </div>
            <div className="mt-0.5 text-xs text-text-secondary">
              发送至 {message.envelope.to.join('、') || '我'}
            </div>
            <div className="mt-0.5 text-xs text-text-secondary">
              {formatFullDate(message.envelope.date)}
            </div>
          </div>
          {/* 操作按钮（回复/转发/删除 W2 接线；翻译已启用） */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs ${
                translate.status === 'done' && translate.showingTranslated
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                  : 'text-text-secondary hover:bg-surface-secondary hover:text-text'
              } disabled:opacity-50`}
              onClick={() => void handleTranslate()}
              disabled={translate.status === 'translating' || !accountId}
              title={
                translate.status === 'done'
                  ? translate.showingTranslated
                    ? '查看原文'
                    : '查看译文'
                  : '翻译此邮件（中英互译）'
              }
            >
              {translate.status === 'translating' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Languages className="h-4 w-4" />
              )}
              {translate.status === 'done'
                ? translate.showingTranslated
                  ? '原文'
                  : '译文'
                : translate.status === 'translating'
                  ? '翻译中'
                  : '翻译'}
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
              title="回复（v0.2）"
              disabled
            >
              <Reply className="h-4 w-4" />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
              title="转发（v0.2）"
              disabled
            >
              <Forward className="h-4 w-4" />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
              title="标记未读（v0.2）"
              disabled
            >
              <MailOpen className="h-4 w-4" />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-red-500"
              title="删除（v0.2）"
              disabled
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 翻译状态行：成功徽标 / 错误提示 */}
        {translate.status === 'done' && translate.showingTranslated && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
            <Languages className="h-3.5 w-3.5" />
            已翻译为 {translate.result.targetLang === 'zh-CN' ? '中文' : '英文'}
            {translate.result.detectedLang
              ? `（检测源语言：${translate.result.detectedLang}）`
              : ''}
            · {translate.result.engine === 'google' ? 'Google' : 'Microsoft'}
          </div>
        )}
        {translate.status === 'error' && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            翻译失败：{translate.message}
          </div>
        )}
      </div>

      {/* 正文 */}
      <div className="flex-1 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
          </div>
        )}
        {!loading && body && (
          <>
            {displayContentUrl ? (
              /* HTML 正文：经 urchin://mail-content 协议路由加载（独立 CSP 放行图片/样式）。
               * sandbox 无 allow-scripts/allow-forms——脚本与表单在浏览器层被阻断，
               * 与主进程 mail-html.ts 的剥离构成纵深防御。
               * 译文态时 src 切到译文 contentUrl（同协议、同净化链路）。 */
              <iframe
                key={displayContentUrl}
                title="邮件内容"
                src={displayContentUrl}
                sandbox=""
                className="h-full w-full border-0 bg-white"
              />
            ) : displayText ? (
              <div className="h-full overflow-y-auto px-6 py-4">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">
                  {displayText}
                </pre>
              </div>
            ) : (
              <div className="px-6 py-4 text-sm text-text-secondary">（无正文内容）</div>
            )}
          </>
        )}
      </div>

      {/* 附件卡片 */}
      {!loading && body && body.attachments.length > 0 && (
        <div className="shrink-0 border-t border-border px-6 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
            <Paperclip className="h-3.5 w-3.5" />
            {body.attachments.length} 个附件
          </div>
          <div className="flex flex-wrap gap-2">
            {body.attachments.map((a, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-md border border-border bg-surface-secondary/50 px-3 py-1.5 text-sm"
              >
                <span className="max-w-48 truncate text-text">{a.filename}</span>
                <span className="shrink-0 text-xs text-text-secondary">{formatSize(a.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
