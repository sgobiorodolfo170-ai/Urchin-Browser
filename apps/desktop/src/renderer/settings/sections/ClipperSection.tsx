/**
 * 「剪藏」选项卡（refactor-plan-p2 §3.3 步骤 3，代码自 SettingsPage.tsx 原样迁出）
 *
 * 组成：剪藏设置字段（CLIPPER_FIELDS 经共享 SettingsSection 渲染）。
 * 保存位置说明已移至「数据」选项卡（剪藏保存路径字段，2026-11-06 用户需求）。
 */
import { SettingsSection, type SettingField } from '../settings-form';

const CLIPPER_FIELDS: readonly SettingField[] = [
  {
    key: 'clipper.defaultFormat',
    label: '默认保存格式',
    desc: '打开剪藏面板时预选的格式，可在保存前更改。',
    type: 'select',
    options: [
      { value: 'markdown', label: 'Markdown（可编辑）' },
      { value: 'mhtml', label: 'MHTML（图文整页）' },
      { value: 'pdf', label: 'PDF（打印版）' },
      { value: 'screenshot', label: '截图（整页 PNG）' },
    ],
  },
  {
    key: 'clipper.cleanSnapshot',
    label: '快照默认正文清洗',
    desc: 'MHTML、PDF 和截图默认提取正文并重新排版；关闭后按原网页版式保存。',
    type: 'toggle',
  },
  {
    key: 'clipper.selectionPriority',
    label: '优先剪藏选中内容',
    desc: 'Markdown 默认优先保存选中的内容；无选中内容时提取正文，可在面板中切换。',
    type: 'toggle',
  },
  {
    key: 'clipper.loadLazyContent',
    label: '快照前滚动加载懒加载内容',
    desc: '保存快照前滚动页面以加载更多图片；耗时可能增加，不保证加载全部内容。',
    type: 'toggle',
  },
  {
    key: 'clipper.trimBoilerplate',
    label: '剪除正文末尾信息栏',
    desc: '剪去正文末尾连续的来源、作者、责编等短行，不处理正文中间的内容。',
    type: 'toggle',
  },
  {
    key: 'clipper.localizeImages',
    label: 'Markdown 剪藏时下载图片到本地',
    desc: '将 Markdown 图片保存到本地并改用相对路径；下载失败时保留原链接。需要 GenOffice 资源服务可用。',
    type: 'toggle',
  },
  {
    key: 'clipper.noteNameFormat',
    label: '文件名模板',
    desc: '使用标题、日期等变量生成文件名，如 {{title}}-{{date}}；不合法字符会自动处理。',
    type: 'text',
  },
  {
    key: 'clipper.properties',
    label: '页面属性模板',
    desc: '每行填写「属性名: 值模板」，生成 Markdown 顶部属性区；留空不生成。常用变量：{{title}}、{{url}}、{{author}}、{{date}}。',
    type: 'textarea',
    rows: 8,
  },
  {
    key: 'clipper.content',
    label: '正文模板',
    desc: '设置 Markdown 正文内容。{{content}} 表示提取的正文，{{selection}} 表示选中内容。',
    type: 'textarea',
    rows: 5,
  },
];

export interface ClipperSectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}

export function ClipperSection({ entries, onChange }: ClipperSectionProps) {
  return (
    <SettingsSection title="剪藏" fields={CLIPPER_FIELDS} entries={entries} onChange={onChange} />
  );
}
