/**
 * 设置页 React 组件（多选项卡布局）
 *
 * 设计：
 * - 左侧选项卡导航，右侧内容区
 * - 自动保存：字段变更后立即写入（debounce 800ms，与主流浏览器设置页对齐）
 * - 选项卡：通用 / 剪藏 / 操作 / AI 助手 / 数据 / 默认应用 / 帮助手册 / 隐私与安全 / 建议与反馈 / 关于 / 运行日志
 *
 * 通过主窗口已有的 window.urchin.invoke('settings.*') 读写设置。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { useSettings } from './use-settings';
import { OpsTab } from './tabs/OpsTab';
import { HelpTab } from './tabs/HelpTab';
import { AboutTab } from './tabs/AboutTab';
import { LogsTab } from './tabs/LogsTab';
import { FeedbackTab } from './tabs/FeedbackTab';
import { FilesTab } from './tabs/FilesTab';
import { AiSection } from './sections/AiSection';
import { ClipperSection } from './sections/ClipperSection';
import { DataSection } from './sections/DataSection';
import { GeneralSection } from './sections/GeneralSection';
import { PrivacySection } from './sections/PrivacySection';

// 类型定义（FieldType/SettingField/ProfileApi 等）与共享表单机件
// （SettingsSection/FieldControl/ProfileSelect/toStr）在 ./settings-form

/** 选项卡定义 */
type TabKey =
  | 'general'
  | 'clipper'
  | 'ops'
  | 'ai'
  | 'data'
  | 'privacy'
  | 'files'
  | 'help'
  | 'feedback'
  | 'about'
  | 'logs';

interface TabDef {
  readonly key: TabKey;
  readonly label: string;
}

const TABS: readonly TabDef[] = [
  { key: 'general', label: '通用' },
  { key: 'clipper', label: '剪藏' },
  { key: 'ops', label: '操作' },
  { key: 'ai', label: 'AI 助手' },
  { key: 'data', label: '数据' },
  { key: 'files', label: '默认应用' },
  { key: 'help', label: '帮助手册' },
  { key: 'privacy', label: '隐私与安全' },
  { key: 'feedback', label: '建议与反馈' },
  { key: 'about', label: '关于' },
  // 2026-11-07 用户指令：关于分类下新增「运行日志」选项卡（日志位置跟随数据目录）
  { key: 'logs', label: '运行日志' },
];

// ───────────────── 主组件 ─────────────────

export interface SettingsPageProps {
  /**
   * 初始选项卡（深链 `urchin://settings?tab=<key>` 传入）；非法值回退 general。
   * 调用方以 key 绑定该值，参数变化时重挂载以生效。
   */
  readonly initialTab?: string;
}

export function SettingsPage({ initialTab }: SettingsPageProps = {}) {
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : 'general',
  );
  const [toast, setToast] = useState<string | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      toastTimer.current = null;
    };
  }, []);
  const showToast = useCallback((msg: string) => {
    if (!mounted.current) return;
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, 1500);
  }, []);

  // 设置加载 / 自动保存（debounce 800ms）/ 重置默认值收拢于 settings/use-settings.ts
  // （entries 为全部设置键的单一真源，跨选项卡共享，见 hook 头注释）
  const { entries, loading, error, saving, updateField, handleReset } = useSettings({
    onToast: showToast,
  });
  const toastText =
    toast && /^(保存|重置)失败：/.test(toast) ? `${toast.split('：')[0]}，请稍后重试。` : toast;

  if (loading) {
    return (
      <div className="ui-state" role="status">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="ui-state" role="alert">
        <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-error" />
        <p>加载失败，请关闭后重新打开设置页。</p>
      </div>
    );
  }

  return (
    <div className="ui-settings-page flex h-full min-w-0 bg-surface text-text">
      {/* 左侧选项卡导航 */}
      <nav
        aria-label="设置分类"
        className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-secondary py-4"
      >
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.key}
            aria-pressed={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center px-4 py-2.5 text-sm text-left transition-colors motion-reduce:transition-none',
              'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary',
              activeTab === tab.key
                ? 'border-l-2 border-primary bg-[color-mix(in_srgb,var(--color-primary)_8%,var(--color-surface))] font-medium text-primary'
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
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="ui-settings-inner mx-auto max-w-3xl px-8 py-6 pb-16">
          {activeTab === 'general' && <GeneralSection entries={entries} onChange={updateField} />}
          {activeTab === 'clipper' && <ClipperSection entries={entries} onChange={updateField} />}
          {activeTab === 'ops' && <OpsTab entries={entries} onChange={updateField} />}
          {activeTab === 'ai' && <AiSection />}
          {activeTab === 'data' && (
            <DataSection entries={entries} onChange={updateField} onToast={showToast} />
          )}
          {activeTab === 'privacy' && <PrivacySection entries={entries} onChange={updateField} />}
          {activeTab === 'files' && <FilesTab onToast={showToast} />}
          {activeTab === 'help' && <HelpTab />}
          {activeTab === 'feedback' && <FeedbackTab />}
          {activeTab === 'about' && <AboutTab />}
          {activeTab === 'logs' && <LogsTab />}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          role={toast.includes('失败') ? 'alert' : 'status'}
          data-tone={toast.includes('失败') ? 'error' : 'success'}
          className="ui-toast pointer-events-none fixed bottom-16 left-1/2 z-50 -translate-x-1/2"
        >
          {toast.includes('失败') ? (
            <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          )}
          {toastText}
        </div>
      )}
    </div>
  );
}
