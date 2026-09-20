/**
 * GenOffice 原生 AI 设置（阶段 3：SettingsModal AI 面板移植）
 *
 * 来源：vendor/genoffice/apps/shell/src/renderer/src/SettingsModal.tsx 的
 * AiModelPane / AiMediaPane（逻辑等价移植：provider/model/key/baseUrl/CLI 路径/
 * 输出上限/云工具开关/测试连接/保存；媒体与搜索同源）。
 *
 * 适配说明（与上游差异，均为宿主化必要项）：
 * - 数据面经 `window.urchinGenoffice`（preload 白名单桥）而非 GenOffice shell
 *   preload 的 window.aiOffice；通道与 GenOffice 原生 AI 完全一致（ai:*）
 * - UI 用 Urchin 组件（Input/Button/Tailwind）重写，文案中文化；上游
 *   ProviderLogo/自定义 Dropdown 不移植（避免引入 vendor 渲染层与 React 19）
 * - 与上方「AI 助手」（pi 模块）完全隔离：密钥/模型存 GenOffice 自己的
 *   `<userData>/ai-settings.json`，不读不写 pi 的配置与凭据
 * - 首期仅 BYOK（自备密钥）；genspark 云工具保留开关但不提供登录入口
 *
 * 安全：密钥输入 type=password，仅经 IPC 写入主进程文件；不回显到日志。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';

declare global {
  interface Window {
    readonly urchinGenoffice?: {
      invoke(channel: string, payload?: unknown): Promise<unknown>;
    };
  }
}

/** GenOffice AI 通道调用（白名单在 preload；缺失时给出可诊断错误）。 */
async function genInvoke<T>(channel: string, payload?: unknown): Promise<T> {
  const api = window.urchinGenoffice;
  if (!api) throw new Error('GenOffice 桥不可用（preload 未暴露 urchinGenoffice）');
  return (await api.invoke(channel, payload)) as T;
}

// ───────────────── 类型（与 vendor ai-provider 形状对齐，防御式解析） ─────────────────

interface AiProviderMeta {
  id: string;
  label: string;
  models: string[];
  defaultModel: string;
  keyPlaceholder: string;
  needsBaseUrl?: boolean;
  needsCliPath?: boolean;
  defaultBaseUrl?: string;
}

interface AiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  cliPath?: string;
}

interface AiMediaProviderMeta {
  id: string;
  label: string;
  keyPlaceholder?: string;
  defaultBaseUrl?: string;
  needsBaseUrl?: boolean;
  imageProtocol?: string;
  imageModels?: string[];
  defaultImageModel?: string;
  analysisProtocol?: string;
  analysisModels?: string[];
  defaultAnalysisModel?: string;
  videoProtocol?: string;
  videoModels?: string[];
  defaultVideoModel?: string;
}

interface AiSearchProviderMeta {
  id: string;
  label: string;
  keyPlaceholder?: string;
}

interface AiMediaConfig {
  apiKey: string;
  imageModel: string;
  analysisModel: string;
  videoModel?: string;
  baseUrl?: string;
}

interface AiMediaSettings {
  imageProvider: string;
  analysisProvider: string;
  videoAnalysisProvider: string;
  providers: Record<string, AiMediaConfig>;
}

interface AiSearchSettings {
  provider: string;
  providers: Record<string, { apiKey: string }>;
}

interface AiSettings {
  provider: string;
  providers: Record<string, AiProviderConfig>;
  media?: AiMediaSettings;
  search?: AiSearchSettings;
  gskToolsEnabled?: boolean;
  maxOutputTokens?: number;
}

interface AiCatalogs {
  providers: AiProviderMeta[];
  mediaProviders: AiMediaProviderMeta[];
  searchProviders: AiSearchProviderMeta[];
}

