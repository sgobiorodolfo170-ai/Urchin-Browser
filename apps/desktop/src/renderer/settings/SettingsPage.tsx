/**
 * 设置页 React 组件（多选项卡布局）
 *
 * 设计：
 * - 左侧选项卡导航，右侧内容区
 * - 自动保存：字段变更后立即写入（debounce 800ms，与主流浏览器设置页对齐）
 * - 选项卡：通用 / 操作 / AI 助手 / 数据 / 隐私与安全 / 默认应用 / 关于
 *
 * 通过主窗口已有的 window.urchin.invoke('settings.*') 读写设置。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';

// ───────────────── 类型定义 ─────────────────

/** 单个设置字段类型 */
type FieldType =
  | 'select'
  | 'toggle'
  | 'text'
  | 'password'
  | 'provider-select'
  | 'provider-name'
  | 'directory'
  | 'number';

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
  /** number 类型专用：最小值 */
  readonly min?: number;
  /** number 类型专用：最大值 */
  readonly max?: number;
  /** number 类型专用：步进 */
  readonly step?: number;
  /** number 类型专用：单位后缀（如 ms） */
  readonly unit?: string;
}

/** 命名提供商配置（设置页保存的「提供商名 → 模型/Key/URL」） */
interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

/** 命名配置操作注入接口（由 SettingsPage 实现，供 FieldControl 使用） */
interface ProfileApi {
  readonly profiles: readonly ProviderProfile[];
  /** 「提供商名」输入框草稿 */
  readonly nameDraft: string;
  readonly setNameDraft: (v: string) => void;
  /** 把当前模型/Key/URL 保存为一套命名配置 */
  readonly save: (name: string) => void;
  /** 删除指定 id 的命名配置 */
  readonly remove: (id: string) => void;
  /** 选中命名配置后自动回填模型/Key/URL */
  readonly select: (profile: ProviderProfile) => void;
}

/** 命名配置操作注入接口（由 SettingsPage 实现，供 FieldControl 使用） */
interface ProfileApi {
  readonly profiles: readonly ProviderProfile[];
  /** 「提供商名」输入框草稿 */
  readonly nameDraft: string;
  readonly setNameDraft: (v: string) => void;
  /** 把当前模型/Key/URL 保存为一套命名配置 */
  readonly save: (name: string) => void;
  /** 删除指定 id 的命名配置 */
  readonly remove: (id: string) => void;
  /** 选中命名配置后自动回填模型/Key/URL */
  readonly select: (profile: ProviderProfile) => void;
}

interface SettingsEntry {
  readonly key: string;
  readonly value: unknown;
}

/** 选项卡定义 */
type TabKey = 'general' | 'ops' | 'ai' | 'data' | 'privacy' | 'files' | 'about';

interface TabDef {
  readonly key: TabKey;
  readonly label: string;
}

const TABS: readonly TabDef[] = [
  { key: 'general', label: '通用' },
  { key: 'ops', label: '操作' },
  { key: 'ai', label: 'AI 助手' },
  { key: 'data', label: '数据' },
  { key: 'privacy', label: '隐私与安全' },
  { key: 'files', label: '默认应用' },
  { key: 'about', label: '关于' },
];

// ───────────────── 设置项分组（按选项卡组织） ─────────────────

