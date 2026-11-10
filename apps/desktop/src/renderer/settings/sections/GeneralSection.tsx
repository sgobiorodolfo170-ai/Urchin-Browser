/**
 * 「通用」选项卡（refactor-plan-p2 §3.3 步骤 2，代码自 SettingsPage.tsx 原样迁出）
 *
 * 组成：通用设置字段（GENERAL_FIELDS 经共享 SettingsSection 渲染）。
 * 「从其他浏览器导入」区块已于 2026-11-10 迁至「数据」页（ImportSection）。
 */
import { SettingsSection, type SettingField } from '../settings-form';

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
    key: 'ui.minimizeToTray',
    label: '关闭窗口时最小化到系统托盘',
    desc: '开启后点击窗口关闭按钮将隐藏窗口、继续在系统托盘运行（单击托盘图标可重新打开，右键菜单「完全退出」结束程序）；关闭则直接退出程序。默认关闭',
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

export interface GeneralSectionProps {
  readonly entries: Record<string, unknown>;
  readonly onChange: (key: string, value: unknown) => void;
}

export function GeneralSection({ entries, onChange }: GeneralSectionProps) {
  return (
    <SettingsSection title="通用" fields={GENERAL_FIELDS} entries={entries} onChange={onChange} />
  );
}
