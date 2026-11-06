/**
 * 「数据」选项卡（refactor-plan-p2 §3.3 步骤 5，代码自 SettingsPage.tsx 原样迁出）
 *
 * 组成：数据存储字段（DATA_FIELDS 经共享 SettingsSection 渲染，
 * directory 类型控件弹原生目录选择器）。
 */
import { SettingsSection, type SettingField } from '../settings-form';

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
  {
    key: 'clipper.saveDir',
    label: '剪藏保存路径',
    desc: '剪藏文件（Markdown / MHTML / PDF / 截图）的保存目录，重名自动追加序号（留空使用默认位置 documents/clipper，改后立即生效）',
    type: 'directory',
  },
];

export interface DataSectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}

export function DataSection({ entries, onChange }: DataSectionProps) {
  return (
    <SettingsSection title="数据" fields={DATA_FIELDS} entries={entries} onChange={onChange} />
  );
}
