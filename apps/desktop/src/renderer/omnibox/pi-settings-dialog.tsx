/**
 * pi 设置对话框
 *
 * 职责：
 * 1. 提供模型提供商（Provider）配置 UI：从 pi 内置 39 个 provider 中选择，或选择「自定义」OpenAI 兼容 provider
 * 2. 配置项：Provider / API Key / Base URL / Model
 * 3. 通过 settings.set IPC 持久化到 SQLite（key: ai.providerId / ai.apiKey / ai.baseUrl / ai.model）
 * 4. 保存后派发 urchin:settings-changed 事件，AI 模块监听后刷新配置
 *
 * 自定义 Provider：
 * - 选择「自定义（OpenAI 兼容）」后，用户可自由输入 Base URL / API Key / Model
 * - 后端 OPENAI_COMPATIBLE_PROVIDER_CODE 使用 config.baseUrl + config.apiKey 调用 /v1/chat/completions
 * - 兼容 OpenAI / Azure OpenAI / Ollama / vLLM / LM Studio / DeepSeek / Moonshot / Groq 等任意 OpenAI 兼容端点
 * - 参考pi原项目 packages/coding-agent/docs/models.md 的 OpenAI Compatibility 章节
 *
 * 触发：AiChatView 中区 header 的齿轮按钮 → setShowPiSettings(true)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import type { PiProviderInfo } from '@urchin/ipc-contract';

interface PiSettingsDialogProps {
  /** 是否显示 */
  readonly open: boolean;
  /** 关闭对话框 */
  readonly onClose: () => void;
}

/** pi.providers IPC 返回结构 */
interface PiProvidersResponse {
  readonly providers: readonly PiProviderInfo[];
  readonly generatedAt?: number;
}

/** settings.getAll 返回的条目结构 */
interface SettingsEntry {
  readonly key: string;
  readonly value: unknown;
}

/** settings.getAll 返回结构 */
interface SettingsAllResponse {
  readonly entries: readonly SettingsEntry[];
}

/** 自定义 provider 的特殊 ID（不与 pi 内置 provider 冲突） */
const CUSTOM_PROVIDER_ID = 'custom-openai-compatible';

/** 常见 OpenAI 兼容端点示例（仅作 placeholder 提示，不限制输入） */
const COMMON_ENDPOINTS = [
  'https://api.openai.com/v1',
  'https://api.deepseek.com',
  'https://api.groq.com/openai/v1',
  'https://api.together.ai/v1',
  'https://api.moonshot.cn/v1',
  'http://localhost:11434/v1',
  'http://localhost:1234/v1',
];

/**
 * pi 设置对话框。
 *
 * 打开时：
 * 1. 调用 pi.providers 获取 pi 内置 provider 列表
 * 2. 调用 settings.getAll 读取当前 ai.* 配置
 * 3. 用户编辑后点击「保存」批量写入 settings.set，并派发 urchin:settings-changed 事件
 */
