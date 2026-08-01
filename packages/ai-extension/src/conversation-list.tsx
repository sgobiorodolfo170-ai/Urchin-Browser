/**
 * 会话记录列表组件（AI 模块左区）
 *
 * 从 apps/desktop 迁移至 ai-extension，逻辑保持一致。
 */
import { useCallback } from 'react';
import { Trash2, MessageSquare, Plus } from 'lucide-react';
import { useAiConversationStore, type Conversation } from './stores/ai-conversation';
import { cn } from './lib/utils';

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)}分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)}小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function getConversationTitle(conv: Conversation): string {
  const firstUserMsg = conv.messages.find((m) => m.role === 'user');
  if (firstUserMsg) {
    const text = firstUserMsg.content.trim();
    return text.length > 40 ? text.slice(0, 40) + '…' : text;
  }
  return '新对话';
}

interface ConversationListProps {
  readonly onNewChat?: () => void;
}

export function ConversationList({ onNewChat }: ConversationListProps) {
  const conversations = useAiConversationStore((s) => s.conversations);
  const activeConversationId = useAiConversationStore((s) => s.activeConversationId);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- zustand store 方法
  const setActiveConversation = useAiConversationStore((s) => s.setActiveConversation);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- zustand store 方法
  const removeConversation = useAiConversationStore((s) => s.removeConversation);

  const conversationList = Array.from(conversations.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );

  const handleSelect = useCallback(
    (id: string) => {
      setActiveConversation(id);
    },
    [setActiveConversation],
  );

  const handleDelete = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      removeConversation(id);
    },
    [removeConversation],
  );

  if (conversationList.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex-1 flex flex-col items-center justify-center text-center text-text-secondary p-4">
          <MessageSquare className="mb-2 h-8 w-8 opacity-40" />
          <p className="text-sm">暂无会话记录</p>
          <p className="mt-1 text-xs">开始对话后将显示在这里</p>
        </div>
        {onNewChat && (
          <div className="shrink-0 border-t border-border p-2">
            <button
              className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-sm text-text-secondary hover:bg-surface hover:text-text"
              onClick={onNewChat}
            >
              <Plus className="h-4 w-4" />
              新建对话
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2">
        {conversationList.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              'group mb-1 flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm',
              conv.id === activeConversationId
                ? 'bg-surface text-text shadow-sm'
                : 'text-text-secondary hover:bg-surface hover:text-text',
            )}
            onClick={() => handleSelect(conv.id)}
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate">{getConversationTitle(conv)}</div>
              <div className="text-xs text-text-secondary truncate">
                {conv.messages.length} 条消息 · {formatTime(conv.updatedAt)}
              </div>
            </div>
            <button
              className="shrink-0 rounded p-0.5 opacity-0 hover:bg-surface-secondary group-hover:opacity-100"
              onClick={(e) => handleDelete(conv.id, e)}
              aria-label="删除会话"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {onNewChat && (
        <div className="shrink-0 border-t border-border p-2">
          <button
            className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-sm text-text-secondary hover:bg-surface hover:text-text"
            onClick={onNewChat}
          >
            <Plus className="h-4 w-4" />
            新建对话
          </button>
        </div>
      )}
    </div>
  );
}
