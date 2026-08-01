/**
 * 设置页 React 组件（多选项卡布局）
 *
 * 设计：
 * - 左侧选项卡导航，右侧内容区
 * - 自动保存：字段变更后立即写入（debounce 800ms，与主流浏览器设置页对齐）
 * - 选项卡：通用 / AI 助手 / 隐私与安全 / 更新 / 关于 / 调试
 *
 * 通过主窗口已有的 window.urchin.invoke('settings.*') 读写设置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';

// ───────────────── 类型定义 ─────────────────

/** 单个设置字段类型 */
type FieldType = 'select' | 'toggle' | 'text' | 'password' | 'provider-select' | 'directory';

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface SettingField {
  readonly key: string;
  readonly label: string;
  readonly desc?: string;
  readonly type: FieldType;
  readonly options?: readonly SelectOption[];
}

/** Provider 信息（来自 provider.list） */
interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

interface SettingsEntry {
  readonly key: string;
  readonly value: unknown;
}

/** 选项卡定义 */
type TabKey = 'general' | 'ai' | 'privacy' | 'update' | 'about' | 'debug';

interface TabDef {
  readonly key: TabKey;
  readonly label: string;
}

const TABS: readonly TabDef[] = [
  { key: 'general', label: '通用' },
  { key: 'ai', label: 'AI 助手' },
  { key: 'privacy', label: '隐私与安全' },
  { key: 'update', label: '更新' },
  { key: 'about', label: '关于' },
  { key: 'debug', label: '调试' },
];

// ───────────────── 设置项分组（按选项卡组织） ─────────────────

const GENERAL_FIELDS: readonly SettingField[] = [
  {
    key: 'theme',
    label: '主题',
    desc: '浅色 / 深色',
    type: 'select',
    options: [
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
      { value: 'system', label: '跟随系统' },
    ],
  },
  {
    key: 'language',
    label: '界面语言',
    desc: '应用界面显示语言（默认中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en-US', label: 'English' },
    ],
  },
  {
    key: 'searchEngine',
    label: '搜索引擎',
    desc: '地址栏搜索使用的引擎',
    type: 'select',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
      { value: 'baidu', label: '百度' },
      { value: 'duckduckgo', label: 'DuckDuckGo' },
    ],
  },
  { key: 'homepage', label: '主页', desc: '启动时打开的页面', type: 'text' },
  { key: 'downloadsPath', label: '下载位置', desc: '留空使用系统默认', type: 'directory' },
  {
    key: 'summary.saveDirectory',
    label: '摘要文档保存位置',
    desc: 'AI 摘要生成的网页文档保存目录（留空使用默认位置）',
    type: 'directory',
  },
  {
    key: 'links.openInNewTab',
    label: '在新标签页打开链接',
    desc: '点击网页内链接时在新标签页打开（关闭则在当前标签页打开）',
    type: 'toggle',
  },
];

const AI_FIELDS: readonly SettingField[] = [
  {
    key: 'summary.providerId',
    label: '默认 Provider',
    desc: '摘要助手的服务提供方（留空使用首个可用 Provider）',
    type: 'provider-select',
  },
  { key: 'summary.model', label: '模型', desc: '摘要助手调用 LLM 时使用的模型名', type: 'text' },
  {
    key: 'summary.apiKey',
    label: 'API Key',
    desc: '摘要助手 Provider 鉴权密钥（加密存储）',
    type: 'password',
  },
  {
    key: 'summary.baseUrl',
    label: 'Base URL',
    desc: 'OpenAI 兼容协议端点（留空使用官方 https://api.openai.com；可填 Azure OpenAI、Ollama、vLLM 等）',
    type: 'text',
  },
];

const PRIVACY_FIELDS: readonly SettingField[] = [
  { key: 'blockTrackers', label: '拦截追踪器', desc: '阻止第三方追踪脚本', type: 'toggle' },
  { key: 'doNotTrack', label: '请勿追踪', desc: '发送 DNT 头', type: 'toggle' },
];

/** 默认值（用于重置） */
const DEFAULTS: Record<string, unknown> = {
  theme: 'light',
  language: 'zh-CN',
  searchEngine: 'google',
  homepage: 'urchin://newtab',
  downloadsPath: '',
  blockTrackers: true,
  doNotTrack: true,
  'links.openInNewTab': false,
  'summary.model': 'gpt-4o-mini',
  'summary.apiKey': '',
  'summary.providerId': '',
  'summary.baseUrl': '',
  'summary.saveDirectory': '',
  'debug.sidebarHoverDelay': 300,
};

