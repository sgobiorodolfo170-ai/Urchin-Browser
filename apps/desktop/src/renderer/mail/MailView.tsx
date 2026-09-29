/**
 * M25 邮箱模块 · 主视图（urchin://mail 标签页内容）
 *
 * 依据：ADR-010 ML4 / 邮箱模块功能规划 §5
 * 职责：邮箱标签页的主入口组件，根据状态渲染：
 *   无账户 → 账户配置表单
 *   有账户 → 文件夹列表 + 邮件列表 + 邮件详情
 *
 * 主题：使用 M19 令牌（bg-surface / text-text / border-border 等 Tailwind class）
 * 入口：左侧栏「邮箱」按钮 → 创建/激活 urchin://mail 标签页
 */
import { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw, AlertTriangle, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { AccountSetup } from './AccountSetup';
import { FolderList } from './FolderList';
import { MessageList } from './MessageList';
import { MessageDetail } from './MessageDetail';
import { ComposeView } from './ComposeView';

interface MailAccount {
  id: string;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  createdAt: number;
}

interface MailFolder {
  path: string;
  name: string;
  delimiter: string;
  flags: string[];
  exists: number;
  unseen: number;
}

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
  attachments: { filename: string; contentType: string; size: number }[];
}

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export function MailView() {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  const [selectedAccount, setSelectedAccount] = useState<MailAccount | null>(null);
  const [folders, setFolders] = useState<MailFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('INBOX');
  const [loadingFolders, setLoadingFolders] = useState(false);

  const [messages, setMessages] = useState<MailMessageSummary[]>([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [selectedMessage, setSelectedMessage] = useState<MailMessageSummary | null>(null);
  const [messageBody, setMessageBody] = useState<MailMessageBody | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  const [connStatus, setConnStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showAccountSetup, setShowAccountSetup] = useState(false);
  /** 后台同步中（cache 已返回但 IMAP 增量同步未完成） */
  const [syncing, setSyncing] = useState(false);
  /** 撰写邮件状态 */
  const [composing, setComposing] = useState(false);
  const [composeData, setComposeData] = useState<{
    defaultTo?: string;
    defaultSubject?: string;
    defaultText?: string;
    inReplyToUid?: number;
  }>({});

  // ────────────── 账户加载 ──────────────

  const refreshAccounts = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('mail.account.list', {})) as {
        accounts: MailAccount[];
      };
      setAccounts(res.accounts);
      if (res.accounts.length > 0 && !selectedAccount) {
        setSelectedAccount(res.accounts[0]!);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAccounts(false);
    }
  }, [selectedAccount]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  // ────────────── 文件夹加载 ──────────────

  const loadFolders = useCallback(async (accountId: string) => {
    setError(null);
    try {
      const res = (await window.urchin.invoke('mail.folder.list', { accountId })) as {
        folders: MailFolder[];
        fromCache: boolean;
      };
      setFolders(res.folders);
      if (res.fromCache) {
        setConnStatus('connected');
        setSyncing(true);
      } else {
        setConnStatus('connecting');
        setSyncing(false);
      }
    } catch (e) {
      setConnStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAccount) {
      void loadFolders(selectedAccount.id);
    }
  }, [selectedAccount, loadFolders]);

  // ────────────── 邮件列表加载 ──────────────

  const loadMessages = useCallback(async (accountId: string, folder: string) => {
    setError(null);
    try {
      const res = (await window.urchin.invoke('mail.message.list', {
        accountId,
        folder,
        limit: 50,
        offset: 0,
      })) as { messages: MailMessageSummary[]; total: number; fromCache: boolean };
      setMessages(res.messages);
      setMessageTotal(res.total);
      if (res.fromCache) {
        setSyncing(true);
      } else {
        setSyncing(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (selectedAccount && selectedFolder) {
      void loadMessages(selectedAccount.id, selectedFolder);
    }
  }, [selectedAccount, selectedFolder, loadMessages]);

  // ────────────── 邮件正文加载 ──────────────

  const openMessage = useCallback(
    async (msg: MailMessageSummary) => {
      if (!selectedAccount) return;
      setSelectedMessage(msg);
      setMessageBody(null);
      setLoadingBody(true);
      try {
        const body = (await window.urchin.invoke('mail.message.fetch', {
          accountId: selectedAccount.id,
          folder: msg.folder,
          uid: msg.uid,
        })) as MailMessageBody;
        setMessageBody(body);

        // 标记已读（如果未读）
        if (!msg.flags.includes('\\Seen')) {
          try {
            await window.urchin.invoke('mail.message.markRead', {
              accountId: selectedAccount.id,
              folder: msg.folder,
              uid: msg.uid,
              seen: true,
            });
            setMessages((prev) =>
              prev.map((m) => (m.uid === msg.uid ? { ...m, flags: [...m.flags, '\\Seen'] } : m)),
            );
          } catch {
            // 标记已读失败不影响阅读
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingBody(false);
      }
    },
    [selectedAccount],
  );

  // ────────────── 新邮件事件监听 ──────────────

  useEffect(() => {
    const handler = (data: unknown) => {
      const evt = data as { accountId: string; folder: string; uid: number };
      if (selectedAccount?.id === evt.accountId && evt.folder === selectedFolder) {
        void loadMessages(selectedAccount.id, selectedFolder);
      }
    };
    const foldersHandler = (data: unknown) => {
      const evt = data as { accountId: string };
      if (selectedAccount?.id === evt.accountId) {
        void loadFolders(selectedAccount.id);
      }
    };
    window.addEventListener('mail.event.newMessage', handler);
    window.addEventListener('mail.event.foldersUpdated', foldersHandler);
    return () => {
      window.removeEventListener('mail.event.newMessage', handler);
      window.removeEventListener('mail.event.foldersUpdated', foldersHandler);
    };
  }, [selectedAccount, selectedFolder, loadMessages, loadFolders]);

  // ────────────── 渲染 ──────────────

  if (loadingAccounts) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
      </div>
    );
  }

  if (showAccountSetup || accounts.length === 0) {
    return (
      <div className="flex h-full flex-col bg-surface">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-text-secondary" />
            <h1 className="text-base font-semibold text-text">邮箱设置</h1>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <AccountSetup
            onSaved={() => {
              setShowAccountSetup(false);
              void refreshAccounts();
            }}
            onCancel={() => setShowAccountSetup(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* 顶栏：账户选择 + 刷新 + 设置 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <select
          className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
          value={selectedAccount?.id ?? ''}
          onChange={(e) => {
            const acc = accounts.find((a) => a.id === e.target.value);
            if (acc) setSelectedAccount(acc);
          }}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.email})
            </option>
          ))}
        </select>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={() => {
            if (selectedAccount) {
              void loadFolders(selectedAccount.id);
              void loadMessages(selectedAccount.id, selectedFolder);
            }
          }}
          title="刷新"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        {syncing && (
          <Loader2 className="h-4 w-4 animate-spin text-text-secondary" aria-label="后台同步中" />
        )}
        {connStatus === 'connecting' && !syncing && (
          <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
        )}
        {connStatus === 'error' && <AlertTriangle className="h-4 w-4 text-red-500" />}
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={() => setShowAccountSetup(true)}
          title="添加账户"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* 三栏布局：文件夹 | 邮件列表 | 邮件详情 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左：文件夹列表 */}
        <FolderList
          folders={folders}
          selectedFolder={selectedFolder}
          onSelect={setSelectedFolder}
          loading={loadingFolders}
          onCompose={() => {
            setComposeData({});
            setComposing(true);
          }}
        />

        {/* 中：邮件列表 */}
        <MessageList
          messages={messages}
          total={messageTotal}
          selectedUid={selectedMessage?.uid ?? null}
          onSelect={(msg) => void openMessage(msg)}
          loading={loadingMessages}
        />

        {/* 右：邮件详情 / 撰写邮件 */}
        {composing && selectedAccount ? (
          <ComposeView
            accountId={selectedAccount.id}
            fromEmail={selectedAccount.email}
            defaultTo={composeData.defaultTo}
            defaultSubject={composeData.defaultSubject}
            defaultText={composeData.defaultText}
            inReplyToUid={composeData.inReplyToUid}
            onSent={() => {
              setComposing(false);
              setComposeData({});
            }}
            onCancel={() => {
              setComposing(false);
              setComposeData({});
            }}
          />
        ) : (
          <MessageDetail
            message={selectedMessage}
            body={messageBody}
            loading={loadingBody}
            accountId={selectedAccount?.id}
          />
        )}
      </div>
    </div>
  );
}
