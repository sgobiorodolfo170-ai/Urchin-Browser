/**
 * StatusBarOverlay 几何计算单元测试
 *
 * 覆盖：
 * 1. computeStatusBarBounds：3/5 宽 + 居中 + 底部对齐 + 展开高度
 * 2. computeStatusBarPanelHeight：建议/提示展开高度
 */
import { describe, it, expect } from 'vitest';
import {
  computeStatusBarBounds,
  computeStatusBarPanelHeight,
} from '../../src/main/status-bar/status-bar-overlay';
import {
  computeBallBounds,
  STATUS_BALL_RESERVED_WIDTH,
} from '../../src/main/status-bar/status-bar-ball';

const CONTENT = { x: 0, y: 0, width: 1280, height: 800 };
const LAYOUT = { leftWidth: 44, rightWidth: 44, bottomHeight: 48 };

describe('status-bar-overlay geometry', () => {
  it('should size bar to 3/5 of middle width plus shadow padding', () => {
    const middle = 1280 - 16 - 44 - 44; // 1176
    const barWidth = Math.round(middle * 0.6);
    const bounds = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 0,
    });
    expect(bounds.width).toBe(barWidth + 16);
  });

  it('should center horizontally within the middle column', () => {
    const middle = 1280 - 16 - 44 - 44;
    const barWidth = Math.round(middle * 0.6);
    const bounds = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 0,
    });
    // 左缘 = frame + leftWidth + (middle - barWidth)/2 - shadowPad
    expect(bounds.x).toBe(8 + 44 + (middle - barWidth) / 2 - 8);
  });

  it('should align bottom to content bottom minus frame', () => {
    const bounds = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 0,
    });
    // y + height = contentHeight - frame
    expect(bounds.y + bounds.height).toBe(800 - 8);
  });

  it('should grow upward by panelHeight', () => {
    const base = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 0,
    });
    const expanded = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 332,
    });
    expect(expanded.width).toBe(base.width);
    expect(expanded.y).toBeLessThan(base.y);
    expect(expanded.y + expanded.height).toBe(base.y + base.height);
  });

  it('computeStatusBarPanelHeight: suggestions > toast, none=0', () => {
    expect(computeStatusBarPanelHeight({ suggestionsOpen: true, toast: null })).toBe(332);
    expect(computeStatusBarPanelHeight({ suggestionsOpen: false, toast: { text: 'x' } })).toBe(44);
    expect(computeStatusBarPanelHeight({ suggestionsOpen: true, toast: { text: 'x' } })).toBe(332);
    expect(computeStatusBarPanelHeight({ suggestionsOpen: false, toast: null })).toBe(0);
  });
});

describe('status-bar-overlay geometry · 窄窗口下地址栏可用（2026-11-09 CI 回归）', () => {
  // 背景：CI 的 runner 屏幕 1024×768，主窗口被压到 1024×720；launch.spec 会展开右侧栏，
  // 中区只剩 ~604px，旧算法 3/5 → 362px 卡片。卡片内固定件（导航/动作按钮）不参与收缩，
  // 唯一的弹性项 address <input> 被压成 width:0 —— E2E 四个 spec 因此全红（input×1 box width=0）。
  const CI_CONTENT = { x: 0, y: 0, width: 1024, height: 720 };
  const CI_LAYOUT = { leftWidth: 44, rightWidth: 360 };

  it('should keep the card at least min-width when the middle column is narrow', () => {
    const middle = CI_CONTENT.width - 16 - CI_LAYOUT.leftWidth - CI_LAYOUT.rightWidth; // 604
    const ratioWidth = Math.round(middle * 0.6) + 16;
    const bounds = computeStatusBarBounds({
      contentBounds: CI_CONTENT,
      ...CI_LAYOUT,
      bottomHeight: 48,
      panelHeight: 0,
      reserveRight: STATUS_BALL_RESERVED_WIDTH,
    });
    expect(bounds.width).toBeGreaterThan(ratioWidth);
    // 卡片固定件预算约 386px，窗口宽 ≥ 500 才留得下可见的地址输入框
    expect(bounds.width).toBeGreaterThanOrEqual(500);
  });

  it('should not overlap the floating ball when widened for narrow windows', () => {
    const bounds = computeStatusBarBounds({
      contentBounds: CI_CONTENT,
      ...CI_LAYOUT,
      bottomHeight: 48,
      panelHeight: 0,
      reserveRight: STATUS_BALL_RESERVED_WIDTH,
    });
    const ball = computeBallBounds({
      contentBounds: CI_CONTENT,
      bottomHeight: 48,
      rightWidth: CI_LAYOUT.rightWidth,
    });
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(ball.x);
  });

  it('should clamp to the space left of the ball on ultra-narrow windows', () => {
    const content = { x: 0, y: 0, width: 640, height: 480 };
    const layout = { leftWidth: 44, rightWidth: 200 };
    const middle = content.width - 16 - layout.leftWidth - layout.rightWidth; // 380
    const bounds = computeStatusBarBounds({
      contentBounds: content,
      ...layout,
      bottomHeight: 48,
      panelHeight: 0,
      reserveRight: STATUS_BALL_RESERVED_WIDTH,
    });
    expect(bounds.width).toBeLessThanOrEqual(middle - STATUS_BALL_RESERVED_WIDTH);
    expect(bounds.x).toBeGreaterThanOrEqual(8 + layout.leftWidth - 8);
  });
});
