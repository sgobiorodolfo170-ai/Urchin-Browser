/**
 * 「隐私与安全」选项卡（refactor-plan-p2 §3.3 步骤 6，代码自
 * SettingsPage.tsx 原样迁出）
 *
 * 组成：隐私开关字段（PRIVACY_FIELDS 经共享 SettingsSection 渲染）。
 */
import { SettingsSection, type SettingField } from '../settings-form';

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

export interface PrivacySectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}

export function PrivacySection({ entries, onChange }: PrivacySectionProps) {
  return (
    <SettingsSection
      title="隐私与安全"
      fields={PRIVACY_FIELDS}
      entries={entries}
      onChange={onChange}
    />
  );
}
