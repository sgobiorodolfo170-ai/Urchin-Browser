/**
 * M25 邮箱模块 · 账户配置向导
 *
 * 依据：邮箱模块功能规划 §5 + 用户指令「自建多服务商预设 + 登录向导」（2026-09-25）
 * 职责：两步向导——
 *   第 1 步：选择服务商（预设网格 + 自定义）；
 *   第 2 步：填邮箱 + 密码（预设自动填充 IMAP 配置；域名输入实时识别建议；
 *            高级设置可折叠修改服务器参数）。
 *
 * 设计理由：
 * - 预设数据与 UI 分离（provider-presets.ts 纯数据层，可单测）
 * - 域名自动识别（detectProviderByEmail）降低用户配置门槛
 * - 认证提示（授权码 vs 密码 vs OAuth2）按服务商差异化展示，避免最常见的「密码错误」误区
 */
import { useMemo, useState } from 'react';
import { Button } from '../components/ui/button';
import { Loader2, CheckCircle, XCircle, ChevronLeft, ChevronDown, ChevronUp } from 'lucide-react';
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

/** 向导步骤 */
type WizardStep = 'provider' | 'account';

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
  const [step, setStep] = useState<WizardStep>('provider');
  const [presetId, setPresetId] = useState<string | null>(null);
  const preset = presetId === 'custom' ? null : presetId ? getPresetById(presetId) : null;

  // ── 表单字段 ──
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapSecure, setImapSecure] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── 操作状态 ──
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 域名自动识别建议（第 2 步：用户输入邮箱时实时提示） ──
  const detected = useMemo(() => detectProviderByEmail(email), [email]);
  const showDetectSuggestion =
    detected !== undefined &&
    preset !== null &&
    preset !== undefined &&
    detected.id !== preset.id &&
    presetId !== 'custom';

  /** 选择服务商 → 填充预设配置 → 进入第 2 步 */
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
    setStep('account');
  };

  /** 采纳域名识别建议（切换到识别出的服务商预设） */
  const handleAcceptDetection = () => {
    if (!detected) return;
    setPresetId(detected.id);
    setImapHost(detected.imap.host);
    setImapPort(String(detected.imap.port));
    setImapSecure(detected.imap.secure);
    setName((prev) => (prev.trim() === '' ? detected.name : prev));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = (await window.urchin.invoke('mail.account.test', {
        imapHost,
        imapPort: Number(imapPort),
        imapSecure,
        email,
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
    setSaving(true);
    setError(null);
    try {
      await window.urchin.invoke('mail.account.add', {
        name: name || email,
        email,
        imapHost,
        imapPort: Number(imapPort),
        imapSecure,
        password,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-blue-500';
  const labelClass = 'mb-1 block text-xs font-medium text-text-secondary';

  // ── 第 1 步：选择服务商 ──
  if (step === 'provider') {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <div className="text-sm text-text-secondary">
          选择你的邮箱服务商，配置将自动填充；不在列表中选择「自定义」手动配置。
        </div>

        <div className="grid grid-cols-3 gap-2">
          {MAIL_PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-border px-3 py-3 text-sm text-text hover:border-blue-400 hover:bg-surface-secondary"
              onClick={() => handleSelectPreset(p, p.id)}
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white ${avatarColor(p.id)}`}
              >
                {p.name.slice(0, 1)}
              </span>
              <span className="text-center leading-tight">{p.name}</span>
            </button>
          ))}
          {/* 自定义入口 */}
          <button
            className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-secondary hover:border-blue-400 hover:bg-surface-secondary hover:text-text"
            onClick={() => handleSelectPreset(null, 'custom')}
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-secondary text-sm text-text-secondary">
              ⚙
            </span>
            <span>自定义</span>
          </button>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  // ── 第 2 步：账户信息 ──
  return (
    <div className="mx-auto max-w-md space-y-4">
      {/* 顶部：返回 + 当前服务商 */}
      <div className="flex items-center gap-2">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={() => setStep('provider')}
          title="返回选择服务商"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white ${preset ? avatarColor(preset.id) : 'bg-surface-secondary text-text-secondary'}`}
        >
          {preset ? preset.name.slice(0, 1) : '⚙'}
        </span>
        <span className="text-sm font-medium text-text">
          {preset ? preset.name : '自定义 IMAP 配置'}
        </span>
      </div>

      {/* 认证提示（服务商差异化） */}
      {(preset?.authHint ?? preset?.note) && (
        <div className="rounded-md bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          {preset.authHint && <div>提示：{preset.authHint}</div>}
          {preset.note && <div>{preset.note}</div>}
        </div>
      )}

      <div>
        <label className={labelClass}>显示名称</label>
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="我的邮箱"
        />
      </div>

      <div>
        <label className={labelClass}>邮箱地址</label>
        <input
          className={inputClass}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />
        {/* 域名识别建议 */}
        {showDetectSuggestion && detected && (
          <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
            <span>识别为 {detected.name}？</span>
            <button className="text-blue-500 hover:underline" onClick={handleAcceptDetection}>
              切换配置
            </button>
          </div>
        )}
      </div>

      <div>
        <label className={labelClass}>
          {preset?.authType === 'app-password' ? '授权码 / 应用专用密码' : '密码'}
        </label>
        <input
          className={inputClass}
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
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text"
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
                <label className={labelClass}>IMAP 服务器</label>
                <input
                  className={inputClass}
                  value={imapHost}
                  onChange={(e) => setImapHost(e.target.value)}
                  placeholder="imap.example.com"
                />
              </div>
              <div>
                <label className={labelClass}>端口</label>
                <input
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
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleTest()}
          disabled={testing || !imapHost || !email || !password}
        >
          {testing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          测试连接
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !imapHost || !email || !password}
        >
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}