const GENERAL_FIELDS: readonly SettingField[] = [
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
    desc: '地址栏搜索使用的引擎（与 parse-input 的 SEARCH_ENGINE_TEMPLATES 表对应）',
    type: 'select',
    options: [
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
      { value: 'baidu', label: '百度' },
      { value: 'duckduckgo', label: 'DuckDuckGo' },
      { value: 'sogou', label: '搜狗' },
      { value: 'so360', label: '360 搜索' },
    ],
  },
  {
    key: 'links.openInNewTab',
    label: '在新标签页打开链接',
    desc: '点击网页内链接时在新标签页打开（关闭则在当前标签页打开）',
    type: 'toggle',
  },
  {
    key: 'startup.restoreTabs',
    label: '启动时继续浏览上次打开的网页',
    desc: '关闭浏览器时保存当前打开的标签页，下次启动时自动恢复默认工作区的标签；其他工作区的标签在切换到该工作区时自动恢复',
    type: 'toggle',
  },
  {
    key: 'translate.targetLang',
    label: '网页翻译目标语言',
    desc: '整页翻译与划词翻译的目标语言（默认简体中文）',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'zh-TW', label: '繁體中文' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
      { value: 'fr', label: 'Français' },
      { value: 'de', label: 'Deutsch' },
      { value: 'ru', label: 'Русский' },
      { value: 'es', label: 'Español' },
    ],
  },
  {
    key: 'translate.engine',
    label: '翻译引擎',
    desc: '自动（推荐）：直连网络优先 MyMemory 翻译、走代理优先谷歌翻译，引擎失败自动切换至其他可用引擎（三引擎互为兜底）；也可手动锁定单一引擎。注：微软免费端点已于 2026-09 关闭，保留选项但可能不可用',
    type: 'select',
    options: [
      { value: 'auto', label: '自动（推荐）' },
      { value: 'mymemory', label: 'MyMemory 翻译（国内直连可用）' },
      { value: 'google', label: '谷歌翻译（需代理）' },
      { value: 'microsoft', label: '微软翻译（端点已关闭，可能不可用）' },
    ],
  },
  {
    key: 'translate.autoTranslate',
    label: '自动翻译外语页面',
    desc: '开启后打开外语网页时自动翻译为目标语言（默认关闭）。隐私提示：翻译时页面文本将发送至所选翻译服务（微软/谷歌）；关闭时仅在手动点击翻译后发送',
    type: 'toggle',
  },
];

const OPS_FIELDS: readonly SettingField[] = [
  {
    key: 'ui.rightSidebarAutoExpand',
    label: '右侧边栏展开方式',
    desc: '切换展开方式：双击展开（默认）/ 悬停自动展开。开启=悬停自动展开，关闭=双击展开',
    type: 'select',
    options: [
      { value: 'false', label: '双击展开' },
      { value: 'true', label: '悬停自动展开' },
    ],
  },
  {
    key: 'debug.sidebarHoverDelay',
    label: '右侧边栏悬停展开延迟',
    desc: '右侧栏折叠时，鼠标停留多久后自动展开（毫秒，0 = 立即展开，范围 0–3000）。仅在「展开方式=悬停自动展开」时生效',
    type: 'number',
    min: 0,
    max: 3000,
    step: 50,
    unit: 'ms',
  },
  {
    key: 'ui.workspaceSwitcherMode',
    label: '折叠态工作区切换',
    desc: '右侧栏折叠时切换工作区的方式：滚轮循环切换（默认）或点击图标打开工作区总览页（卡片 + 网页快照，参考 ego-lite Space 设计）；展开态选项条不受影响',
    type: 'select',
    options: [
      { value: 'wheel', label: '滚轮循环切换' },
      { value: 'cards', label: '点击卡片' },
    ],
  },
];

const DATA_FIELDS: readonly SettingField[] = [
  {
    key: 'data.directory',
    label: '数据存储位置',
    desc: '书签、历史、设置、截图、下载、网页保存的根目录（留空使用默认位置）。修改后重启生效；pi 对话数据与设置固定存于 userData/pi，不随此目录变动',
    type: 'directory',
  },
  {
    key: 'downloadsPath',
    label: '下载位置',
    desc: '下载保存目录（留空 = 每次下载询问保存位置，确认时可设为默认）',
    type: 'directory',
  },
];

const PRIVACY_FIELDS: readonly SettingField[] = [
  { key: 'blockTrackers', label: '拦截追踪器', desc: '阻止第三方追踪脚本', type: 'toggle' },
  { key: 'doNotTrack', label: '请勿追踪', desc: '发送 DNT 头', type: 'toggle' },
  {
    key: 'blockAds',
    label: '屏蔽广告浮窗',
    desc: '隐藏网页内悬浮/弹窗类广告（如固定悬浮广告层、弹窗遮罩）',
    type: 'toggle',
  },
];

