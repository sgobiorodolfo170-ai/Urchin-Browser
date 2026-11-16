/**
 * M25 邮箱模块 · 账户配置向导
 *
 * 依据：邮箱模块功能规划 §5 + 用户指令「自建多服务商预设 + 登录向导」（2026-09-25）
 * 职责：同页展示服务商选择、登录表单与官网注册入口；高级设置按需展开。
 *
 * 设计理由：
 * - 预设数据与 UI 分离（provider-presets.ts 纯数据层，可单测）
 * - 域名自动识别（detectProviderByEmail）降低用户配置门槛
 * - 认证提示（授权码 vs 密码 vs OAuth2）按服务商差异化展示，避免最常见的「密码错误」误区
 */
import { useMemo, useState } from 'react';
import { getCurrentWindowId } from '../lib/current-window';
import { Button } from '../components/ui/button';
import {
  ArrowLeft,
  Loader2,
  CheckCircle,
  XCircle,
  ExternalLink,
  Mail,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  MAIL_PROVIDER_PRESETS,
  detectProviderByEmail,
  getPresetById,
  type MailProviderPreset,
} from './provider-presets';

export interface AccountSetupProps {
  onSaved: () => void;
  onCancel: () => void;
}

/** 服务商色板（按预设 id 稳定取色，避免每次渲染随机变化） */
const AVATAR_COLORS = [
  'bg-red-500',
  'bg-blue-500',
  'bg-green-600',
  'bg-purple-500',
  'bg-orange-500',
  'bg-teal-500',
  'bg-pink-500',
  'bg-indigo-500',
  'bg-cyan-600',
  'bg-amber-600',
] as const;

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function AccountSetup({ onSaved, onCancel }: AccountSetupProps) {
  // ── 向导状态 ──
  const [presetId, setPresetId] = useState<string | null>('qq');
  const preset = presetId === 'custom' ? null : presetId ? getPresetById(presetId) : null;

  // ── 表单字段 ──
  const [name, setName] = useState('QQ邮箱');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('imap.qq.com');
  const [imapPort, setImapPort] = useState('993');
  const [imapSecure, setImapSecure] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── 操作状态 ──
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 域名自动识别建议（输入邮箱时实时提示） ──
  const detected = useMemo(() => detectProviderByEmail(email), [email]);
  const showDetectSuggestion =
    detected !== undefined && detected.id !== preset?.id && presetId !== 'custom';

  /** 同页切换服务商并填充服务器配置，保留已填写的邮箱地址。 */
  const handleSelectPreset = (p: MailProviderPreset | null, id: string) => {
    setPresetId(id);
    if (p) {
      setImapHost(p.imap.host);
      setImapPort(String(p.imap.port));
      setImapSecure(p.imap.secure);
      setName(p.name);
    } else {
      // 自定义：清空预设值，展开高级设置
      setImapHost('');
      setImapPort('993');
      setImapSecure(true);
      setName('');
      setShowAdvanced(true);
    }
    setTestResult(null);
    setError(null);
    setPassword('');
    setShowAdvanced(!p);
  };

  /** 采纳域名识别建议（切换到识别出的服务商预设） */
  const handleAcceptDetection = () => {
    if (!detected) return;
    handleSelectPreset(detected, detected.id);
  };

  const busy = testing || saving;
  const valid =
    preset?.authType !== 'oauth2' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    password.length > 0 &&
    imapHost.trim().length > 0 &&
    Number.isInteger(Number(imapPort)) &&
    Number(imapPort) > 0 &&
    Number(imapPort) <= 65535;
  const handleRegister = async () => {
    if (!preset) return;
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: preset.registrationUrl,
        active: true,
      });
    } catch (e) {
      setError(`无法打开注册页面：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleTest = async () => {
    if (busy || !valid) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = (await window.urchin.invoke('mail.account.test', {
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecure,
        email: email.trim(),
        password,
      })) as { ok: true; folders?: string[] };
      setTestResult({ ok: true, msg: `连接成功，发现 ${res.folders?.length ?? 0} 个文件夹` });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (busy || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await window.urchin.invoke('mail.account.add', {
        name: name.trim() || email.trim(),
        email: email.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort),
        imapSecure,
        password,
        smtpHost: preset?.smtp?.host,
        smtpPort: preset?.smtp?.port,
        smtpSecure: preset?.smtp?.secure,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-text placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-blue-500';
  const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';

  return (
    <fieldset
      disabled={busy}
      className="mx-auto grid w-full max-w-5xl min-w-0 gap-6 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] lg:gap-8"
    >
      <section className="min-w-0" aria-label="选择邮箱服务商">
        <div className="mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
              <Mail className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-semibold text-text">连接你的邮箱</h2>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            选择服务商，在右侧填写邮箱信息即可登录。多个邮箱，一个地方管理。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {MAIL_PROVIDER_PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={presetId === p.id}
              className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${presetId === p.id ? 'border-blue-500 bg-blue-500/10 text-text' : 'border-border text-text-secondary hover:bg-surface-secondary hover:text-text'}`}
              onClick={() => handleSelectPreset(p, p.id)}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-semibold text-white ${avatarColor(p.id)}`}
              >
                {p.name.slice(0, 1)}
              </span>
              <span className="min-w-0 break-words leading-snug">{p.name}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={presetId === 'custom'}
            onClick={() => handleSelectPreset(null, 'custom')}
            className={`rounded-xl border border-dashed px-3 py-3 text-sm ${presetId === 'custom' ? 'border-blue-500 bg-blue-500/10 text-text' : 'border-border text-text-secondary hover:bg-surface-secondary'}`}
          >
            其他邮箱 / 自定义
          </button>
        </div>
      </section>
      <form
        aria-label="邮箱登录"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        onChangeCapture={() => {
          setTestResult(null);
          setError(null);
        }}
        className="min-w-0 space-y-4 self-start rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6"
      >
        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-text">登录邮箱</h2>
            <button
              type="button"
              aria-label="返回邮箱主页"
              title="返回邮箱主页"
              onClick={onCancel}
              className="rounded-md p-2 text-text-secondary hover:bg-surface-secondary"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 text-sm text-text-secondary">{preset?.name ?? '自定义 IMAP 邮箱'}</p>
        </div>
        {/* 认证提示（服务商差异化） */}
        {(preset?.authHint ?? preset?.note) && (
          <div className="rounded-md bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            {preset.authHint && <div>提示：{preset.authHint}</div>}
            {preset.note && <div>{preset.note}</div>}
          </div>
        )}

        <div>
          <label htmlFor="mail-account-name" className={labelClass}>
            显示名称
          </label>
          <input
            id="mail-account-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的邮箱"
          />
        </div>

        <div>
          <label htmlFor="mail-account-email" className={labelClass}>
            邮箱地址
          </label>
          <input
            id="mail-account-email"
            className={inputClass}
            autoComplete="username"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
          {/* 域名识别建议 */}
          {showDetectSuggestion && detected && (
            <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
              <span>识别为 {detected.name}？</span>
              <button
                type="button"
                className="text-blue-500 hover:underline"
                onClick={handleAcceptDetection}
              >
                切换配置
              </button>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="mail-account-password" className={labelClass}>
            {preset?.authType === 'app-password' ? '授权码 / 应用专用密码' : '密码'}
          </label>
          <input
            className={inputClass}
            id="mail-account-password"
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              preset?.authType === 'app-password' ? '粘贴授权码' : '邮箱密码或应用专用密码'
            }
          />
        </div>

        {/* 高级设置（可折叠）：IMAP 服务器参数 */}
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            高级设置（IMAP 服务器）
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-3 rounded-md border border-border p-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="mail-imap-host" className={labelClass}>
                    IMAP 服务器
                  </label>
                  <input
                    id="mail-imap-host"
                    className={inputClass}
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="imap.example.com"
                  />
                </div>
                <div>
                  <label htmlFor="mail-imap-port" className={labelClass}>
                    端口
                  </label>
                  <input
                    id="mail-imap-port"
                    className={inputClass}
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="imap-secure"
                  checked={imapSecure}
                  onChange={(e) => setImapSecure(e.target.checked)}
                  className="h-4 w-4 rounded"
                />
                <label htmlFor="imap-secure" className="text-sm text-text">
                  SSL/TLS 加密连接
                </label>
              </div>
            </div>
          )}
        </div>

        {testResult && (
          <div
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
              testResult.ok
                ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400'
                : 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400'
            }`}
          >
            {testResult.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {testResult.msg}
          </div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleTest()}
            disabled={busy || !valid}
          >
            {testing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            测试连接
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={busy || !valid}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            登录并添加
          </Button>
        </div>
        <div className="border-t border-border pt-4 text-xs leading-relaxed text-text-secondary">
          {preset ? (
            <>
              <span>还没有邮箱？</span>
              <button
                type="button"
                onClick={() => void handleRegister()}
                className="ml-1 inline-flex items-center gap-1 text-blue-500 hover:underline"
              >
                前往官网注册
                <ExternalLink className="h-3 w-3" />
              </button>
              <p className="mt-1">
                将在新标签页打开 {preset.name} 官方页面，注册完成后返回此处登录。
              </p>
            </>
          ) : (
            <p>
              还没有邮箱？请先选择左侧服务商，通过官网注册入口创建邮箱；企业邮箱可联系管理员开通。
            </p>
          )}
        </div>
      </form>
    </fieldset>
  );
}
