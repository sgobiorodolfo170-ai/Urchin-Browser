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
