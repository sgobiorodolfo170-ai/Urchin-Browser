/**
 * 设置页共享表单机件（refactor-plan-p2 §3.3 步骤 2 前置，代码自
 * SettingsPage.tsx 原样迁出）
 *
 * 职责：字段类型定义（SettingField 等）+ 分组渲染（SettingsSection）+
 * 单字段控件（FieldControl，覆盖 select/toggle/text/password/number/
 * textarea/directory/provider-* 九类）+ Provider 命名配置下拉（ProfileSelect）。
 *
 * OpsTab 等选项卡组件与各 Section 文件共用本文件，避免循环依赖
 * （Section → SettingsPage 会成环）。
 *
 * ⚠ 死代码保留说明（2026-11-05 迁出时核实）：provider-select /
 * provider-name 两类分支与 ProfileSelect 目前无任何 FIELDS 字段触发、
 * profileApi 从未被构造传值（推测为已移除的 AI 提供商配置 UI 残留）。
 * 按「纯移动不改逻辑」原则原样保留，去留待用户决策（AI 助手 tab 尚在
 * 开发中占位，重开配置 UI 时可复用）。
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';

// ───────────────── 类型定义 ─────────────────

/** 单个设置字段类型 */
export type FieldType =
  | 'select'
  | 'toggle'
  | 'text'
  | 'password'
  | 'provider-select'
  | 'provider-name'
  | 'directory'
  | 'number'
  | 'textarea';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SettingField {
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
  /** textarea 类型专用：显示行数（默认 4） */
  readonly rows?: number;
}

/** 命名提供商配置（设置页保存的「提供商名 → 模型/Key/URL」） */
export interface ProviderProfile {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
}

/** 命名配置操作注入接口（由设置页实现，供 FieldControl 使用） */
export interface ProfileApi {
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

/** 将 unknown 值安全转为字符串 */
export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// ───────────────── 设置分组渲染 ─────────────────

export interface SettingsSectionProps {
  readonly title: string;
  readonly fields: readonly SettingField[];
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
  readonly profileApi?: ProfileApi;
}

export function SettingsSection({
  title,
  fields,
  entries,
  onChange,
  profileApi,
}: SettingsSectionProps) {
  return (
    <section>
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <div className="space-y-1">
        {fields.map((field) =>
          field.type === 'textarea' ? (
            <div key={field.key} className="py-3">
              <div className="font-medium">{field.label}</div>
              {field.desc && <div className="mt-0.5 text-xs text-text-secondary">{field.desc}</div>}
              <div className="mt-2">
                <FieldControl
                  field={field}
                  value={entries[field.key]}
                  onChange={(v) => onChange(field.key, v)}
                  profileApi={profileApi}
                />
              </div>
            </div>
          ) : (
            <div key={field.key} className="flex items-center justify-between gap-4 py-3">
              <div className="flex-1">
                <div className="font-medium">{field.label}</div>
                {field.desc && (
                  <div className="mt-0.5 text-xs text-text-secondary">{field.desc}</div>
                )}
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
          ),
        )}
      </div>
    </section>
  );
}

export interface FieldControlProps {
  readonly field: SettingField;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly profileApi?: ProfileApi;
}

export function FieldControl({ field, value, onChange, profileApi }: FieldControlProps) {
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

  // textarea：长文本设置（剪藏模板），横向占满整行
  if (field.type === 'textarea') {
    return (
      <textarea
        className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 text-text outline-none focus:border-primary"
        rows={field.rows ?? 4}
        value={toStr(value)}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
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
export function ProfileSelect({
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
