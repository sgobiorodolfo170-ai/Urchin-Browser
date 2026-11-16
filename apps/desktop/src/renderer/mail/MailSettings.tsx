import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { type MailPreferences } from './preferences';
interface Account {
  authProvider?: 'gmail' | 'outlook';
  id: string;
  name: string;
  email: string;
}
interface Props {
  accounts: Account[];
  preferences: MailPreferences;
  onSave: (value: MailPreferences) => Promise<void>;
  onRefresh: () => Promise<void>;
  onAuthorize: (account: Account) => void;
  onBack: () => void;
  onAdd: () => void;
}
export function MailSettings({
  accounts,
  preferences,
  onSave,
  onRefresh,
  onAuthorize,
  onBack,
  onAdd,
}: Props) {
  const [draft, setDraft] = useState(preferences);
  const [editing, setEditing] = useState('');
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    try {
      await action();
      setStatus('已保存');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const input = 'rounded-md border border-border bg-surface p-2 text-sm text-text';
  return (
    <div className="h-full overflow-y-auto bg-surface p-6 text-text">
      <fieldset disabled={busy} className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <button aria-label="返回邮箱主页" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-semibold">邮箱设置</h2>
        </div>
        <section className="space-y-3">
          <h3 className="font-semibold">账号管理</h3>
          <button onClick={onAdd} className={input}>
            添加账号
          </button>
          {accounts.map((a) => (
            <div key={a.id} className="space-y-2 rounded-lg border border-border p-3">
              <div>
                {draft.names[a.id] ?? a.name} ({a.email})
              </div>
              <div className="flex gap-3 text-sm">
                <label>
                  <input
                    type="radio"
                    name="default-account"
                    checked={draft.defaultAccountId === a.id}
                    onChange={() => setDraft({ ...draft, defaultAccountId: a.id })}
                  />{' '}
                  默认账号
                </label>
                <button
                  onClick={() => {
                    setEditing(a.id);
                    setPassword('');
                  }}
                >
                  编辑
                </button>
                {a.authProvider && <button onClick={() => onAuthorize(a)}>重新授权</button>}
                <button onClick={() => setDeleting(a.id)}>删除</button>
              </div>
              {editing === a.id && (
                <div className="flex flex-wrap gap-2">
                  <label>
                    显示名称{' '}
                    <input
                      className={input}
                      value={draft.names[a.id] ?? a.name}
                      onChange={(e) =>
                        setDraft({ ...draft, names: { ...draft.names, [a.id]: e.target.value } })
                      }
                    />
                  </label>
                  <label>
                    {a.authProvider ? 'OAuth账号请使用重新授权' : '新密码 / 授权码'}{' '}
                    <input
                      className={input}
                      type="password"
                      disabled={Boolean(a.authProvider)}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="留空保留原凭据"
                    />
                  </label>
                  <button
                    className={input}
                    onClick={() =>
                      void run(async () => {
                        if (password)
                          await window.urchin.invoke('mail.account.setPassword', {
                            accountId: a.id,
                            password,
                          });
                        await onSave(draft);
                        await onRefresh();
                        setPassword('');
                        setEditing('');
                      })
                    }
                  >
                    保存账号
                  </button>
                </div>
              )}
              {deleting === a.id && (
                <div className="text-sm">
                  删除本机账号、凭据和邮件缓存，服务端邮件保留。
                  <button
                    className={input}
                    onClick={() =>
                      void run(async () => {
                        await window.urchin.invoke('mail.account.delete', { accountId: a.id });
                        const names = { ...draft.names };
                        delete names[a.id];
                        const next = {
                          ...draft,
                          names,
                          defaultAccountId:
                            draft.defaultAccountId === a.id ? '' : draft.defaultAccountId,
                        };
                        await onSave(next);
                        setDraft(next);
                        await onRefresh();
                        setDeleting('');
                      })
                    }
                  >
                    确认删除
                  </button>
                  <button className={input} onClick={() => setDeleting('')}>
                    取消
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
        <section className="space-y-3">
          <h3 className="font-semibold">邮箱主页外观</h3>
          <label>
            邮件列表密度{' '}
            <select
              className={input}
              value={draft.density}
              onChange={(e) =>
                setDraft({ ...draft, density: e.target.value as MailPreferences['density'] })
              }
            >
              <option value="comfortable">舒适</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
        </section>
        <section className="space-y-3">
          <h3 className="font-semibold">反垃圾规则</h3>
          <p className="text-sm text-text-secondary">
            仅在本机隐藏匹配的邮件，不移动或删除服务器邮件。规则应用于当前加载的邮件。
          </p>
          <label className="block">
            <input
              type="checkbox"
              checked={draft.spamEnabled}
              onChange={(e) => setDraft({ ...draft, spamEnabled: e.target.checked })}
            />{' '}
            启用规则
          </label>
          <label className="block">
            屏蔽发件人（完整地址，每行一个）
            <textarea
              className={`${input} block w-full`}
              value={draft.blockedSenders.join('\n')}
              onChange={(e) => setDraft({ ...draft, blockedSenders: e.target.value.split('\n') })}
            />
          </label>
          <label className="block">
            屏蔽主题关键词（每行一个）
            <textarea
              className={`${input} block w-full`}
              value={draft.blockedWords.join('\n')}
              onChange={(e) => setDraft({ ...draft, blockedWords: e.target.value.split('\n') })}
            />
          </label>
        </section>
        <button
          className={input}
          onClick={() =>
            void run(async () => {
              const next = {
                ...draft,
                blockedSenders: draft.blockedSenders.map((s) => s.trim()).filter(Boolean),
                blockedWords: draft.blockedWords.map((s) => s.trim()).filter(Boolean),
              };
              await onSave(next);
              setDraft(next);
            })
          }
        >
          保存设置
        </button>
        <p role="status">{busy ? '正在保存…' : status}</p>
      </fieldset>
    </div>
  );
}
