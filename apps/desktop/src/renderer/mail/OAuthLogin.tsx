import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
interface Props {
  provider: 'gmail' | 'outlook';
  email: string;
  name: string;
  accountId?: string;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
}
export function OAuthLogin({ provider, email, name, accountId, onSaved, onBusy }: Props) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSecret('');
    setStatus('');
    void window.urchin
      .invoke('mail.oauth.config.get', { provider })
      .then((value) => {
        const result = value as { clientId: string; hasClientSecret: boolean };
        if (alive) {
          setClientId(result.clientId ?? '');
          setHasSecret(Boolean(result.hasClientSecret));
        }
      })
      .catch(() => {
        if (alive) setStatus('无法加载应用配置');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [provider]);
  const login = async () => {
    setBusy(true);
    onBusy(true);
    setStatus('正在等待浏览器授权，完成后会验证邮箱连接（最多等待3分钟）…');
    try {
      await window.urchin.invoke('mail.oauth.config.set', {
        provider,
        clientId: clientId.trim(),
        clientSecret: secret || undefined,
      });
      await window.urchin.invoke('mail.oauth.login', {
        provider,
        email: email.trim(),
        name: name.trim() || email.trim(),
        accountId,
      });
      onSaved();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSecret('');
      setBusy(false);
      onBusy(false);
    }
  };
  const input =
    'mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text';
  return (
    <section className="space-y-3 rounded-lg border border-border p-3" aria-label="OAuth登录">
      <p className="text-sm text-text-secondary">
        通过系统浏览器授权，收发邮件使用 OAuth2。先配置你注册的
        {provider === 'gmail' ? ' Google 桌面应用' : ' Microsoft 桌面应用'}。
      </p>
      <label className="block text-xs text-text-secondary">
        OAuth Client ID
        <input
          className={input}
          value={clientId}
          disabled={loading || busy}
          onChange={(e) => {
            setClientId(e.target.value);
            setHasSecret(false);
          }}
        />
      </label>
      {provider === 'gmail' && (
        <label className="block text-xs text-text-secondary">
          Google 桌面应用 Client Secret
          <input
            type="password"
            autoComplete="off"
            className={input}
            value={secret}
            disabled={loading || busy}
            placeholder={hasSecret ? '已保存，留空保留' : '填写桌面应用配置中的 client_secret'}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}
      <p className="text-xs text-text-secondary">
        {provider === 'gmail'
          ? 'Google Cloud：选择 Desktop app；启用邮件权限并添加测试用户。测试模式授权通常7天过期。'
          : 'Microsoft Entra：允许个人微软账号，添加 Mobile and desktop applications，注册 http://localhost/callback；配置 IMAP.AccessAsUser.All 和 SMTP.Send 委托权限。'}
      </p>
      <button
        type="button"
        className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
        disabled={
          loading ||
          busy ||
          !clientId.trim() ||
          !/^\S+@\S+\.\S+$/.test(email.trim()) ||
          (provider === 'gmail' && !secret && !hasSecret)
        }
        onClick={() => void login()}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}使用
        {provider === 'gmail' ? ' Google' : ' Microsoft'} 授权登录
      </button>
      <p role="status" className="text-xs text-text-secondary">
        {status}
      </p>
    </section>
  );
}
