/**
 * M27 笔记 · 三区布局数学单测（比例制）
 */
import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  normalizeLayout,
  resizeLeftLayout,
  resizeRightLayout,
  SPLITTER_WIDTH,
  usableWidth,
  widthsFromLayout,
} from '../../src/renderer/notebook/layout';

describe('notebook layout', () => {
  it('should default to 1:2:2 ratios summing to 1', () => {
    const layout = defaultLayout();
    expect(layout.custom).toBe(false);
    expect(layout.left).toBeCloseTo(0.2);
    expect(layout.middle).toBeCloseTo(0.4);
    expect(layout.right).toBeCloseTo(0.4);
    expect(layout.left + layout.middle + layout.right).toBeCloseTo(1);
  });

  it('usableWidth should subtract both splitters', () => {
    expect(usableWidth(1212)).toBe(1212 - SPLITTER_WIDTH * 2);
  });

  it('should fill the whole usable width from ratios', () => {
    const total = 1212;
    const widths = widthsFromLayout(defaultLayout(), total);
    expect(widths.left + widths.middle + widths.right).toBeCloseTo(usableWidth(total));
    expect(widths.left / usableWidth(total)).toBeCloseTo(0.2);
    expect(widths.middle / usableWidth(total)).toBeCloseTo(0.4);
    expect(widths.right / usableWidth(total)).toBeCloseTo(0.4);
  });

  it('should normalize legacy pixel layout to ratios', () => {
    const normalized = normalizeLayout({ left: 200, middle: 400, right: 400, custom: true });
    expect(normalized.left).toBeCloseTo(0.2);
    expect(normalized.middle).toBeCloseTo(0.4);
    expect(normalized.right).toBeCloseTo(0.4);
    expect(normalized.left + normalized.middle + normalized.right).toBeCloseTo(1);
  });

  it('should resize left splitter keeping right ratio when unclamped', () => {
    const total = 2000;
    const start = defaultLayout();
    const moved = resizeLeftLayout(start, 100, total);
    expect(moved.custom).toBe(true);
    expect(moved.left + moved.middle + moved.right).toBeCloseTo(1);
    // 右区比例不变（100 仅在左/中之间移动）
    expect(moved.right).toBeCloseTo(start.right);
    expect(moved.left).toBeGreaterThan(start.left);
  });

  it('should resize right splitter keeping left ratio when unclamped', () => {
    const total = 2000;
    const start = defaultLayout();
    const moved = resizeRightLayout(start, 100, total);
    expect(moved.custom).toBe(true);
    expect(moved.left + moved.middle + moved.right).toBeCloseTo(1);
    expect(moved.left).toBeCloseTo(start.left);
    expect(moved.middle).toBeGreaterThan(start.middle);
  });

  it('should enforce minimum widths when dragging too far', () => {
    const total = 1200;
    const start = defaultLayout();
    const clamped = resizeLeftLayout(start, -9999, total);
    const widths = widthsFromLayout(clamped, total);
    expect(widths.left).toBeGreaterThanOrEqual(160);
    expect(widths.middle).toBeGreaterThanOrEqual(220);
    expect(widths.right).toBeGreaterThanOrEqual(220);
  });
});