/** 默认值（用于重置） */
const DEFAULTS: Record<string, unknown> = {
  language: 'zh-CN',
  searchEngine: 'google',
  downloadsPath: '',
  blockTrackers: true,
  doNotTrack: true,
  blockAds: true,
  'links.openInNewTab': false,
  'ui.rightSidebarAutoExpand': false,
  'ui.workspaceSwitcherMode': 'wheel',
  'debug.sidebarHoverDelay': 300,
  'ui.statusBall.sensitivityVertical': 1,
  'ui.statusBall.sensitivityHorizontal': 1,
  'translate.targetLang': 'zh-CN',
  'translate.engine': 'auto',
  'translate.autoTranslate': false,
  'startup.restoreTabs': true,
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

export interface SettingsPageProps {
  /**
   * 初始选项卡（深链 `urchin://settings?tab=<key>` 传入）；非法值回退 general。
   * 调用方以 key 绑定该值，参数变化时重挂载以生效。
   */
  readonly initialTab?: string;
}

export function SettingsPage({ initialTab }: SettingsPageProps = {}) {
  const [entries, setEntries] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : 'general',
  );
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
            <>
              <SettingsSection
                title="通用"
                fields={GENERAL_FIELDS}
                entries={entries}
                onChange={updateField}
              />
              <ImportBookmarksBlock onToast={showToast} />
            </>
          )}
          {activeTab === 'ops' && <OpsTab entries={entries} onChange={updateField} />}
          {activeTab === 'ai' && (
            <section>
              <h1 className="mb-6 text-2xl font-semibold">AI 助手</h1>
              <div className="rounded-md border border-border bg-surface-secondary px-6 py-12 text-center">
                <p className="text-sm text-text-secondary">AI 助手功能正在开发中，敬请期待。</p>
              </div>
            </section>
          )}
          {activeTab === 'data' && (
            <SettingsSection
              title="数据"
              fields={DATA_FIELDS}
              entries={entries}
              onChange={updateField}
            />
          )}
          {activeTab === 'privacy' && (
            <SettingsSection
              title="隐私与安全"
              fields={PRIVACY_FIELDS}
              entries={entries}
              onChange={updateField}
            />
          )}
          {activeTab === 'files' && <FilesTab onToast={showToast} />}
          {activeTab === 'about' && <AboutTab />}
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
  readonly onChange: (key: string, value: unknown) => void;
  readonly profileApi?: ProfileApi;
}

function SettingsSection({ title, fields, entries, onChange, profileApi }: SettingsSectionProps) {
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
                onChange={(v) => onChange(field.key, v)}
                profileApi={profileApi}
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
  readonly onChange: (value: unknown) => void;
  readonly profileApi?: ProfileApi;
}

function FieldControl({ field, value, onChange, profileApi }: FieldControlProps) {
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
    return <ProfileSelect value={toStr(value)} profileApi={profileApi} />;
  }

  if (field.type === 'provider-name') {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="text"
          className="h-8 min-w-0 flex-1"
          value={profileApi?.nameDraft ?? ''}
          onChange={(e) => profileApi?.setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              profileApi?.save(profileApi.nameDraft);
              profileApi?.setNameDraft('');
            }
          }}
          placeholder="输入配置名（如 公司 OpenAI）"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          disabled={!profileApi?.nameDraft.trim()}
          onClick={() => {
            if (profileApi) {
              profileApi.save(profileApi.nameDraft);
              profileApi.setNameDraft('');
            }
          }}
        >
          保存配置
        </Button>
      </div>
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

  // number：数值输入框（带 min/max/step/单位后缀），用于延迟、灵敏度等数值型设置
  if (field.type === 'number') {
    const num = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const lo = field.min ?? -Infinity;
    const hi = field.max ?? Infinity;
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
          value={num}
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            if (Number.isFinite(n)) {
              onChange(Math.max(lo, Math.min(hi, n)));
            }
          }}
        />
        {field.unit && <span className="text-xs text-text-secondary">{field.unit}</span>}
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

/**
 * 「默认 Provider」下拉（自定义，仅列已保存的命名配置）。
 *
 * 不用原生 <select>：需要在选项项内提供可点击的 × 删除符号，
 * 原生 option 无法承载交互。交互：
 * - 点击收起按钮展开/收起；点击配置名选中并自动回填模型/Key/URL
 * - 每项右侧 × 直接删除该配置（删除不触发选中）
 * - 未选中或无配置时按钮保持空白
 */