// ───────────────── 工具函数 ─────────────────

/** 将 unknown 值安全转为字符串 */
function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// ───────────────── 主组件 ─────────────────

export function SettingsPage() {
  const [entries, setEntries] = useState<Record<string, unknown>>({});
  const [providers, setProviders] = useState<readonly ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 待保存的变更（key → value），自动保存队列
  const pendingRef = useRef<Map<string, unknown>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const settingsRes = (await window.urchin.invoke('settings.getAll', {})) as {
          entries: readonly SettingsEntry[];
        };
        const next: Record<string, unknown> = {};
        for (const e of settingsRes.entries) next[e.key] = e.value;
        setEntries(next);

        try {
          // 先触发重新扫描，确保内置 Provider 已注册（解决首次运行或文件缺失问题）
          await window.urchin.invoke('provider.rescan', {});
          const providersRes = (await window.urchin.invoke('provider.list', {})) as {
            providers: readonly ProviderInfo[];
          };
          setProviders(providersRes.providers ?? []);
        } catch {
          setProviders([]);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }, []);

  // 自动保存：变更后 debounce 800ms 批量写入（与主流浏览器设置页对齐）
  const flushSave = useCallback(async () => {
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    const items = Array.from(pending.entries());
    pending.clear();
    setSaving(true);
    try {
      for (const [key, value] of items) {
        await window.urchin.invoke('settings.set', { key, value });
      }
      showToast('已保存');
      // 通知其他 React 组件设置已变更（如 App.tsx 的侧边栏悬停延迟）
      window.dispatchEvent(
        new CustomEvent('urchin:settings-changed', { detail: { keys: items.map(([k]) => k) } }),
      );
    } catch (e) {
      showToast('保存失败：' + String(e));
    } finally {
      setSaving(false);
    }
  }, [showToast]);

  const updateField = useCallback(
    (key: string, value: unknown) => {
      setEntries((prev) => ({ ...prev, [key]: value }));
      pendingRef.current.set(key, value);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushSave();
      }, 800);
    },
    [flushSave],
  );

  // 卸载时保存未提交的变更
  useEffect(() => {
    // 捕获 ref 当前值，避免 cleanup 时读到变化后的引用
    const pending = pendingRef.current;
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // 同步执行最后一批保存（不等待）
      if (pending.size > 0) {
        for (const [key, value] of pending) {
          void window.urchin.invoke('settings.set', { key, value });
        }
      }
    };
  }, []);

  const handleReset = useCallback(async () => {
    if (!window.confirm('确定重置所有设置为默认值？')) return;
    try {
      for (const [k, v] of Object.entries(DEFAULTS)) {
        await window.urchin.invoke('settings.set', { key: k, value: v });
      }
      const next = { ...DEFAULTS };
      setEntries(next);
      showToast('已重置为默认值');
    } catch (e) {
      showToast('重置失败：' + String(e));
    }
  }, [showToast]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">加载中…</div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-error">加载失败：{error}</div>
    );
  }

  return (
    <div className="flex h-full bg-surface text-text">
      {/* 左侧选项卡导航 */}
      <nav className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-secondary py-4">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center px-4 py-2.5 text-sm text-left transition-colors',
              activeTab === tab.key
                ? 'border-l-2 border-primary bg-surface font-medium text-text'
                : 'border-l-2 border-transparent text-text-secondary hover:bg-surface hover:text-text',
            )}
          >
            {tab.label}
            {tab.key === 'debug' && (
              <span className="ml-1.5 rounded bg-warning/20 px-1 text-xs text-warning">DEV</span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <div className="px-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleReset()}
            className="w-full"
          >
            重置默认
          </Button>
          {saving && <p className="mt-2 text-center text-xs text-text-secondary">保存中…</p>}
        </div>
      </nav>

      {/* 右侧内容区 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-6 pb-16">
          {activeTab === 'general' && (
            <SettingsSection
              title="通用"
              fields={GENERAL_FIELDS}
              entries={entries}
              providers={providers}
              onChange={updateField}
            />
          )}
          {activeTab === 'ai' && (
            <SettingsSection
              title="AI 助手"
              fields={AI_FIELDS}
              entries={entries}
              providers={providers}
              onChange={updateField}
            />
          )}
          {activeTab === 'privacy' && (
            <SettingsSection
              title="隐私与安全"
              fields={PRIVACY_FIELDS}
              entries={entries}
              providers={providers}
              onChange={updateField}
            />
          )}
          {activeTab === 'update' && <UpdateTab />}
          {activeTab === 'about' && <AboutTab />}
          {activeTab === 'debug' && <DebugTab entries={entries} onChange={updateField} />}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-md bg-success px-4 py-2 text-sm text-white shadow-md">
          {toast}
        </div>
      )}
    </div>
  );
}

// ───────────────── 子组件：设置分组渲染 ─────────────────

interface SettingsSectionProps {
  readonly title: string;
  readonly fields: readonly SettingField[];
  readonly entries: Record<string, unknown>;
  readonly providers: readonly ProviderInfo[];
  readonly onChange: (key: string, value: unknown) => void;
}

function SettingsSection({ title, fields, entries, providers, onChange }: SettingsSectionProps) {
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <div className="space-y-1">
        {fields.map((field) => (
          <div key={field.key} className="flex items-center justify-between gap-4 py-3">
            <div className="flex-1">
              <div className="font-medium">{field.label}</div>
              {field.desc && <div className="mt-0.5 text-xs text-text-secondary">{field.desc}</div>}
            </div>
            <div className="shrink-0" style={{ minWidth: 240 }}>
              <FieldControl
                field={field}
                value={entries[field.key]}
                providers={providers}
                onChange={(v) => onChange(field.key, v)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface FieldControlProps {
  readonly field: SettingField;
  readonly value: unknown;
  readonly providers: readonly ProviderInfo[];
  readonly onChange: (value: unknown) => void;
}

function FieldControl({ field, value, providers, onChange }: FieldControlProps) {
  if (field.type === 'select' && field.options) {
    return (
      <select
        className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
        value={toStr(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'provider-select') {
    return (
      <select
        className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
        value={toStr(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">自动（使用首个可用 Provider）</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} v{p.version}
          </option>
        ))}
        {providers.length === 0 && (
          <option value="" disabled>
            （未安装任何 Provider）
          </option>
        )}
      </select>
    );
  }

  if (field.type === 'toggle') {
    const on = value === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform',
            on && 'translate-x-4',
          )}
        />
      </button>
    );
  }

  // directory：路径输入框 + 「浏览」按钮（点击弹出原生目录选择器）
  if (field.type === 'directory') {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          className="h-8 min-w-0 flex-1"
          value={toStr(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder="留空使用系统默认"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          onClick={() => {
            void (async () => {
              try {
                const result = (await window.urchin.invoke('dialog.selectDirectory', {
                  title: `选择${field.label}`,
                })) as { path: string | null };
                if (result.path) {
                  onChange(result.path);
                }
              } catch (e) {
                console.error('Failed to select directory:', e);
              }
            })();
          }}
        >
          浏览
        </Button>
      </div>
    );
  }

  // text / password
  return (
    <Input
      type={field.type === 'password' ? 'password' : 'text'}
      className="h-8"
      value={toStr(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ───────────────── 更新选项卡 ─────────────────

function UpdateTab() {
  const appVersion = '0.1.0';
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<string>('未检查');

  const handleCheck = useCallback(() => {
    setChecking(true);
    // v0.1 暂未实现自动更新检查，模拟异步操作
    setTimeout(() => {
      setChecking(false);
      setLastCheck(new Date().toLocaleString('zh-CN'));
    }, 800);
  }, []);

  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">更新</h1>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-3">
          <div className="text-xs text-text-secondary">当前版本</div>
          <div className="mt-1 text-lg font-medium">v{appVersion}</div>
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">检查更新</div>
              <div className="mt-0.5 text-xs text-text-secondary">
                v0.1 暂未启用自动更新；上次检查：{lastCheck}
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={handleCheck} disabled={checking}>
              {checking ? '检查中…' : '立即检查'}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────── 关于选项卡 ─────────────────

function AboutTab() {
  const versions = useMemo(() => {
    if (typeof window !== 'undefined' && window.urchin?.versions) {
      return {
        electron: window.urchin.versions.electron,
        chrome: window.urchin.versions.chrome,
        node: window.urchin.versions.node,
        platform: window.urchin.platform,
      };
    }
    return { electron: '-', chrome: '-', node: '-', platform: '-' };
  }, []);

  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">关于</h1>
      <div className="space-y-4">
        <div className="rounded-md border border-border bg-surface-secondary px-4 py-4">
          <div className="text-lg font-semibold">Urchin Browser</div>
          <div className="mt-1 text-sm text-text-secondary">版本 0.1.0</div>
          <div className="mt-3 text-xs text-text-secondary">
            一款基于 Electron + Chromium 的 AI 浏览器，集成多 Provider AI 助手与隐私保护。
          </div>
        </div>

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">运行时信息</div>
          <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
            <dt className="text-text-secondary">Electron</dt>
            <dd>{versions.electron}</dd>
            <dt className="text-text-secondary">Chromium</dt>
            <dd>{versions.chrome}</dd>
            <dt className="text-text-secondary">Node.js</dt>
            <dd>{versions.node}</dd>
            <dt className="text-text-secondary">平台</dt>
            <dd>{versions.platform}</dd>
          </dl>
        </div>

        <div className="rounded-md border border-border px-4 py-3">
          <div className="mb-2 text-sm font-medium">作者</div>
          <div className="text-xs text-text-secondary">Urchin Browser Contributors</div>
          <div className="mt-2 text-xs text-text-secondary">
            Copyright © 2026 Urchin Browser Contributors
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────── 调试选项卡（开发阶段临时） ─────────────────

/** 配色变量定义（来自 tokens.css） */
const COLOR_TOKENS = [
  { varName: '--color-primary', label: '主色 Primary', default: '#2563eb' },
  { varName: '--color-primary-hover', label: '主色 Hover', default: '#1d4ed8' },
  { varName: '--color-accent', label: '强调色 Accent', default: '#8b5cf6' },
  { varName: '--color-surface', label: '背景 Surface', default: '#ffffff' },
  { varName: '--color-surface-secondary', label: '次背景 Surface-2', default: '#f8fafc' },
  { varName: '--color-text', label: '文字 Text', default: '#0f172a' },
  { varName: '--color-text-secondary', label: '次文字 Text-2', default: '#64748b' },
  { varName: '--color-border', label: '边框 Border', default: '#e2e8f0' },
  { varName: '--color-error', label: '错误 Error', default: '#ef4444' },
  { varName: '--color-success', label: '成功 Success', default: '#22c55e' },
  { varName: '--color-warning', label: '警告 Warning', default: '#f59e0b' },
  { varName: '--color-info', label: '信息 Info', default: '#3b82f6' },
] as const;

/** 默认配色方案（用于重置） */
const DEFAULT_COLOR_MAP: Record<string, string> = Object.fromEntries(
  COLOR_TOKENS.map((t) => [t.varName, t.default]),
);

/** 配色方案持久化存储 key */
const COLOR_SCHEMES_STORAGE_KEY = 'urchin.debug.colorSchemes';
/** 当前激活方案名持久化 key */
const ACTIVE_SCHEME_STORAGE_KEY = 'urchin.debug.activeColorScheme';

/** 配色方案条目 */
interface ColorScheme {
  readonly name: string;
  readonly colors: Record<string, string>;
}

/** 从 localStorage 加载已保存的配色方案列表 */
function loadSchemes(): ColorScheme[] {
  try {
    const raw = localStorage.getItem(COLOR_SCHEMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ColorScheme =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as ColorScheme).name === 'string' &&
        typeof (s as ColorScheme).colors === 'object',
    );
  } catch {
    return [];
  }
}

/** 持久化配色方案列表 */
function saveSchemes(schemes: readonly ColorScheme[]): void {
  try {
    localStorage.setItem(COLOR_SCHEMES_STORAGE_KEY, JSON.stringify(schemes));
  } catch {
    // 忽略配额错误
  }
}

function DebugTab({
  entries,
  onChange,
}: {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<Record<string, string>>(() => ({ ...DEFAULT_COLOR_MAP }));
  const [schemes, setSchemes] = useState<ColorScheme[]>(() => loadSchemes());
  const [activeScheme, setActiveScheme] = useState<string>(
    () => localStorage.getItem(ACTIVE_SCHEME_STORAGE_KEY) ?? '',
  );
  const [newSchemeName, setNewSchemeName] = useState('');

  // 右侧边栏悬停展开延迟（ms），从设置读取，默认 300
  const hoverDelayRaw = entries['debug.sidebarHoverDelay'];
  const hoverDelay =
    typeof hoverDelayRaw === 'number' && Number.isFinite(hoverDelayRaw) ? hoverDelayRaw : 300;

  // 收集控制台错误日志
  useEffect(() => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const pushLog = (level: string, args: unknown[]): void => {
      const msg = args
        .map((a) => {
          if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
          if (typeof a === 'object' && a !== null) {
            try {
              return JSON.stringify(a);
            } catch {
              return '[object]';
            }
          }
          return String(a);
        })
        .join(' ');
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      setLogs((prev) => [...prev.slice(-500), `[${time}] ${level} ${msg}`]);
    };

    console.error = (...args: unknown[]) => {
      pushLog('ERROR', args);
      originalError.apply(console, args as never);
    };
    console.warn = (...args: unknown[]) => {
      pushLog('WARN', args);
      originalWarn.apply(console, args as never);
    };

    // 监听未捕获错误
    const onError = (e: ErrorEvent): void => {
      pushLog('UNCAUGHT', [`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`]);
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      pushLog('REJECTION', [e.reason]);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 日志自动滚动到底部
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  // 初始化：读取当前 CSS 变量值（优先用已激活方案的值）
  useEffect(() => {
    if (activeScheme) {
      const found = schemes.find((s) => s.name === activeScheme);
      if (found) {
        setColors({ ...DEFAULT_COLOR_MAP, ...found.colors });
        for (const [k, v] of Object.entries(found.colors)) {
          document.documentElement.style.setProperty(k, v);
        }
        return;
      }
    }
    const root = getComputedStyle(document.documentElement);
    setColors((prev) => {
      const next = { ...prev };
      for (const t of COLOR_TOKENS) {
        const v = root.getPropertyValue(t.varName).trim();
        if (v) next[t.varName] = v;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅初始化时执行
  }, []);

  const handleColorChange = useCallback(
    (varName: string, value: string) => {
      setColors((prev) => ({ ...prev, [varName]: value }));
      document.documentElement.style.setProperty(varName, value);
      // 手动改色后清除"激活方案"标记（当前状态已偏离方案）
      if (activeScheme) {
        setActiveScheme('');
        localStorage.removeItem(ACTIVE_SCHEME_STORAGE_KEY);
      }
    },
    [activeScheme],
  );

  const handleResetColors = useCallback(() => {
    for (const t of COLOR_TOKENS) {
      document.documentElement.style.removeProperty(t.varName);
    }
    setColors({ ...DEFAULT_COLOR_MAP });
    setActiveScheme('');
    localStorage.removeItem(ACTIVE_SCHEME_STORAGE_KEY);
  }, []);

  const handleClearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // 保存当前配色为新方案（同名则覆盖）
  const handleSaveScheme = useCallback(() => {
    const name = newSchemeName.trim();
    if (!name) return;
    const next: ColorScheme = { name, colors: { ...colors } };
    setSchemes((prev) => {
      const filtered = prev.filter((s) => s.name !== name);
      const updated = [...filtered, next];
      saveSchemes(updated);
      return updated;
    });
    setActiveScheme(name);
    localStorage.setItem(ACTIVE_SCHEME_STORAGE_KEY, name);
    setNewSchemeName('');
  }, [colors, newSchemeName]);

  // 应用某个已保存方案
  const handleApplyScheme = useCallback(
    (name: string) => {
      const found = schemes.find((s) => s.name === name);
      if (!found) return;
      setColors({ ...DEFAULT_COLOR_MAP, ...found.colors });
      for (const [k, v] of Object.entries(found.colors)) {
        document.documentElement.style.setProperty(k, v);
      }
      setActiveScheme(name);
      localStorage.setItem(ACTIVE_SCHEME_STORAGE_KEY, name);
    },
    [schemes],
  );

  // 删除某个方案
  const handleDeleteScheme = useCallback(
    (name: string) => {
      setSchemes((prev) => {
        const updated = prev.filter((s) => s.name !== name);
        saveSchemes(updated);
        return updated;
      });
      if (activeScheme === name) {
        setActiveScheme('');
        localStorage.removeItem(ACTIVE_SCHEME_STORAGE_KEY);
      }
    },
    [activeScheme],
  );

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">
        调试
        <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 align-middle text-xs text-warning">
          开发阶段临时
        </span>
      </h1>

      {/* 右侧边栏悬停展开延迟设置 */}
      <div className="mb-6 rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className="text-sm font-medium">右侧边栏悬停展开延迟</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              右侧栏折叠时，鼠标停留多久后自动展开（毫秒，0 = 立即展开，范围 0–3000）
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={3000}
              step={50}
              className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={hoverDelay}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(n)) {
                  onChange('debug.sidebarHoverDelay', Math.max(0, Math.min(3000, n)));
                }
              }}
            />
            <span className="text-xs text-text-secondary">ms</span>
          </div>
        </div>
      </div>

      {/* 运行日志显示框 */}
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium">运行报错日志</div>
        <Button variant="secondary" size="sm" onClick={handleClearLogs}>
          清空
        </Button>
      </div>
      <div
        ref={logBoxRef}
        className="h-48 overflow-y-auto rounded-md border border-border bg-surface-secondary p-3 font-mono text-xs leading-relaxed text-text"
      >
        {logs.length === 0 ? (
          <div className="text-text-secondary">暂无日志输出</div>
        ) : (
          logs.map((line, idx) => (
            <div
              key={idx}
              className={cn(
                'whitespace-pre-wrap break-all',
                line.includes('ERROR') && 'text-error',
                line.includes('UNCAUGHT') && 'text-error',
                line.includes('REJECTION') && 'text-error',
                line.includes('WARN') && 'text-warning',
              )}
            >
              {line}
            </div>
          ))
        )}
      </div>

      {/* 分割线 */}
      <hr className="my-6 border-border" />

      {/* 配色方案管理 */}
      <div className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="mb-2 text-sm font-medium">配色方案</div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 已保存方案列表 */}
          {schemes.length === 0 ? (
            <span className="text-xs text-text-secondary">暂无已保存方案</span>
          ) : (
            schemes.map((s) => (
              <div
                key={s.name}
                className={cn(
                  'flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                  activeScheme === s.name
                    ? 'border-primary bg-primary/10 text-text'
                    : 'border-border bg-surface text-text-secondary hover:text-text',
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5"
                  onClick={() => handleApplyScheme(s.name)}
                  title={`应用方案：${s.name}`}
                >
                  {/* 方案预览色块 */}
                  <span className="flex">
                    {Object.values(s.colors)
                      .slice(0, 4)
                      .map((c, i) => (
                        <span
                          key={i}
                          className="h-3 w-3 rounded-full border border-white/40"
                          style={{ marginLeft: i === 0 ? 0 : -4, backgroundColor: c }}
                        />
                      ))}
                  </span>
                  <span>{s.name}</span>
                </button>
                <button
                  type="button"
                  className="ml-1 text-text-secondary hover:text-error"
                  onClick={() => handleDeleteScheme(s.name)}
                  aria-label={`删除方案 ${s.name}`}
                  title="删除"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        {/* 保存当前配色为新方案 */}
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            className="h-7 flex-1 rounded border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
            placeholder="方案名称（如 深色暖调 / 蓝绿主题）"
            value={newSchemeName}
            onChange={(e) => setNewSchemeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveScheme();
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveScheme}
            disabled={!newSchemeName.trim()}
          >
            保存当前为方案
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-text-secondary">
          方案保存在 localStorage（仅当前用户本机）。手动改色后会自动取消激活态；点击方案即可切换。
        </p>
      </div>

      {/* 配色调整面板 */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">前端组件配色调整</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            实时修改 CSS 变量，影响当前窗口所有组件。重置后恢复默认。
            {activeScheme && <span className="ml-2 text-primary">当前方案：{activeScheme}</span>}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={handleResetColors}>
          重置配色
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {COLOR_TOKENS.map((t) => (
          <div
            key={t.varName}
            className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={colors[t.varName] ?? t.default}
                onChange={(e) => handleColorChange(t.varName, e.target.value)}
                className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent p-0"
                aria-label={`选择 ${t.label} 颜色`}
              />
              <div>
                <div className="text-xs font-medium">{t.label}</div>
                <div className="font-mono text-[10px] text-text-secondary">{t.varName}</div>
              </div>
            </div>
            <input
              type="text"
              className="h-7 w-24 rounded border border-border bg-surface px-2 font-mono text-xs outline-none focus:border-primary"
              value={colors[t.varName] ?? t.default}
              onChange={(e) => handleColorChange(t.varName, e.target.value)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
