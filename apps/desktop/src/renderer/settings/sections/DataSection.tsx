/**
 * 「数据」选项卡（refactor-plan-p2 §3.3 步骤 5，代码自 SettingsPage.tsx 原样迁出）
 *
 * 组成：数据存储字段（DATA_FIELDS 经共享 SettingsSection 渲染，
 * directory 类型控件弹原生目录选择器）+ 从其他浏览器导入区块
 * （2026-11-10 自「通用」页迁入）。
 */
import { SettingsSection, type SettingField } from '../settings-form';
import { ImportSection } from './ImportSection';

const DATA_FIELDS: readonly SettingField[] = [
  {
    key: 'data.directory',
    label: '数据存储位置',
    desc: '书签、历史、设置、速记及保存文件的根目录。留空使用默认位置，修改后重启生效；pi 数据不随此目录迁移。',
    type: 'directory',
  },
  {
    key: 'downloadsPath',
    label: '下载位置',
    desc: '指定后直接保存到此目录；留空时每次询问，并可将所选位置设为默认。',
    type: 'directory',
  },
  {
    key: 'clipper.saveDir',
    label: '剪藏保存路径',
    desc: '留空保存到数据目录下的 documents/clipper；修改后用于新剪藏，已有文件不移动，重名自动编号。',
    type: 'directory',
  },
];

export interface DataSectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
  readonly onToast: (msg: string) => void;
}

export function DataSection({ entries, onChange, onToast }: DataSectionProps) {
  return (
    <>
      <SettingsSection title="数据" fields={DATA_FIELDS} entries={entries} onChange={onChange} />
      <ImportSection onToast={onToast} />
    </>
  );
}
