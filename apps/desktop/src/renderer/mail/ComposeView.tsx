/**
 * M25 邮箱模块 · 撰写邮件视图（弹性布局 + 附件）
 *
 * 依据：用户反馈「排版偏居一角、未照顾窗口大小变化、需要附件功能」（2026-09-29）
 * 布局：flex column 撑满父容器——头部固定 / 表单字段紧凑 / 附件列表 / 正文 flex-1 自动撑满 / 底部固定
 */
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Loader2, Send, X, ChevronDown, ChevronUp, Paperclip, FileText } from 'lucide-react';

interface AttachmentItem {
  filename: string;
  contentType: string;
  contentBase64: string;
  size: number;
}

export interface ComposeViewProps {
  accountId: string;
  fromEmail: string;
  defaultTo?: string;
  defaultSubject?: string;
  defaultText?: string;
  inReplyToUid?: number;
  onSent: () => void;
  onCancel: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ComposeView({
  accountId,
  fromEmail,
  defaultTo,
  defaultSubject,
  defaultText,
  inReplyToUid,
  onSent,
  onCancel,
}: ComposeViewProps) {
  const [to, setTo] = useState(defaultTo ?? '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(defaultSubject ?? '');
  const [body, setBody] = useState(defaultText ?? '');
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleAddAttachment = async () => {
    try {
      const res = (await window.urchin.invoke('mail.attachment.select', {})) as {
        attachments: AttachmentItem[];
      };
      if (res.attachments.length > 0) {
        setAttachments((prev) => [...prev, ...res.attachments]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSend = async () => {
    const toList = to.split(/[,;\s]+/).filter(Boolean);
    if (toList.length === 0) {
      setError('请输入收件人');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await window.urchin.invoke('mail.message.send', {
        accountId,
        to: toList,
        cc: cc ? cc.split(/[,;\s]+/).filter(Boolean) : undefined,
        subject: subject || '(无主题)',
        text: body,
        inReplyToUid,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      setSuccess(true);
      setTimeout(() => onSent(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const compactInputClass =
    'w-full bg-transparent text-sm text-text placeholder:text-text-secondary focus:outline-none';
  const labelClass = 'mr-2 shrink-0 text-xs font-medium text-text-secondary w-16 text-right';

  if (success) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-2 text-green-600 dark:text-green-400">
          <Send className="h-8 w-8" />
          <span className="text-sm">邮件已发送</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="flex-1 text-sm font-semibold text-text">写邮件</h2>
        <span className="text-xs text-text-secondary">发件人：{fromEmail}</span>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onCancel}
          title="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 收件人/抄送/主题——紧凑行内布局 */}
      <div className="shrink-0 space-y-0 border-b border-border">
        {/* 收件人 */}
        <div className="flex items-center border-b border-border/50 px-4">
          <label className={labelClass}>收件人</label>
          <input
            className={compactInputClass + ' py-2'}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="多个收件人用逗号分隔"
          />
        </div>
        {/* 抄送（可折叠） */}
        {showCc ? (
          <div className="flex items-center border-b border-border/50 px-4">
            <label className={labelClass}>
              <button
                className="text-text-secondary hover:text-text"
                onClick={() => {
                  setShowCc(false);
                  setCc('');
                }}
              >
                <ChevronUp className="inline h-3 w-3" />
                抄送
              </button>
            </label>
            <input
              className={compactInputClass + ' py-2'}
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="多个抄送人用逗号分隔"
            />
          </div>
        ) : (
          <div className="px-4 py-1">
            <button
              className="text-xs text-text-secondary hover:text-text"
              onClick={() => setShowCc(true)}
            >
              <ChevronDown className="mr-1 inline h-3 w-3" />
              添加抄送
            </button>
          </div>
        )}
        {/* 主题 */}
        <div className="flex items-center px-4">
          <label className={labelClass}>主题</label>
          <input
            className={compactInputClass + ' py-2'}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="邮件主题"
          />
        </div>
      </div>

      {/* 附件列表 */}
      {attachments.length > 0 && (
        <div className="shrink-0 border-b border-border px-4 py-2">
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-md border border-border bg-surface-secondary/50 px-2 py-1 text-xs"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                <span className="max-w-40 truncate text-text">{a.filename}</span>
                <span className="shrink-0 text-text-secondary">{formatSize(a.size)}</span>
                <button
                  className="shrink-0 text-text-secondary hover:text-red-500"
                  onClick={() => handleRemoveAttachment(i)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 正文——flex-1 撑满剩余空间 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <textarea
          className="flex-1 resize-none border-0 bg-surface px-4 py-3 font-sans text-sm leading-relaxed text-text placeholder:text-text-secondary focus:outline-none"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="邮件正文..."
        />
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleAddAttachment()}
          disabled={sending}
        >
          <Paperclip className="mr-1 h-4 w-4" />
          附件
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSend()}
          disabled={sending || !to}
        >
          {sending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-1 h-4 w-4" />
          )}
          {sending ? '发送中...' : '发送'}
        </Button>
      </div>
    </div>
  );
}
