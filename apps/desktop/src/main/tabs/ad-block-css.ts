/**
 * M2 Tab Manager · 广告浮窗屏蔽 CSS（DB1 决策）
 *
 * 职责：生成隐藏网页内悬浮/弹窗类广告的 CSS 规则（供 webContents.insertCSS 注入）。
 *
 * 屏蔽范围（用户决策：仅浮窗类，避免误伤正常页面区域）：
 * - 业界通用的广告容器类名（精确匹配 .advert / .adsense / .ad-container 等）
 * - 弹窗遮罩层（.ad-modal / .popup-ad / .ad-overlay 等）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点）：
 * - 纯函数便于单测与后续扩展规则集；仅隐藏不拦截请求（保守，避免误杀正常脚本）
 * - 不涉及透明 BrowserView / 合成，与「严禁透明 + clip-path」教训无关（隐藏元素不触发合成）
 *
 * ⚠️ 严禁使用子串匹配选择器（2026-10-02 固化教训）：
 * 早期版本曾使用 [id*="ad-"] / [class*="ad-"] / [id*="ad_"] / [class*="ad_"]
 * / [id*="ads-"] / [class*="ads-"] 这类 CSS 子串匹配选择器，意图是「class/id
 * 含广告特征即隐藏」。但 [attr*=value] 是**子串匹配**——任何 class/id 中
 * 含 "ad-"/"ad_"/"ads-" 子串的元素都会被 display:none !important。
 *
 * 这导致大量**正常组件**被误伤（百度的 head-tab/upload-area/loading-shadow
 * /read-more/grad-overlay/thread-card/sidenav-link 等 class 均含 "ad-" 子串），
 * 表现为「打开网页后出现很多空白地方，组件显示不全」。同样问题在其他主流
 * 网站也普遍存在（凡是 class 命名含 upload-/download-/header-/thread-/grad-
 * /loading-/read-/sidenav- 等子串的元素全部被误隐藏）。
 *
 * 现回滚为**仅业界通用精确类名匹配**：
 * - 选择器全部为 .class / #id 形式（精确匹配完整 class token，不做子串匹配）
 * - 仅匹配广告联盟与浮窗广告业界事实通用的类名（.adsbygoogle / .adsense /
 *   .advert / .advertising / .ad-container / .ad-wrapper / .ad-modal 等）
 * - 误伤风险显著降低：正常网页组件极少使用 .adsbygoogle / .adsense 作为
 *   非广告用途的 class 名
 *
 * 同时简化规则：仅 display:none !important。visibility 与 pointer-events
 * 在 display:none 后冗余（元素不渲染即不接收事件，也无可见性可言），删去。
 */

/** 构建广告浮窗屏蔽 CSS 规则（独立函数便于单测与扩展）。 */
export function buildAdBlockCss(): string {
  // 仅业界通用的广告类名（精确匹配，不做子串匹配，避免误伤正常组件）。
  // 新增规则前必须评估：该 class 名在正常网页中是否可能被用作非广告用途。
  const adSelectors = [
    // 通用广告容器类名（业界事实标准）
    '.ad-container',
    '.ad-wrapper',
    '.ad-content',
    '.advert',
    '.advertising',
    '.adsense',
    '.adsbygoogle',
    // 弹窗/浮窗/遮罩类广告
    '.ad-modal',
    '.popup-ad',
    '.ad-overlay',
    // 兜底通用 id/class（#ads / .ads-box 等业界惯例）
    '#ads',
    '#ads-box',
    '.ads-box',
  ];
  const selectors = adSelectors.join(', ');

  return `
/* Urchin 广告浮窗屏蔽（DB1 决策：仅业界通用广告类名，默认开启，设置页可关） */
${selectors} {
  display: none !important;
}
`;
}
