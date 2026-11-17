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
    desc: '保存界面语言偏好；当前界面暂未随此选项切换。',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en-US', label: 'English' },
    ],
  },
  {
    key: 'searchEngine',
    label: '搜索引擎',
    desc: '地址栏输入普通文字时使用此搜索引擎。',
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
    desc: '控制网页内普通链接的打开位置；网页自身的新窗口链接仍可能另开标签。',
    type: 'toggle',
  },
  {
    key: 'startup.restoreTabs',
    label: '启动时继续浏览上次打开的网页',
    desc: '启动时恢复默认工作区的标签；其他工作区在切换进入时恢复。',
    type: 'toggle',
  },
  {
    key: 'ui.minimizeToTray',
    label: '关闭窗口时最小化到系统托盘',
    desc: '开启后，点击关闭按钮隐藏窗口并在托盘运行；单击托盘图标恢复，右键选「完全退出」结束程序。默认关闭。',
    type: 'toggle',
  },
  {
    key: 'translate.targetLang',
    label: '网页翻译目标语言',
    desc: '整页翻译和划词翻译使用的目标语言，默认简体中文。',
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
    desc: '自动模式按网络环境选择引擎；手动选择指定优先引擎。调用失败时均会尝试其他引擎，可用性取决于网络和服务。',
    type: 'select',
    options: [
      { value: 'auto', label: '自动（推荐）' },
      { value: 'mymemory', label: 'MyMemory 翻译' },
      { value: 'google', label: '谷歌翻译' },
      { value: 'microsoft', label: '微软翻译（兼容选项）' },
    ],
  },
  {
    key: 'translate.autoTranslate',
    label: '自动翻译外语页面',
    desc: '页面语言明确且不同于目标语言时自动翻译，默认关闭。翻译文本会发送至实际使用的翻译服务（含故障切换后的引擎）。',
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
