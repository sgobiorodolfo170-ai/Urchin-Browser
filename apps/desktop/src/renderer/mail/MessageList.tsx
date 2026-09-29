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
  selectedUid: number | null;
  onSelect: (msg: MailMessageSummary) => void;
  loading: boolean;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
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

export function MessageList({ messages, total, selectedUid, onSelect, loading }: MessageListProps) {
  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-border">
      <div className="shrink-0 border-b border-border px-3 py-2 text-xs font-semibold uppercase text-text-secondary">
        收件箱 ({total})
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-text-secondary">
            <MailOpen className="mb-2 h-8 w-8" />
            <span className="text-sm">无邮件</span>
          </div>
        )}
        {messages.map((msg) => {
          const unread = isUnread(msg.flags);
          const selected = msg.uid === selectedUid;
          return (
            <button
              key={msg.uid}
              className={`flex w-full flex-col gap-0.5 border-b border-border/50 px-3 py-2 text-left ${
                selected ? 'bg-surface-secondary' : 'hover:bg-surface-secondary/50'
              }`}
              onClick={() => onSelect(msg)}
            >
              <div className="flex items-center gap-2">
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
              <div className={`truncate text-sm ${unread ? 'text-text' : 'text-text-secondary'}`}>
                {msg.envelope.subject || '(无主题)'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
