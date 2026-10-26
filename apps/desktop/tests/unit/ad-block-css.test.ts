/**
 * 广告浮窗屏蔽 · buildAdBlockCss 单元测试
 *
 * 验证 DB1 决策：CSS 规则覆盖业界通用广告类名，且只隐藏不拦截请求。
 *
 * 反向用例（2026-10-02 固化教训）：
 * 早期版本使用 [class*="ad-"] 等子串匹配选择器，误伤百度等网站大量正常
 * 组件（head-tab/upload-area/loading-shadow 等 class 均含 "ad-" 子串），
 * 表现为网页组件显示不全、出现空白。现回滚为精确类名匹配，新增反向用例
 * 锁定"不应误伤正常 class"语义，防止回归。
 */
import { describe, it, expect } from 'vitest';
import { buildAdBlockCss } from '../../src/main/tabs/ad-block-css';

/**
 * 简单选择器命中检查：判断给定 class/id 是否会被生成的 CSS 规则命中。
 *
 * 仅支持精确 .class / #id 匹配（与 buildAdBlockCss 当前实现一致），
 * 不支持属性子串匹配等复杂选择器——一旦命中复杂选择器即视为可疑。
 *
 * 实现理由：用 CSS 选择器解析器会引入额外依赖；本函数足够覆盖
 * "某 class 是否被规则精确命中"这一核心语义，且测试可读性更好。
 */
function matchesAdRule(css: string, token: { type: 'class' | 'id'; name: string }): boolean {
  const prefix = token.type === 'class' ? '.' : '#';
  // 移除 CSS 注释 /* ... */——否则首个选择器前若有注释块会被一同捕获
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 提取规则块前的选择器列表（取首个 { 前的内容）
  // noUncheckedIndexedAccess 下 match 结果的捕获组为 string | undefined，需显式判空
  // prefer-regexp-exec 规则要求用 RegExp#exec 替代 String#match
  const selectorMatch = /^([\s\S]*?)\{/.exec(noComments);
  if (!selectorMatch) return false;
  const selectorGroup = selectorMatch[1];
  if (!selectorGroup) return false;
  const selectors = selectorGroup.split(',').map((s) => s.trim());
  return selectors.includes(prefix + token.name);
}

describe('buildAdBlockCss', () => {
  it('should produce non-empty CSS', () => {
    const css = buildAdBlockCss();
    expect(css.length).toBeGreaterThan(50);
  });

  it('should include common ad container classes', () => {
    const css = buildAdBlockCss();
    expect(css).toContain('#ads');
    expect(css).toContain('.ad-container');
    expect(css).toContain('.ad-wrapper');
    expect(css).toContain('.advert');
    expect(css).toContain('.adsense');
  });

  it('should include popup/overlay ad classes', () => {
    const css = buildAdBlockCss();
    expect(css).toContain('.ad-modal');
    expect(css).toContain('.popup-ad');
    expect(css).toContain('.ad-overlay');
  });

  it('should hide with display:none !important and not rely on request blocking', () => {
    const css = buildAdBlockCss();
    expect(css).toContain('display: none !important');
  });

  // ─── 反向用例：禁止使用子串匹配选择器（2026-10-02 固化教训） ───

  it('should NOT use substring-matching attribute selectors', () => {
    const css = buildAdBlockCss();
    // 子串匹配选择器会误伤大量正常组件，禁止出现
    expect(css).not.toContain('[id*="ad-"]');
    expect(css).not.toContain('[class*="ad-"]');
    expect(css).not.toContain('[id*="ad_"]');
    expect(css).not.toContain('[class*="ad_"]');
    expect(css).not.toContain('[id*="ads-"]');
    expect(css).not.toContain('[class*="ads-"]');
    // 更严格：不应有任何 [attr*=...] 形式的选择器
    expect(css).not.toMatch(/\[[a-z]+\s*\*=\s*["']/);
  });

  it('should NOT include redundant visibility/pointer-events rules', () => {
    // display:none 后元素不渲染，visibility 与 pointer-events 冗余，删除以保持规则精简
    const css = buildAdBlockCss();
    expect(css).not.toContain('visibility: hidden');
    expect(css).not.toContain('pointer-events: none');
  });

  // ─── 误伤场景测试：百度等主流网站正常 class 不得被命中 ───

  it('should NOT match common normal class names that contain "ad-" substring', () => {
    // 这些 class 来自百度、知乎、微博等真实网页，class 命名中含 "ad-" 子串
    // 但本不是广告元素——早期子串匹配会误伤，现必须确保不被命中
    const css = buildAdBlockCss();
    const normalClassesWithAdSubstring = [
      'head-tab', // 含 "ad-tab"
      'upload-area', // 含 "ad-area"
      'loading-shadow', // 含 "ad-shadow"
      'read-more', // 含 "ad-more"
      'grad-overlay', // 含 "ad-overlay"
      'thread-card', // 含 "ad-card"
      'sidenav-link', // 含 "ad-link"
      'download-btn', // 含 "ad-"
      'header-tabs', // 含 "ad-"
      'sidebar-adv', // 含 "ad-"
    ];
    for (const cls of normalClassesWithAdSubstring) {
      expect(matchesAdRule(css, { type: 'class', name: cls })).toBe(false);
    }
  });

  it('should NOT match common normal class names that contain "ad_" substring', () => {
    const css = buildAdBlockCss();
    const normalClassesWithAdUnderscore = [
      'read_more',
      'upload_area',
      'thread_ad_card',
      'header_ad_banner',
    ];
    for (const cls of normalClassesWithAdUnderscore) {
      expect(matchesAdRule(css, { type: 'class', name: cls })).toBe(false);
    }
  });

  it('should still match genuine ad class names', () => {
    // 正向校验：业界事实通用的广告类名仍应被精确命中
    const css = buildAdBlockCss();
    expect(matchesAdRule(css, { type: 'class', name: 'adsbygoogle' })).toBe(true);
    expect(matchesAdRule(css, { type: 'class', name: 'adsense' })).toBe(true);
    expect(matchesAdRule(css, { type: 'class', name: 'advert' })).toBe(true);
    expect(matchesAdRule(css, { type: 'class', name: 'ad-container' })).toBe(true);
    expect(matchesAdRule(css, { type: 'id', name: 'ads' })).toBe(true);
  });
});
