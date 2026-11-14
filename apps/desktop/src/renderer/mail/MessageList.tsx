import { Loader2, MailOpen } from 'lucide-react';

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

export interface MessageListProps {
  messages: MailMessageSummary[];
  total: number;
  folderName?: string;
  selectedUid: number | null;
  onSelect: (msg: MailMessageSummary) => void;
  loading: boolean;
  /** 栏宽（px）：由 MailView 的可拖拽分割线控制；不传时回退默认 284（原 w-72） */
  width?: number;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
}

function isUnread(flags: string[]): boolean {
  return !flags.includes('\\Seen');
}

export function MessageList({
  messages,
  total,
  folderName = '收件箱',
  selectedUid,
  onSelect,
  loading,
  width,
}: MessageListProps) {
  return (
    <div
      className="flex min-h-0 min-w-0 shrink-0 flex-col bg-surface"
      style={{ width: width ?? 284 }}
      data-testid="mail-message-list"
    >
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 text-sm font-semibold text-text">
        <span className="truncate">{folderName}</span>
        <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-xs font-normal tabular-nums text-text-secondary">
          {total}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-16 text-text-secondary">
            <MailOpen className="mb-2 h-8 w-8" />
            <span className="text-sm">此文件夹暂无邮件</span>
          </div>
        )}
        {messages.map((msg) => {
          const unread = isUnread(msg.flags);
          const selected = msg.uid === selectedUid;
          return (
            <button
              key={msg.uid}
              className={`mb-1 flex w-full min-w-0 flex-col gap-2 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                selected
                  ? 'border-blue-500/30 bg-blue-500/10'
                  : 'border-transparent hover:bg-surface-secondary/70'
              }`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(msg)}
            >
              <div className="flex w-full min-w-0 items-center gap-2">
                {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
                <span
                  className={`flex-1 truncate text-sm ${
                    unread ? 'font-semibold text-text' : 'text-text'
                  }`}
                >
                  {msg.envelope.from || '(未知发件人)'}
                </span>
                <span className="shrink-0 text-xs text-text-secondary">
                  {formatDate(msg.envelope.date)}
                </span>
              </div>
              <div
                title={msg.envelope.subject}
                className={`w-full truncate text-sm ${unread ? 'text-text' : 'text-text-secondary'}`}
              >
                {msg.envelope.subject || '(无主题)'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
