/**
 * 设置页 React 组件（多选项卡布局）
 *
 * 设计：
 * - 左侧选项卡导航，右侧内容区
 * - 自动保存：字段变更后立即写入（debounce 800ms，与主流浏览器设置页对齐）
 * - 选项卡：通用 / 操作 / AI 助手 / 数据 / 默认应用 / 帮助手册 / 隐私与安全 / 建议与反馈 / 关于
 *
 * 通过主窗口已有的 window.urchin.invoke('settings.*') 读写设置。
 */
import { useCallback, useState } from 'react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { useSettings } from './use-settings';
import { OpsTab } from './tabs/OpsTab';
import { HelpTab } from './tabs/HelpTab';
import { AboutTab } from './tabs/AboutTab';
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
  | 'about';

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

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1500);
  }, []);

  // 设置加载 / 自动保存（debounce 800ms）/ 重置默认值收拢于 settings/use-settings.ts
  // （entries 为全部设置键的单一真源，跨选项卡共享，见 hook 头注释）
  const { entries, loading, error, saving, updateField, handleReset } = useSettings({
    onToast: showToast,
  });

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
            <GeneralSection entries={entries} onChange={updateField} onToast={showToast} />
          )}
          {activeTab === 'clipper' && <ClipperSection entries={entries} onChange={updateField} />}
          {activeTab === 'ops' && <OpsTab entries={entries} onChange={updateField} />}
          {activeTab === 'ai' && <AiSection />}
          {activeTab === 'data' && <DataSection entries={entries} onChange={updateField} />}
          {activeTab === 'privacy' && <PrivacySection entries={entries} onChange={updateField} />}
          {activeTab === 'files' && <FilesTab onToast={showToast} />}
          {activeTab === 'help' && <HelpTab />}
          {activeTab === 'feedback' && <FeedbackTab />}
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
