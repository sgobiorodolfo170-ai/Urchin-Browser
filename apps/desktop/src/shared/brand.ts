/**
 * 浏览器品牌名 · 最小 locale 探测
 *
 * 设计理由：apps/desktop 当前无 i18n 基础设施（无 i18n 库 / 无翻译文件 / 无 t()）。
 * 本模块仅提供品牌名的 locale 条件渲染，不引入 i18n 框架。
 *
 * 用法：
 * - 渲染进程：displayNameForLocale(navigator.language)
 * - 主进程：displayNameForLocale(app.getLocale())
 *
 * 判定规则：locale 以 "zh" 开头（含 zh-CN / zh-Hans / zh-TW / zh-HK）→ 中文名；
 * 其余 → 英文名。这是 v0.1 阶段的最小实现，后续引入完整 i18n 后可迁移到 t('app.name')。
 */
export const BROWSER_NAME_EN = 'Urchin Browser';
export const BROWSER_NAME_ZH = '顽童浏览器';

/** 按 locale 返回浏览器显示名（zh* → 中文名，其余 → 英文名）。 */
export function displayNameForLocale(locale: string): string {
  return locale.toLowerCase().startsWith('zh') ? BROWSER_NAME_ZH : BROWSER_NAME_EN;
}
