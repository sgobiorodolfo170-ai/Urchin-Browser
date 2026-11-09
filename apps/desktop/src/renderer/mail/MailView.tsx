/**
 * M25 邮箱模块 · 主视图（urchin://mail 标签页内容）
 *
 * 依据：ADR-010 ML4 / 邮箱模块功能规划 §5
 * 职责：邮箱标签页的主入口组件，根据状态渲染：
 *   无账户 → 账户配置表单
 *   有账户 → 文件夹列表 + 邮件列表 + 邮件详情（三区 grid 布局）
 *
 * 三区布局：左（文件夹）/ 中（邮件列表）为可拖拽像素宽度，右（详情/写邮件）
 * 始终铺满余量；两条分割线可拖拽，拖拽结束写入 settings 键 mail.state
 * （同 notebook.state 机制），重启恢复。本页不参与内容区 Ctrl+滚轮缩放
 * （见 ContentArea），避免三区随缩放错位。
 *
 * 主题：使用 M19 令牌（bg-surface / text-text / border-border 等 Tailwind class）
 * 入口：左侧栏「邮箱」按钮 → 创建/激活 urchin://mail 标签页
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Mail,
  RefreshCw,
  AlertTriangle,
  Loader2,
  Settings as SettingsIcon,
  KeyRound,
} from 'lucide-react';
import { AccountSetup } from './AccountSetup';
import { FolderList } from './FolderList';
import { MessageList } from './MessageList';
import { MessageDetail } from './MessageDetail';
import { ComposeView } from './ComposeView';
import { cn } from '../lib/utils';
import {
  MAIL_STATE_KEY,
  SPLITTER_WIDTH,
  buildMailState,
  resizeFolderWidth,
  resizeListWidth,
  restoreWidths,
} from './layout';

interface MailAccount {
  id: string;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  createdAt: number;
  /** 密码密文是否存在（false = 密文丢失，需重授权；2026-11-10） */
  hasPassword: boolean;
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

  // ────────────── 重授权（密码密文丢失，2026-11-10） ──────────────

  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthSaving, setReauthSaving] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  // ────────────── 三区布局（可拖拽分割线 + 持久化） ──────────────

  /** 三区 grid 容器引用与实测宽度（拖拽上限按容器宽度收敛） */
  const threePaneRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  /** 持久化原始值（未加载 = null → restoreWidths 回退默认宽） */
  const [persisted, setPersisted] = useState<unknown>(null);
  /** 拖拽中的实时宽度（null = 未拖拽，用持久化/默认值） */
  const [live, setLive] = useState<{ folderWidth: number; listWidth: number } | null>(null);
  const [dragging, setDragging] = useState<'folder' | 'list' | null>(null);
  const dragRef = useRef<{
    kind: 'folder' | 'list';
    startX: number;
    startFolder: number;
    startList: number;
  } | null>(null);

  // 加载持久化宽度（一次性；失败静默回退默认）
  useEffect(() => {
    let alive = true;
    void (
      window.urchin.invoke('settings.get', { key: MAIL_STATE_KEY }) as Promise<{
        value?: unknown;
      }>
    )
      .then((res) => {
        if (alive) setPersisted(res?.value ?? null);
      })
      .catch((error: unknown) => {
        console.error('Failed to load mail layout:', error);
      });
    return () => {
      alive = false;
    };
  }, []);

  const showThreePane = !loadingAccounts && !showAccountSetup && accounts.length > 0;

  // 测量三区容器宽度（窗口缩放跟随；showThreePane 变化时 grid 才挂载，需重跑）
  useLayoutEffect(() => {
    if (!showThreePane) return undefined;
    const element = threePaneRef.current;
    if (!element) return undefined;
    const measure = (): void => {
      const w = element.getBoundingClientRect().width;
      if (w > 0) setContainerWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [showThreePane]);

  const persistWidths = useCallback((w: { folderWidth: number; listWidth: number }) => {
    void window.urchin
      .invoke('settings.set', {
        key: MAIL_STATE_KEY,
        value: buildMailState(w.folderWidth, w.listWidth),
      })
      .catch((error: unknown) => {
        console.error('Failed to persist mail layout:', error);
      });
  }, []);

  const startResize = (kind: 'folder' | 'list', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const base = live ?? restoreWidths(persisted, containerWidth);
    dragRef.current = {
      kind,
      startX: event.clientX,
      startFolder: base.folderWidth,
      startList: base.listWidth,
    };
    setDragging(kind);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const next =
      drag.kind === 'folder'
        ? resizeFolderWidth(drag.startFolder, drag.startList, delta, containerWidth)
        : resizeListWidth(drag.startFolder, drag.startList, delta, containerWidth);
    setLive(next);
  };

  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (live) persistWidths(live);
    setLive(null);
    setDragging(null);
  };

  const splitterProps = (kind: 'folder' | 'list', label: string) => ({
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': label,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => startResize(kind, e),
    onPointerMove: moveResize,
    onPointerUp: endResize,
    onPointerCancel: endResize,
  });

  // ────────────── 账户加载 ──────────────

  const refreshAccounts = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('mail.account.list', {})) as {
        accounts: MailAccount[];
      };
      setAccounts(res.accounts);
      // 选中态同步：保持当前选择（按 id 映射到新列表，刷新 hasPassword 等字段）；
      // 无选择时回落首个账户。首次加载后 hasPassword 变化不再依赖此回调重建。
      if (res.accounts.length > 0) {
        setSelectedAccount((prev) => {
          if (!prev) return res.accounts[0]!;
          return res.accounts.find((a) => a.id === prev.id) ?? res.accounts[0]!;
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  // ────────────── 重授权提交（密码密文丢失时） ──────────────

  const handleReauthSave = useCallback(async () => {
    if (!selectedAccount || !reauthPassword) return;
    setReauthSaving(true);
    setReauthError(null);
    try {
      await window.urchin.invoke('mail.account.setPassword', {
        accountId: selectedAccount.id,
        password: reauthPassword,
      });
      setReauthPassword('');
      // 刷新账户列表 → hasPassword 变 true → 重授权卡片消失，
      // selectedAccount 引用更新触发文件夹加载（重连 IMAP）
      await refreshAccounts();
    } catch (e) {
      setReauthError(e instanceof Error ? e.message : String(e));
    } finally {
      setReauthSaving(false);
    }
  }, [selectedAccount, reauthPassword, refreshAccounts]);

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
    // 密码缺失时不发起连接（会报 账户密码缺失），先展示重授权卡片
    if (selectedAccount?.hasPassword) {
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
    if (selectedAccount && selectedAccount.hasPassword && selectedFolder) {
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

  // 密码密文缺失 → 重授权卡片（顶栏保留可切换/添加账户；2026-11-10）
  if (selectedAccount && !selectedAccount.hasPassword) {
    return (
      <div className="flex h-full flex-col bg-surface">
        {/* 顶栏（与主视图一致）：账户选择 + 刷新 + 设置 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <select
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
            value={selectedAccount.id}
            onChange={(e) => {
              const acc = accounts.find((a) => a.id === e.target.value);
              if (acc) setSelectedAccount(acc);
            }}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.email}){!a.hasPassword ? ' — 需重新登录' : ''}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
            onClick={() => setShowAccountSetup(true)}
            title="添加账户"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5">
            <div className="mb-1 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-text-secondary" />
              <h2 className="text-sm font-semibold text-text">
                需要重新登录「{selectedAccount.name}」
              </h2>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-text-secondary">
              该账户的密码凭据已丢失（可能因卸载重装或数据目录迁移）。请输入 {selectedAccount.email}{' '}
              的 IMAP 密码 （QQ 邮箱请填写「授权码」，在 QQ 邮箱网页版 设置 → 账号 中生成，不是 QQ
              密码）。
            </p>
            <input
              type="password"
              className="mb-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-secondary focus:outline-none"
              value={reauthPassword}
              onChange={(e) => setReauthPassword(e.target.value)}
              placeholder="IMAP 密码 / 授权码"
              aria-label="IMAP 密码 / 授权码"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && reauthPassword) void handleReauthSave();
              }}
            />
            {reauthError && (
              <p className="mb-2 text-xs text-red-600 dark:text-red-400">{reauthError}</p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-secondary hover:text-text"
                onClick={() => {
                  setReauthPassword('');
                  setReauthError(null);
                }}
                disabled={reauthSaving}
              >
                清空
              </button>
              <button
                className="rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                onClick={() => void handleReauthSave()}
                disabled={reauthSaving || !reauthPassword}
              >
                {reauthSaving ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
                保存并重连
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 生效宽度：拖拽中用实时值，否则按持久化值恢复（null → 默认宽）
  const widths = live ?? restoreWidths(persisted, containerWidth);

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

      {/* 三区布局：文件夹 | 邮件列表 | 邮件详情（分割线可拖拽，宽度持久化 mail.state） */}
      <div
        ref={threePaneRef}
        className="grid h-full w-full min-w-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: `${widths.folderWidth}px ${SPLITTER_WIDTH}px ${widths.listWidth}px ${SPLITTER_WIDTH}px minmax(0, 1fr)`,
        }}
      >
        {/* 左：文件夹列表 */}
        <FolderList
          folders={folders}
          selectedFolder={selectedFolder}
          onSelect={setSelectedFolder}
          loading={loadingFolders}
          width={widths.folderWidth}
          onCompose={() => {
            setComposeData({});
            setComposing(true);
          }}
        />

        {/* 分割线 1：文件夹 | 列表（拖拽调文件夹栏宽） */}
        <div
          {...splitterProps('folder', '调整文件夹栏宽度')}
          className={cn(
            'relative h-full cursor-col-resize select-none',
            dragging === 'folder' && 'bg-primary/20',
          )}
        >
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        </div>

        {/* 中：邮件列表 */}
        <MessageList
          messages={messages}
          total={messageTotal}
          selectedUid={selectedMessage?.uid ?? null}
          onSelect={(msg) => void openMessage(msg)}
          loading={loadingMessages}
          width={widths.listWidth}
        />

        {/* 分割线 2：列表 | 详情（拖拽调列表栏宽） */}
        <div
          {...splitterProps('list', '调整邮件列表栏宽度')}
          className={cn(
            'relative h-full cursor-col-resize select-none',
            dragging === 'list' && 'bg-primary/20',
          )}
        >
          <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        </div>

        {/* 右：邮件详情 / 撰写邮件（minmax(0,1fr) 铺满余量） */}
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
