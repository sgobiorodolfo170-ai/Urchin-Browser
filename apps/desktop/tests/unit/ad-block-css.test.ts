/**
 * 广告浮窗屏蔽 · buildAdBlockCss 单元测试
 *
 * 验证 DB1 决策：CSS 规则覆盖悬浮/弹窗类广告选择器，且只隐藏不拦截请求。
 */
import { describe, it, expect } from 'vitest';
import { buildAdBlockCss } from '../../src/main/tabs/ad-block-css';

describe('buildAdBlockCss', () => {
  it('should produce non-empty CSS', () => {
    const css = buildAdBlockCss();
    expect(css.length).toBeGreaterThan(50);
  });

  it('should include fixed-position ad attribute selectors', () => {
    const css = buildAdBlockCss();
    expect(css).toContain('[id*="ad-"]');
    expect(css).toContain('[class*="ad-"]');
    expect(css).toContain('[id*="ad_"]');
    expect(css).toContain('[class*="ads-"]');
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

  it('should hide with !important and not rely on request blocking', () => {
    const css = buildAdBlockCss();
    expect(css).toContain('display: none !important');
    expect(css).toContain('visibility: hidden !important');
  });
});
