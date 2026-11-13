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
  computeTitleBarSnapY,
  resolveBarVerticalPlacement,
  shouldSnapToTitleBar,
} from '../../src/main/status-bar/status-bar-overlay';
import {
  computeBallBounds,
  rectsOverlapHorizontally,
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

describe('status-bar-overlay 标题栏吸附（2026-11-13 用户指令）', () => {
  // 背景：标题栏与地址栏卡片等高（WINDOW_TITLEBAR_HEIGHT = CARD_HEIGHT = 40px）。
  // 地址栏被拖到标题栏上（卡片触及标题栏带）即吸附入位并不再跟随球；点击悬浮球
  // 折叠解除吸附，再次展开回到与球同行。CONTENT.y=0 → 标题栏顶=8，带=[8, 48]。

  it('shouldSnapToTitleBar: 卡片顶边触及标题栏底边即吸附（含对齐带顶与一帧越顶）', () => {
    expect(shouldSnapToTitleBar({ cardTop: 48, contentTop: 0 })).toBe(true); // 恰好触底
    expect(shouldSnapToTitleBar({ cardTop: 49, contentTop: 0 })).toBe(false); // 触底前 1px 仍自由
    expect(shouldSnapToTitleBar({ cardTop: 8, contentTop: 0 })).toBe(true); // 对齐带顶
    expect(shouldSnapToTitleBar({ cardTop: -20, contentTop: 0 })).toBe(true); // 快拖一帧越顶也吸附
  });

  it('computeTitleBarSnapY: 卡片恰好覆盖标题栏带（基础高与建议展开高一致）', () => {
    // 基础高 56：窗口 Y = 标题栏顶(8) − 卡片顶偏移(8) = 0 → 卡片在屏幕 [8, 48]
    expect(computeTitleBarSnapY({ contentTop: 0, height: 56 })).toBe(0);
    // 建议面板展开（高 388）：锚住卡片不变，窗口向上长高
    expect(computeTitleBarSnapY({ contentTop: 0, height: 388 })).toBe(-332);
    // 屏幕坐标核对：卡片顶 = 窗口Y + (height − 8 − 40) = 标题栏顶 8
    const y = computeTitleBarSnapY({ contentTop: 0, height: 388 });
    expect(y + (388 - 8 - 40)).toBe(8);
  });

  it('resolveBarVerticalPlacement: 球在下方同行 → 卡片中心对齐球心，不吸附', () => {
    const r = resolveBarVerticalPlacement({
      defaultY: 736,
      height: 56,
      contentTop: 0,
      ballCenterY: 766,
      ballOverlapsHorizontally: false,
      snapped: false,
    });
    expect(r).toEqual({ y: 738, snapped: false });
  });

  it('resolveBarVerticalPlacement: 跟随触及标题栏带 → 吸附入位', () => {
    // 球心 68 → 卡片顶 48 恰触标题栏底边 → 吸附；球心 69 → 卡片顶 49 未触及 → 仍自由
    const touch = resolveBarVerticalPlacement({
      defaultY: 736,
      height: 56,
      contentTop: 0,
      ballCenterY: 68,
      ballOverlapsHorizontally: false,
      snapped: false,
    });
    expect(touch).toEqual({ y: 0, snapped: true });
    const free = resolveBarVerticalPlacement({
      defaultY: 736,
      height: 56,
      contentTop: 0,
      ballCenterY: 69,
      ballOverlapsHorizontally: false,
      snapped: false,
    });
    expect(free).toEqual({ y: 41, snapped: false });
  });

  it('resolveBarVerticalPlacement: 吸附态不跟随球（球怎么动都不变）', () => {
    for (const ballCenterY of [68, 300, 766, 2000]) {
      expect(
        resolveBarVerticalPlacement({
          defaultY: 736,
          height: 56,
          contentTop: 0,
          ballCenterY,
          ballOverlapsHorizontally: false,
          snapped: true,
        }),
      ).toEqual({ y: 0, snapped: true });
    }
  });

  it('resolveBarVerticalPlacement: 球在卡片水平跨度内或球不可用 → 默认底部行', () => {
    expect(
      resolveBarVerticalPlacement({
        defaultY: 736,
        height: 56,
        contentTop: 0,
        ballCenterY: 766,
        ballOverlapsHorizontally: true,
        snapped: false,
      }),
    ).toEqual({ y: 736, snapped: false });
    expect(
      resolveBarVerticalPlacement({
        defaultY: 736,
        height: 56,
        contentTop: 0,
        ballCenterY: null,
        ballOverlapsHorizontally: true,
        snapped: false,
      }),
    ).toEqual({ y: 736, snapped: false });
  });

  it('端到端几何：默认布局球在地址栏右侧水平不相交 → 跟随球心且不吸附', () => {
    const bounds = computeStatusBarBounds({ contentBounds: CONTENT, ...LAYOUT, panelHeight: 0 });
    const ball = computeBallBounds({ contentBounds: CONTENT, bottomHeight: 48, rightWidth: 44 });
    // 相切不算重叠：球默认位于地址栏窗口右缘之外（让位宽 + 居中左移留有空隙）
    expect(rectsOverlapHorizontally(ball, bounds)).toBe(false);
    const r = resolveBarVerticalPlacement({
      defaultY: bounds.y,
      height: bounds.height,
      contentTop: CONTENT.y,
      ballCenterY: ball.y + ball.height / 2,
      ballOverlapsHorizontally: rectsOverlapHorizontally(ball, bounds),
      snapped: false,
    });
    expect(r.snapped).toBe(false);
    expect(r.y).toBe(ball.y + ball.height / 2 - 28); // 卡片中心对齐球心（偏移 28 = 56 − 8 − 40/2）
  });
});