/** 输出上限（与 GenOffice DEFAULT/MIN/MAX_MAX_OUTPUT_TOKENS 对齐）。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const MIN_MAX_OUTPUT_TOKENS = 1024;
const MAX_MAX_OUTPUT_TOKENS = 131072;

function clampMaxOutputTokens(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, Math.round(value)));
}

// ───────────────── 通用小件 ─────────────────

/** 设置卡片：标题 + 说明 + 内容 + 底部动作区。 */
function Card({
  title,
  desc,
  children,
  footer,
}: {
  title: string;
  desc: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <p className="mt-1 text-xs text-text-secondary">{desc}</p>
      <div className="mt-4 space-y-4">{children}</div>
      {footer && (
        <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">{footer}</div>
      )}
    </section>
  );
}

/** 表单行：左标签/说明，右控件。 */
function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 pt-1.5">
        <label className="text-sm text-text" htmlFor={htmlFor}>
          {label}
        </label>
        {hint && <div className="mt-0.5 text-xs text-text-secondary">{hint}</div>}
      </div>
      <div className="flex w-64 shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 原生下拉（样式与设置页字段一致）。 */
function Select({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 测试结果提示。 */
function TestResult({ result }: { result: { ok: boolean; error?: string } | null }) {
  if (!result) return null;
  return (
    <span className={cn('text-xs', result.ok ? 'text-success' : 'text-error')}>
      {result.ok ? '连接正常' : `连接失败：${result.error ?? '未知错误'}`}
    </span>
  );
}

/** 产物缺失/桥不可用时的统一提示。 */
function UnavailableNote({ error }: { error: string }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-text-secondary">
      <p className="font-medium text-text">GenOffice AI 不可用</p>
      <p className="mt-1">{error}</p>
      <p className="mt-1 text-xs">
        请确认 vendor GenOffice 产物已构建（`pnpm genoffice:build`）后重启应用。
      </p>
    </div>
  );
}

// ───────────────── AI 模型（AiModelPane 移植） ─────────────────

function AiModelCard({ catalogs }: { catalogs: AiCatalogs }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void genInvoke<AiSettings>('ai:get-settings')
      .then((s) => {
        if (alive && s) setSettings(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!settings) return null;
  const provider = settings.provider;
  const meta = catalogs.providers.find((c) => c.id === provider);
  const config: AiProviderConfig = settings.providers[provider] ?? {
    apiKey: '',
    model: meta?.defaultModel ?? '',
  };
  const isGenspark = provider === 'genspark';
  const isCodex = provider === 'codex';

  const touch = (): void => {
    setDirty(true);
    setSaved(false);
    setTestResult(null);
  };
  const updateConfig = (patch: Partial<AiProviderConfig>): void => {
    setSettings({
      ...settings,
      providers: { ...settings.providers, [provider]: { ...config, ...patch } },
    });
    touch();
  };
  const selectProvider = (id: string): void => {
    setSettings({
      ...settings,
      provider: id,
      // 云工具不能与 genspark 同时关闭（对话本身走 gsk）
      ...(id === 'genspark' ? { gskToolsEnabled: true } : {}),
    });
    touch();
  };
  const commitMaxTokens = (): void => {
    if (maxTokensDraft === null) return;
    setMaxTokensDraft(null);
    const next = clampMaxOutputTokens(Number.parseInt(maxTokensDraft, 10));
    if (next === (settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)) return;
    setSettings({ ...settings, maxOutputTokens: next });
    touch();
  };
  const save = (): void => {
    genInvoke('ai:set-settings', settings)
      .then(() => {
        setDirty(false);
        setSaved(true);
      })
      .catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
  };
  const test = (): void => {
    setTesting(true);
    setTestResult(null);
    genInvoke<{ ok?: boolean; error?: string }>('ai:chat', {
      settings,
      system: 'You are a connectivity test. Reply with the single word OK.',
      user: 'ping',
    })
      .then((r) => setTestResult({ ok: r?.ok === true, error: r?.error }))
      .catch((e) => setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setTesting(false));
  };

  return (
    <Card
      title="模型服务（GenOffice 原生 AI）"
      desc="编辑器内置 AI 面板使用的模型与密钥。密钥仅保存在本机 userData/ai-settings.json，不会同步到浏览器 pi 模块。"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>
            保存
          </Button>
          {saved && !dirty && <span className="text-xs text-success">已保存</span>}
          <TestResult result={testResult} />
        </>
      }
    >
      <Row label="服务商" htmlFor="go-ai-provider">
        <Select
          ariaLabel="服务商"
          value={provider}
          onChange={selectProvider}
          options={catalogs.providers.map((c) => ({ value: c.id, label: c.label }))}
        />
      </Row>
      <div className="text-xs text-text-secondary">
        {isGenspark
          ? 'Genspark 需要登录授权（首期未接入登录入口，建议选择自备密钥的服务商）。'
          : isCodex
            ? 'Codex 使用本机 codex CLI（自动探测或手动指定路径）。'
            : '自备密钥（BYOK）：密钥只在本地使用，直连所选服务商。'}
      </div>
      <Row label="模型" htmlFor="go-ai-model">
        {meta && meta.models.length > 0 ? (
          <Select
            ariaLabel="模型"
            value={config.model || meta.defaultModel}
            onChange={(m) => updateConfig({ model: m })}
            options={meta.models.map((m) => ({ value: m, label: m }))}
          />
        ) : (
          <Input
            id="go-ai-model"
            className="h-8"
            type="text"
            value={config.model}
            placeholder="model-id"
            spellCheck={false}
            onChange={(e) => updateConfig({ model: e.target.value })}
          />
        )}
      </Row>
      {isCodex && (
        <Row
          label="Codex CLI 路径"
          hint="留空 = 自动探测当前已登录的 codex 安装"
          htmlFor="go-ai-cli"
        >
          <Input
            id="go-ai-cli"
            className="h-8"
            type="text"
            value={config.cliPath ?? ''}
            placeholder="自动探测"
            spellCheck={false}
            onChange={(e) => updateConfig({ cliPath: e.target.value.trim() })}
          />
        </Row>
      )}
      {!isGenspark && !isCodex && (
        <Row label="API Key" hint="仅本机保存（明文 JSON，不入日志）" htmlFor="go-ai-key">
          <Input
            id="go-ai-key"
            className="h-8"
            type="password"
            value={config.apiKey}
            placeholder={meta?.keyPlaceholder ?? 'sk-...'}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateConfig({ apiKey: e.target.value.trim() })}
          />
        </Row>
      )}
      {!isGenspark && !isCodex && (
        <Row
          label="Base URL"
          hint={meta?.needsBaseUrl ? '必填（自定义端点）' : '留空使用官方端点'}
          htmlFor="go-ai-base"
        >
          <Input
            id="go-ai-base"
            className="h-8"
            type="text"
            value={config.baseUrl ?? ''}
            placeholder={meta?.needsBaseUrl ? 'https://…/v1' : (meta?.defaultBaseUrl ?? '')}
            spellCheck={false}
            onChange={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
          />
        </Row>
      )}
      <Row
        label="单轮输出上限"
        hint={`Token 上限（${MIN_MAX_OUTPUT_TOKENS}–${MAX_MAX_OUTPUT_TOKENS}）`}
        htmlFor="go-ai-max"
      >
        <Input
          id="go-ai-max"
          className="h-8"
          type="text"
          inputMode="numeric"
          value={maxTokensDraft ?? String(settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)}
          onChange={(e) => setMaxTokensDraft(e.target.value)}
          onBlur={commitMaxTokens}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitMaxTokens();
          }}
        />
      </Row>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-text">Genspark 云工具</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            联网搜索 / 图像生成 / 媒体分析走 Genspark（需登录；BYOK 模式下不影响对话）
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.gskToolsEnabled !== false}
          disabled={isGenspark}
          onClick={() => {
            setSettings({ ...settings, gskToolsEnabled: settings.gskToolsEnabled === false });
            touch();
          }}
          className={cn(
            'relative mt-1 h-5 w-9 shrink-0 rounded-full transition-colors',
            settings.gskToolsEnabled !== false ? 'bg-primary' : 'bg-border',
            isGenspark && 'opacity-50',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
              settings.gskToolsEnabled !== false && 'translate-x-4',
            )}
          />
        </button>
      </div>
    </Card>
  );
}

