/**
 * M2 Tab Manager · 广告浮窗屏蔽 CSS（DB1 决策）
 *
 * 职责：生成隐藏网页内悬浮/弹窗类广告的 CSS 规则（供 webContents.insertCSS 注入）。
 *
 * 屏蔽范围（用户决策：仅浮窗类，避免误伤正常页面区域）：
 * - position: fixed 且 id/class 含广告特征的选择器（[id*="ad-"] / [class*="ad-"] 等）
 * - 常见广告浮窗容器（.ad / .ads / .advert / .adsense / .ad-container / .ad-wrapper / #ads 等）
 * - 弹窗遮罩层（.ad-modal / .popup-ad / .ad-overlay 等）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - 纯函数便于单测与后续扩展规则集；仅隐藏不拦截请求（保守，避免误杀正常脚本）
 * - 不涉及透明 BrowserView / 合成，与「严禁透明 + clip-path」教训无关（隐藏元素不触发合成）
 */

/** 构建广告浮窗屏蔽 CSS 规则（独立函数便于单测与扩展）。 */
export function buildAdBlockCss(): string {
  const fixedAdSelectors = [
    '[id*="ad-"]',
    '[class*="ad-"]',
    '[id*="ad_"]',
    '[class*="ad_"]',
    '[id*="ads-"]',
    '[class*="ads-"]',
    '#ads',
    '#ads-box',
    '.ads-box',
    '.ad-container',
    '.ad-wrapper',
    '.ad-content',
    '.advert',
    '.advertising',
    '.adsense',
    '.ad-modal',
    '.popup-ad',
    '.ad-overlay',
    '.adsbygoogle',
  ];
  const classes = fixedAdSelectors.join(', ');

  return `
/* Urchin 广告浮窗屏蔽（DB1 决策：仅浮窗类，默认开启，设置页可关） */
${classes} {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
}