function ProfileSelect({
  value,
  profileApi,
}: {
  readonly value: string;
  readonly profileApi?: ProfileApi;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击组件外部时收起下拉
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const profiles = profileApi?.profiles ?? [];
  const selected = profiles.find((p) => p.id === value);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="选择默认 Provider"
        className="h-8 w-full rounded-md border border-border bg-surface px-2 text-left text-sm text-text outline-none focus:border-primary"
        onClick={() => setOpen((v) => !v)}
      >
        {selected?.name ?? ''}
      </button>
      {open &&
        (profiles.length === 0 ? (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-secondary shadow-md">
            暂无已保存配置
          </div>
        ) : (
          <div className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-md">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={cn(
                  'flex items-center justify-between px-1',
                  p.id === value ? 'bg-primary/10' : 'hover:bg-surface-secondary',
                )}
              >
                <button
                  type="button"
                  aria-label={p.name}
                  className="min-w-0 flex-1 truncate px-1.5 py-1.5 text-left text-sm text-text"
                  onClick={() => {
                    // 选中命名配置：自动加载该配置的模型/Key/URL
                    profileApi?.select(p);
                    setOpen(false);
                  }}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  aria-label={`删除配置 ${p.name}`}
                  title={`删除配置 ${p.name}`}
                  className="shrink-0 rounded px-1.5 py-1.5 text-base leading-none text-text-secondary hover:text-error"
                  onClick={() => profileApi?.remove(p.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

// ───────────────── 更新选项卡 ─────────────────

/** update.* IPC 状态快照（与 packages/ipc-contract updateStateSchema 对齐）。 */
interface UpdateStateView {
  readonly status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly releaseName?: string;
  readonly releaseNotes?: string;
  readonly progress?: {
    readonly percent: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond: number;
  };
  readonly error?: string;
  readonly checkedAt?: string;
}

/** 字节数 → 人类可读文案（下载进度用）。 */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** ISO 时间 → 本地时间文案（检查时间展示）。 */
function formatCheckedAt(iso?: string): string {
  if (!iso) return '未检查';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '未检查' : t.toLocaleString('zh-CN');
}

/** 状态 → 一句话描述（错误优先展示具体原因）。 */
function describeUpdateChannel(currentVersion?: string): string {
  if (!currentVersion) return '…';
  return /^\d+\.\d+\.\d+-/.test(currentVersion)
    ? 'dev（GitHub Releases 预发布）'
    : 'latest（GitHub Releases 正式版）';
}

function describeUpdateStatus(state: UpdateStateView | null, actionError: string | null): string {
  switch (state?.status ?? 'idle') {
    case 'disabled':
      return '开发模式下不检查更新（安装版自动连接 GitHub Releases）';
    case 'checking':
      return '正在检查更新…';
    case 'up-to-date':
      return '已是最新版本';
    case 'available':
      return `发现新版本 v${state?.latestVersion ?? ''}`;
    case 'downloading':
      return `正在下载 v${state?.latestVersion ?? ''}…`;
    case 'downloaded':
      return `新版本 v${state?.latestVersion ?? ''} 已下载，重启后完成更新`;
    case 'installing':
      return '正在退出并安装，应用将自动重启…';
    case 'error':
      return actionError ?? state?.error ?? '更新失败';
    default:
      return '点击「立即检查」连接 GitHub Releases 获取最新版本';
  }
}

/**
 * 「操作」选项卡：侧栏/工作区/悬浮球设置。
 */
function OpsTab({
  entries,
  onChange,
}: {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}) {
  const sensVRaw = entries['ui.statusBall.sensitivityVertical'];
  const ballSensV = typeof sensVRaw === 'number' && Number.isFinite(sensVRaw) ? sensVRaw : 1;
  const sensHRaw = entries['ui.statusBall.sensitivityHorizontal'];
  const ballSensH = typeof sensHRaw === 'number' && Number.isFinite(sensHRaw) ? sensHRaw : 1;

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold">操作</h1>
      <SettingsSection
        title="侧栏与工作区"
        fields={OPS_FIELDS}
        entries={entries}
        onChange={onChange}
      />

      {/* 地址栏悬浮球滚动灵敏度设置 */}
      <div className="mt-6 rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-sm font-medium">地址栏悬浮球滚动灵敏度</div>
        <div className="mt-0.5 text-xs text-text-secondary">
          按住悬浮球拖动滚动网页时的位移倍率（上下/左右独立可调；0.1–5.0，默认
          1.0）。拖到限位后继续按住，网页仍会持续滚动直到松手。
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">上下</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensV}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityVertical', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-10 text-xs text-text-secondary">左右</span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.1}
              className="flex-1"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
            <input
              type="number"
              min={0.1}
              max={5}
              step={0.1}
              className="h-8 w-16 rounded-md border border-border bg-surface px-2 text-sm text-text outline-none focus:border-primary"
              value={ballSensH}
              onChange={(e) => {
                const n = Number.parseFloat(e.target.value);
                if (Number.isFinite(n)) {
                  onChange('ui.statusBall.sensitivityHorizontal', Math.max(0.1, Math.min(5, n)));
                }
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function UpdateSection() {
  const [state, setState] = useState<UpdateStateView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (payload: unknown): void => {
      if (alive) setState(payload as UpdateStateView);
    };
    // 主进程状态变化推送（下载进度 / 已下载 / 错误…）
    const off = window.urchin.on('update:event', apply);
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        apply(s);
        const status = (s as UpdateStateView).status;
        // 打开更新页自动检查一次（进行中/已下载/安装中/开发态不打扰）
        if (
          status === 'idle' ||
          status === 'up-to-date' ||
          status === 'available' ||
          status === 'error'
        ) {
          return window.urchin.invoke('update.check', {}).then(apply, () => undefined);
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = useCallback((channel: 'update.check' | 'update.download' | 'update.install') => {
    setActionError(null);
    void window.urchin.invoke(channel, {}).then(
      (s) => {
        if (s && typeof s === 'object' && 'status' in s) setState(s as UpdateStateView);
      },
      (e: unknown) => setActionError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const status = state?.status ?? 'idle';
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';
  const errorText = actionError ?? (status === 'error' ? state?.error : undefined);
  const progress = state?.progress ?? { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };

  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-3 text-sm font-medium">更新检查</div>
      <div className="rounded-md border border-border bg-surface-secondary px-4 py-3">
        <div className="text-xs text-text-secondary">当前版本</div>
        <div className="mt-1 text-lg font-medium">v{state?.currentVersion ?? '…'}</div>
        <div className="mt-1 text-xs text-text-secondary">
          更新通道：{describeUpdateChannel(state?.currentVersion)}
        </div>
      </div>

      <div className="rounded-md border border-border px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-medium">检查更新</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              {describeUpdateStatus(state, actionError)}（上次检查：
              {formatCheckedAt(state?.checkedAt)}）
            </div>
            {errorText && <div className="mt-1 text-xs text-error">{errorText}</div>}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => run('update.check')}
            disabled={busy || status === 'disabled'}
          >
            {status === 'checking' ? '检查中…' : '立即检查'}
          </Button>
        </div>
      </div>

      {status === 'available' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">发现新版本 v{state?.latestVersion ?? ''}</div>
          {state?.releaseName && (
            <div className="mt-0.5 text-xs text-text-secondary">{state.releaseName}</div>
          )}
          {state?.releaseNotes && (
            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-surface-secondary p-2 text-xs text-text-secondary">
              {state.releaseNotes}
            </pre>
          )}
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.download')}>
              下载并更新
            </Button>
          </div>
        </div>
      )}

      {status === 'downloading' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="font-medium">正在下载 v{state?.latestVersion ?? ''}</div>
            <div className="text-xs text-text-secondary">{Math.floor(progress.percent)}%</div>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-secondary"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(progress.percent)}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.min(100, progress.percent)}%` }}
            />
          </div>
          <div className="mt-1.5 text-xs text-text-secondary">
            {formatBytes(progress.transferred)} / {formatBytes(progress.total)} ·{' '}
            {formatBytes(progress.bytesPerSecond)}/s
          </div>
        </div>
      )}

      {status === 'downloaded' && (
        <div className="rounded-md border border-border px-4 py-3">
          <div className="font-medium">v{state?.latestVersion ?? ''} 已就绪</div>
          <div className="mt-0.5 text-xs text-text-secondary">
            点击「重启并安装」立即更新；直接退出应用也会自动完成安装。
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" size="sm" onClick={() => run('update.install')}>
              重启并安装
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────── 关于选项卡 ─────────────────

function AboutTab() {
  // 应用版本经 update.getState 取主进程 app.getVersion()（打包时由
  // package-win.mjs 从 CHANGELOG 盖章 0.1.0-dev.NNN；开发态为 package.json 的 0.1.0）
  const [appVersion, setAppVersion] = useState<string>('—');
  useEffect(() => {
    let alive = true;
    void window.urchin
      .invoke('update.getState', {})
      .then((s) => {
        if (alive) setAppVersion((s as UpdateStateView).currentVersion);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

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
          <div className="mt-1 text-sm text-text-secondary">版本 {appVersion}</div>
          <div className="mt-3 text-xs text-text-secondary">
            一款基于 Electron + Chromium 的 AI 浏览器，集成多 Provider AI 助手与隐私保护。
          </div>
        </div>

        {/* 更新检查（原「更新」选项卡内容移入此处） */}
        <UpdateSection />

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

// ───────────────── 默认应用选项卡（Windows 文件关联） ─────────────────

/** 分组定义（与主进程 file-association/associations.ts 的 ASSOCIATION_GROUPS 对齐）。 */
interface AssociationGroupDef {
  readonly id: 'media' | 'documents' | 'images';
  readonly label: string;
  readonly description: string;
}

const ASSOCIATION_GROUP_DEFS: readonly AssociationGroupDef[] = [
  { id: 'media', label: '音视频', description: 'MP3 / MP4 / WAV 等音频视频文件' },
  { id: 'documents', label: '文档', description: 'PDF / Markdown / 文本 / JSON 等文档文件' },
  { id: 'images', label: '图片', description: 'PNG / JPG / GIF / SVG 等图片文件' },
];

interface GroupStatus {
  readonly registered: number;
  readonly total: number;
  readonly extensions: readonly string[];
}

/**
 * 「从其他浏览器导入收藏夹」区块（通用选项卡底部，dev.119）。
 *
 * 交互：
 * - 「从书签 HTML 文件导入…」→ import.bookmarksFromFile（主进程弹文件选择器）
 * - 「检测本机浏览器」→ import.detectBrowsers → 列表，每行「导入收藏夹」按钮
 *   → import.bookmarksFromBrowser（按 id 导入指定 profile）
 * - 结果 toast：「已导入 N 个书签、M 个文件夹（跳过 K）」；取消时 toast「已取消」
 *
 * 导入的书签放入收藏夹根目录下「导入自 <浏览器> (YYYY-MM-DD)」文件夹，
 * 完整保留原目录结构，可整夹删除回退（详见 docs/数据导入评估.md）。
 */
function ImportBookmarksBlock({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [browsers, setBrowsers] = useState<ImportedBrowserInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [fileImporting, setFileImporting] = useState(false);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const res = (await window.urchin.invoke('import.detectBrowsers', {})) as {
        browsers: ImportedBrowserInfo[];
      };
      setBrowsers(res.browsers ?? []);
      if ((res.browsers ?? []).length === 0) {
        onToast('未检测到可导入的浏览器');
      }
    } catch (e) {
      onToast('检测失败：' + String(e));
    } finally {
      setDetecting(false);
    }
  }, [onToast]);

  const handleFromFile = useCallback(async () => {
    setFileImporting(true);
    try {
      const res = (await window.urchin.invoke('import.bookmarksFromFile', {})) as {
        canceled: boolean;
        summary: ImportSummaryInfo | null;
      };
      if (res.canceled || !res.summary) {
        onToast('已取消');
        return;
      }
      onToast(summaryToast(res.summary));
    } catch (e) {
      onToast('导入失败：' + String(e));
    } finally {
      setFileImporting(false);
    }
  }, [onToast]);

  const handleFromBrowser = useCallback(
    async (id: string) => {
      setImporting(id);
      try {
        const res = (await window.urchin.invoke('import.bookmarksFromBrowser', { id })) as {
          canceled: boolean;
          summary: ImportSummaryInfo | null;
        };
        if (res.canceled || !res.summary) {
          onToast('已取消');
          return;
        }
        onToast(summaryToast(res.summary));
      } catch (e) {
        onToast('导入失败：' + String(e));
      } finally {
        setImporting(null);
      }
    },
    [onToast],
  );

  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">从其他浏览器导入</h2>
      <p className="mb-4 text-sm text-text-secondary">
        导入 Chrome / Edge / Firefox 的收藏夹，或从书签 HTML 文件导入。导入的书签会放入
        收藏夹根目录下「导入自 &lt;浏览器&gt;
        (&lt;日期&gt;)」文件夹，完整保留原目录结构，可整夹删除回退。
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={fileImporting}
          onClick={() => void handleFromFile()}
        >
          {fileImporting ? '导入中…' : '从书签 HTML 文件导入…'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting}
          onClick={() => void handleDetect()}
        >
          {detecting ? '检测中…' : '检测本机浏览器'}
        </Button>
      </div>

      {browsers.length > 0 && (
        <div className="mt-4 space-y-2">
          {browsers.map((b) => {
            const key = b.id;
            return (
              <div
                key={key}
                className="flex items-center justify-between rounded-md border border-border bg-surface-secondary px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="font-medium">{b.displayName}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{b.profileName}</div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing === b.id}
                  onClick={() => void handleFromBrowser(b.id)}
                >
                  {importing === b.id ? '导入中…' : '导入收藏夹'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 已检测浏览器 profile 的最小结构（与 ipc-contract ImportedBrowser 对齐）。 */
interface ImportedBrowserInfo {
  readonly id: string;
  readonly kind: 'chrome' | 'edge' | 'firefox';
  readonly displayName: string;
  readonly profileName: string;
  readonly profileDir: string;
  readonly bookmarksSource: 'chromium-json' | 'firefox-places';
}

/** 导入结果摘要（与 ipc-contract ImportSummary 对齐）。 */
interface ImportSummaryInfo {
  readonly folders: number;
  readonly bookmarks: number;
  readonly skipped: number;
  readonly rootFolderId: string;
  readonly rootFolderTitle: string;
}

/** 摘要 → toast 文案。 */
function summaryToast(s: ImportSummaryInfo): string {
  return `已导入 ${s.bookmarks} 个书签、${s.folders} 个文件夹${s.skipped > 0 ? `（跳过 ${s.skipped}）` : ''}`;
}

/**
 * 「默认应用」选项卡：把本浏览器注册为音视频/文档/图片的打开方式。
 *
 * 交互：每张卡片显示该组扩展名与注册状态；点「设为默认打开方式」→
 * file-association.register → 主进程写 HKCU 注册表 → 刷新状态 + toast。
 * 注册后浏览器出现在 Windows「打开方式 → 选择其他应用」列表，用户勾选
 * 「始终使用」即由系统完成永久默认（UserChoice 由 Windows 写入）。
 */
function FilesTab({ onToast }: { readonly onToast: (msg: string) => void }) {
  const [statuses, setStatuses] = useState<Record<string, GroupStatus> | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file-association.getStatus', {})) as {
        groups: Record<string, GroupStatus>;
      };
      setStatuses(res.groups);
    } catch (e) {
      onToast('读取关联状态失败：' + String(e));
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleRegister = useCallback(
    async (groupId: string) => {
      setRegistering(groupId);
      try {
        await window.urchin.invoke('file-association.register', { group: groupId });
        onToast('已注册。可在系统「打开方式」选择 Urchin Browser 并勾选"始终使用"');
        await loadStatus();
      } catch (e) {
        onToast('注册失败：' + String(e));
      } finally {
        setRegistering(null);
      }
    },
    [loadStatus, onToast],
  );

  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">默认应用</h1>
      <p className="mb-6 text-sm text-text-secondary">
        把 Urchin Browser 设为音视频、文档、图片的打开方式。注册后，双击这类文件
        即可用本浏览器打开；在系统「打开方式 → 选择其他应用」中勾选「始终使用」， 即可设为永久默认。
      </p>

      {loading && <p className="text-text-secondary">加载中…</p>}
      {!loading &&
        ASSOCIATION_GROUP_DEFS.map((group) => {
          const status = statuses?.[group.id];
          return (
            <div
              key={group.id}
              className="mb-4 rounded-md border border-border bg-surface-secondary px-4 py-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{group.label}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">{group.description}</div>
                </div>
                {status && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs',
                      status.registered > 0
                        ? 'bg-success/15 text-success'
                        : 'bg-text-secondary/10 text-text-secondary',
                    )}
                  >
                    {status.registered}/{status.total} 已关联
                  </span>
                )}
              </div>
              {status && status.extensions.length > 0 && (
                <div className="mt-3 text-xs text-text-secondary">
                  {status.extensions.map((e) => `.${e}`).join(' ')}
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                disabled={registering === group.id}
                onClick={() => void handleRegister(group.id)}
              >
                {registering === group.id ? '注册中…' : '设为默认打开方式'}
              </Button>
            </div>
          );
        })}
    </section>
  );
}