export function PiSettingsDialog({ open, onClose }: PiSettingsDialogProps) {
  const [providers, setProviders] = useState<readonly PiProviderInfo[]>([]);
  const [providerId, setProviderId] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  // 选中的 provider 元信息（用于显示 baseUrl/apiKeyEnvVar 提示）
  const selectedProvider = providers.find((p) => p.id === providerId);
  // 是否为自定义 provider
  const isCustom = providerId === CUSTOM_PROVIDER_ID;

  // open 变化时加载数据
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // 并行加载 pi 内置 provider 列表和当前设置
        const [piRes, settingsRes] = await Promise.all([
          window.urchin.invoke('pi.providers', {}) as Promise<PiProvidersResponse>,
          window.urchin.invoke('settings.getAll', {}) as Promise<SettingsAllResponse>,
        ]);

        if (cancelled) return;

        setProviders(piRes.providers ?? []);

        // 读取当前 ai.* 设置
        const next: Record<string, unknown> = {};
        for (const e of settingsRes.entries) next[e.key] = e.value;
        setProviderId(typeof next['ai.providerId'] === 'string' ? next['ai.providerId'] : '');
        setApiKey(typeof next['ai.apiKey'] === 'string' ? next['ai.apiKey'] : '');
        setBaseUrl(typeof next['ai.baseUrl'] === 'string' ? next['ai.baseUrl'] : '');
        setModel(typeof next['ai.model'] === 'string' ? next['ai.model'] : '');
      } catch (e) {
        if (!cancelled) {
          setToast(`加载失败：${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // 保存配置
  const handleSave = useCallback(async () => {
    setSaving(true);
    setToast(null);
    try {
      // 批量写入 settings.set
      const items: [string, unknown][] = [
        ['ai.providerId', providerId],
        ['ai.apiKey', apiKey],
        ['ai.baseUrl', baseUrl],
        ['ai.model', model],
      ];
      for (const [key, value] of items) {
        await window.urchin.invoke('settings.set', { key, value });
      }

      // 派发 urchin:settings-changed 事件，AI 模块监听后刷新配置
      window.dispatchEvent(
        new CustomEvent('urchin:settings-changed', {
          detail: { keys: items.map(([k]) => k) },
        }),
      );

      setToast('已保存');
      // 短暂延迟后关闭对话框
      setTimeout(() => {
        if (!cancelledRef.current) onClose();
      }, 600);
    } catch (e) {
      setToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [providerId, apiKey, baseUrl, model, onClose]);

  // cancelledRef 用于 handleSave 内部的 setTimeout 防泄漏（unmount 后不再调用 onClose）
  const cancelledRef = useRef<boolean>(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface shadow-lg">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border p-4">
          <h2 className="flex-1 text-base font-semibold text-text">pi 设置</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
            aria-label="关闭"
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto p-4">
          {loading ? (
            <p className="py-8 text-center text-sm text-text-secondary">加载中...</p>
          ) : (
            <div className="space-y-4">
              {/* Provider 选择 */}
              <div>
                <label className="block text-xs font-medium text-text-secondary">
                  模型提供商（Provider）
                </label>
                <select
                  className="mt-1 h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1"
                  value={providerId}
                  onChange={(e) => {
                    const newId = e.target.value;
                    setProviderId(newId);
                    // 切换到内置 provider 时，若用户未自定义 baseUrl，自动填充默认值
                    if (newId !== CUSTOM_PROVIDER_ID) {
                      const p = providers.find((pp) => pp.id === newId);
                      if (p?.baseUrl && !baseUrl) {
                        setBaseUrl(p.baseUrl);
                      }
                    }
                  }}
                  autoFocus
                >
                  <option value="">（未选择）</option>
                  {/* 自定义 OpenAI 兼容 provider 选项 */}
                  <option value={CUSTOM_PROVIDER_ID}>自定义（OpenAI 兼容协议）</option>
                  {/* 分组：pi 内置 provider */}
                  <optgroup label="pi 内置提供商">
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}（{p.id}）
                      </option>
                    ))}
                  </optgroup>
                </select>
                {isCustom ? (
                  <p className="mt-1 text-xs text-text-secondary">
                    自定义 provider 采用 OpenAI Chat Completions 协议（
                    <code className="rounded bg-surface-secondary px-1">/v1/chat/completions</code>
                    ）， 兼容 OpenAI / DeepSeek / Moonshot / Groq / Ollama / vLLM / LM Studio
                    等任意兼容端点。
                  </p>
                ) : (
                  selectedProvider?.apiKeyEnvVar && (
                    <p className="mt-1 text-xs text-text-secondary">
                      推荐环境变量：
                      <code className="rounded bg-surface-secondary px-1">
                        {selectedProvider.apiKeyEnvVar}
                      </code>
                    </p>
                  )
                )}
              </div>

              {/* API Key */}
              <div>
                <label className="block text-xs font-medium text-text-secondary">API Key</label>
                <div className="relative mt-1">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      isCustom
                        ? '输入 API Key（本地模型可留空）'
                        : selectedProvider?.apiKeyEnvVar
                          ? `从 ${selectedProvider.apiKeyEnvVar} 环境变量或在此输入`
                          : '输入 API Key'
                    }
                    disabled={saving}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary hover:text-text"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    title={showApiKey ? '隐藏' : '显示'}
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {isCustom
                    ? '加密存储于本地。本地模型（Ollama/LM Studio）通常无需 API Key，可留空。'
                    : '加密存储于本地，不会上传。留空则使用环境变量。'}
                </p>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs font-medium text-text-secondary">
                  Base URL{isCustom && <span className="text-error"> *</span>}
                </label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    isCustom
                      ? COMMON_ENDPOINTS[0]
                      : (selectedProvider?.baseUrl ?? 'https://api.openai.com/v1')
                  }
                  disabled={saving}
                  className="mt-1"
                />
                {isCustom ? (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-xs text-text-secondary">
                      常见端点：
                      {COMMON_ENDPOINTS.slice(0, 4).map((ep, i) => (
                        <span key={ep}>
                          {i > 0 && ' · '}
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => setBaseUrl(ep)}
                          >
                            {ep.replace(/^https?:\/\//, '')}
                          </button>
                        </span>
                      ))}
                    </p>
                    <p className="text-xs text-text-secondary">
                      本地模型：
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setBaseUrl('http://localhost:11434/v1')}
                      >
                        Ollama
                      </button>{' '}
                      ·{' '}
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setBaseUrl('http://localhost:1234/v1')}
                      >
                        LM Studio
                      </button>{' '}
                      ·{' '}
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => setBaseUrl('http://localhost:8000/v1')}
                      >
                        vLLM
                      </button>
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-text-secondary">
                    OpenAI 兼容端点可填 Azure OpenAI / Ollama / vLLM 等。留空使用 provider 默认。
                  </p>
                )}
              </div>

              {/* Model */}
              <div>
                <label className="block text-xs font-medium text-text-secondary">
                  模型（Model）{isCustom && <span className="text-error"> *</span>}
                </label>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    isCustom
                      ? 'gpt-4o-mini / deepseek-chat / llama3.1:8b / qwen2.5:7b'
                      : 'gpt-4o-mini / claude-opus-4-5 / gemini-2.5-pro'
                  }
                  disabled={saving}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-text-secondary">
                  {isCustom
                    ? '模型 ID，需与端点实际支持的模型名一致。'
                    : '模型 ID。pi 内置 provider 支持的模型见 pi 仓库文档。'}
                </p>
              </div>

              {/* 自定义 provider 额外提示 */}
              {isCustom && (
                <div className="rounded-md border border-border bg-surface-secondary p-3 text-xs text-text-secondary">
                  <p className="font-medium text-text">使用说明</p>
                  <ul className="mt-1 space-y-0.5 pl-4">
                    <li>
                      • Base URL 需指向 OpenAI 兼容的 API 根路径（通常以{' '}
                      <code className="rounded bg-surface px-1">/v1</code> 结尾）
                    </li>
                    <li>• 模型 ID 需与端点实际支持的模型名完全一致</li>
                    <li>• 本地模型（Ollama/LM Studio/vLLM）通常无需 API Key</li>
                    <li>• 配置保存后，AI 模块会自动重新加载 provider</li>
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          <div className="flex-1 text-xs">
            {toast && (
              <span
                className={
                  toast.startsWith('保存失败') || toast.startsWith('加载失败')
                    ? 'text-error'
                    : 'text-success'
                }
              >
                {toast}
              </span>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || loading || (isCustom && (!baseUrl.trim() || !model.trim()))}
            loading={saving}
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
