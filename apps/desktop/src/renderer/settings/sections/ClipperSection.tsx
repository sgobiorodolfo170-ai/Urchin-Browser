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
    desc: '打开剪藏面板时预选的格式。MHTML/PDF/截图用于图文网页存档；OCR 暂未实现',
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
    desc: 'MHTML/PDF/截图默认使用 Defuddle 正文重新排版，去掉广告、导航、侧栏等；关闭则保留原页版式',
    type: 'toggle',
  },
  {
    key: 'clipper.selectionPriority',
    label: '优先剪藏选中内容',
    desc: 'Markdown 剪藏时，如果页面有选中文本则优先使用选中内容；可在面板中临时切换',
    type: 'toggle',
  },
  {
    key: 'clipper.loadLazyContent',
    label: '快照前滚动加载懒加载内容',
    desc: '快照格式保存前先分步滚动页面，尽量加载懒加载图片（最多 20 步，可能较慢）',
    type: 'toggle',
  },
  {
    key: 'clipper.trimBoilerplate',
    label: '剪除正文末尾信息栏',
    desc: '自动去掉正文末尾的「来源：/作者：/评论：/责编：」等中文信息栏短行（只剪末尾连续短行，不动正文中间的合法引用）',
    type: 'toggle',
  },
  {
    key: 'clipper.localizeImages',
    label: 'Markdown 剪藏时下载图片到本地',
    desc: '剪藏为 Markdown 时把远程图片下载到 assets/ 目录，md 中改为本地相对路径。下载失败的图片保留原链接。需 GenOffice 编辑器可用',
    type: 'toggle',
  },
  {
    key: 'clipper.noteNameFormat',
    label: '文件名模板',
    desc: '支持 {{title}} / {{date}} / {{domain}} 等变量；最终文件名由主进程净化',
    type: 'text',
  },
  {
    key: 'clipper.properties',
    label: '页面属性模板',
    desc: '每行一条「key: 值模板」，保存为 YAML frontmatter。留空则不生成属性区。可用变量：{{title}} {{url}} {{author}} {{published}} {{date}} {{description}} {{site}} {{content}} {{selection}}',
    type: 'textarea',
    rows: 8,
  },
  {
    key: 'clipper.content',
    label: '正文模板',
    desc: 'Markdown 正文模板；{{content}} 为抽取正文，{{selection}} 为选中内容。属性区之外的内容都写在这里',
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