// ───────────────── 媒体与搜索（AiMediaPane 移植） ─────────────────

function AiMediaCard({ catalogs }: { catalogs: AiCatalogs }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void genInvoke<AiSettings>('ai:get-settings')
      .then((s) => {
        if (alive && s) setSettings(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!settings?.media || !settings.search) return null;
  const media = settings.media;
  const search = settings.search;

  const touch = (): void => {
    setDirty(true);
    setSaved(false);
    setTestResult(null);
  };
  const mediaConfigOf = (id: string): AiMediaConfig => {
    const meta = catalogs.mediaProviders.find((m) => m.id === id);
    return (
      media.providers[id] ?? {
        apiKey: '',
        imageModel: meta?.defaultImageModel ?? '',
        analysisModel: meta?.defaultAnalysisModel ?? '',
      }
    );
  };
  const updateMediaConfig = (id: string, patch: Partial<AiMediaConfig>): void => {
    setSettings({
      ...settings,
      media: {
        ...media,
        providers: { ...media.providers, [id]: { ...mediaConfigOf(id), ...patch } },
      },
    });
    touch();
  };
  const save = (): void => {
    genInvoke('ai:set-settings', settings)
      .then(() => {
        setDirty(false);
        setSaved(true);
      })
      .catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
  };
  const test = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const vendors = new Set(
        [media.imageProvider, media.analysisProvider, media.videoAnalysisProvider].filter(
          (id) => id !== 'genspark',
        ),
      );
      const checks: Promise<{ ok: boolean; error?: string }>[] = [...vendors].map((id) =>
        genInvoke<{ ok?: boolean; error?: string }>('ai:media-test', {
          provider: id,
          config: mediaConfigOf(id),
        }).then((r) => ({ ok: r?.ok === true, error: r?.error })),
      );
      if (search.provider !== 'genspark') {
        checks.push(
          genInvoke<{ ok?: boolean; error?: string }>('ai:search-test', {
            provider: search.provider,
            apiKey: search.providers[search.provider]?.apiKey ?? '',
          }).then((r) => ({ ok: r?.ok === true, error: r?.error })),
        );
      }
      if (checks.length === 0) {
        setTestResult({ ok: true });
      } else {
        const results = await Promise.all(checks);
        setTestResult(results.find((r) => !r.ok) ?? { ok: true });
      }
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const capabilityBlock = (
    cap: 'image' | 'analysis' | 'video',
    title: string,
    providerKey: 'imageProvider' | 'analysisProvider' | 'videoAnalysisProvider',
  ): ReactNode => {
    const options = catalogs.mediaProviders.filter((m) =>
      cap === 'image'
        ? !!m.imageProtocol
        : cap === 'analysis'
          ? !!m.analysisProtocol
          : !!m.videoProtocol,
    );
    const current = media[providerKey];
    const meta = catalogs.mediaProviders.find((m) => m.id === current);
    const config = mediaConfigOf(current);
    const models =
      cap === 'image'
        ? (meta?.imageModels ?? [])
        : cap === 'analysis'
          ? (meta?.analysisModels ?? [])
          : (meta?.videoModels ?? []);
    const modelValue =
      cap === 'image'
        ? config.imageModel
        : cap === 'analysis'
          ? config.analysisModel
          : config.videoModel;
    const modelFallback =
      cap === 'image'
        ? meta?.defaultImageModel
        : cap === 'analysis'
          ? meta?.defaultAnalysisModel
          : meta?.defaultVideoModel;
    const effectiveModel = modelValue && modelValue.length > 0 ? modelValue : (modelFallback ?? '');
    const setModel = (v: string): void => {
      if (cap === 'image') updateMediaConfig(current, { imageModel: v });
      else if (cap === 'analysis') updateMediaConfig(current, { analysisModel: v });
      else updateMediaConfig(current, { videoModel: v });
    };

    return (
      <div key={cap} className="rounded-md border border-border/60 p-3">
        <div className="mb-2 text-xs font-medium text-text">{title}</div>
        <div className="space-y-3">
          <Row label="服务商">
            <Select
              ariaLabel={`${title} 服务商`}
              value={current}
              onChange={(id) => {
                setSettings({ ...settings, media: { ...media, [providerKey]: id } });
                touch();
              }}
              options={options.map((o) => ({ value: o.id, label: o.label }))}
            />
          </Row>
          <Row label="模型">
            {models.length > 0 ? (
              <Select
                ariaLabel={`${title} 模型`}
                value={effectiveModel}
                onChange={setModel}
                options={models.map((m) => ({ value: m, label: m }))}
              />
            ) : (
              <Input
                className="h-8"
                type="text"
                value={modelValue ?? ''}
                placeholder="model-id"
                spellCheck={false}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </Row>
          {current !== 'genspark' && (
            <>
              <Row label="API Key">
                <Input
                  className="h-8"
                  type="password"
                  value={config.apiKey}
                  placeholder={meta?.keyPlaceholder ?? 'sk-...'}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => updateMediaConfig(current, { apiKey: e.target.value.trim() })}
                />
              </Row>
              <Row label="Base URL" hint="留空使用官方端点">
                <Input
                  className="h-8"
                  type="text"
                  value={config.baseUrl ?? ''}
                  placeholder={meta?.defaultBaseUrl ?? ''}
                  spellCheck={false}
                  onChange={(e) => updateMediaConfig(current, { baseUrl: e.target.value.trim() })}
                />
              </Row>
            </>
          )}
        </div>
      </div>
    );
  };

  const searchMeta = catalogs.searchProviders.find((s) => s.id === search.provider);
  const searchKey = search.providers[search.provider]?.apiKey ?? '';

  return (
    <Card
      title="媒体与搜索"
      desc="图像生成 / 图片分析 / 视频分析 与联网搜索的后端（与对话模型分开配置；同样仅本机保存）。"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => void test()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>
            保存
          </Button>
          {saved && !dirty && <span className="text-xs text-success">已保存</span>}
          <TestResult result={testResult} />
        </>
      }
    >
      {capabilityBlock('image', '图像生成', 'imageProvider')}
      {capabilityBlock('analysis', '图片分析', 'analysisProvider')}
      {capabilityBlock('video', '视频分析', 'videoAnalysisProvider')}
      <div className="rounded-md border border-border/60 p-3">
        <div className="mb-2 text-xs font-medium text-text">联网搜索</div>
        <div className="space-y-3">
          <Row label="服务商">
            <Select
              ariaLabel="搜索服务商"
              value={search.provider}
              onChange={(id) => {
                setSettings({ ...settings, search: { ...search, provider: id } });
                touch();
              }}
              options={catalogs.searchProviders.map((s) => ({ value: s.id, label: s.label }))}
            />
          </Row>
          {search.provider !== 'genspark' && (
            <Row label="API Key">
              <Input
                className="h-8"
                type="password"
                value={searchKey}
                placeholder={searchMeta?.keyPlaceholder ?? 'API Key'}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    search: {
                      ...search,
                      providers: {
                        ...search.providers,
                        [search.provider]: { apiKey: e.target.value.trim() },
                      },
                    },
                  })
                }
              />
            </Row>
          )}
        </div>
      </div>
    </Card>
  );
}

// ───────────────── 入口 ─────────────────

export function GenOfficeAiSettings() {
  const [catalogs, setCatalogs] = useState<AiCatalogs | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await genInvoke<AiCatalogs>('genoffice:ai-catalogs');
      if (!data || !Array.isArray(data.providers)) {
        throw new Error('AI 目录数据无效');
      }
      setCatalogs(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-medium text-text">AI（GenOffice）</h2>
        <p className="mt-1 text-sm text-text-secondary">
          本地文档编辑器（Markdown / PDF / Office）内置 AI 面板的模型与密钥。与上方「AI
          助手」（pi）完全隔离，互不读写配置。
        </p>
      </header>
      {error ? <UnavailableNote error={error} /> : null}
      {catalogs ? (
        <>
          <AiModelCard catalogs={catalogs} />
          <AiMediaCard catalogs={catalogs} />
        </>
      ) : null}
    </div>
  );
}
