/**
 * SelectionCardOverlay 几何计算单元测试
 *
 * 覆盖：
 * 1. computeSelectionCardBounds：锚点下方定位 / 底部翻转上方 / 贴底兜底 / 水平夹边
 * 2. estimateCardHeight：下限 / 上限 / 多行折行
 */
import { describe, it, expect } from 'vitest';
import {
  computeSelectionCardBounds,
  estimateCardHeight,
  CARD_WIDTH,
  SHADOW_PAD,
  MIN_CARD_HEIGHT,
  MAX_CARD_HEIGHT,
} from '../../src/main/translate/selection-card-overlay';

const CONTENT = { x: 0, y: 0, width: 1280, height: 800 };
const H = MIN_CARD_HEIGHT; // 估算高度由 estimateCardHeight 测试，几何用固定值

describe('selection-card-overlay geometry', () => {
  it('should size window to card plus shadow padding', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 100,
      cardHeight: H,
    });
    expect(bounds.width).toBe(CARD_WIDTH + SHADOW_PAD * 2);
    expect(bounds.height).toBe(H + SHADOW_PAD * 2);
  });

  it('should place below anchor with 12px offset', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 100,
      cardHeight: H,
    });
    expect(bounds.y).toBe(100 + 12);
  });

  it('should flip above anchor when below overflows content bottom', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 700,
      cardHeight: H,
    });
    // 下方放不下（700 + 12 + 高度 > 800 - 8），翻到锚点上方
    expect(bounds.y).toBe(700 - (H + SHADOW_PAD * 2) - 8);
  });

  it('should clamp to content bottom when flipping would overflow top', () => {
    // 小内容区：卡高接近内容高，锚点靠顶时下方放不下、上方也放不下 → 贴底兜底
    const bounds = computeSelectionCardBounds({
      contentBounds: { x: 0, y: 0, width: 600, height: 300 },
      anchorY: 10,
      anchorX: 100,
      cardHeight: MAX_CARD_HEIGHT,
    });
    expect(bounds.y).toBe(300 - (MAX_CARD_HEIGHT + SHADOW_PAD * 2) - 8);
  });

  it('should clamp x into content area with edge padding', () => {
    const nearRight = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 1200,
      anchorY: 100,
      cardHeight: H,
    });
    expect(nearRight.x).toBe(1280 - (CARD_WIDTH + SHADOW_PAD * 2) - 8);

    const negative = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: -50,
      anchorY: 100,
      cardHeight: H,
    });
    expect(negative.x).toBe(8);
  });

  it('should respect contentBounds origin (multi-display offset)', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      anchorX: 100,
      anchorY: 100,
      cardHeight: H,
    });
    expect(bounds.x).toBe(-1920 + 100);
    expect(bounds.y).toBe(112);
  });
});

describe('estimateCardHeight', () => {
  it('should return minimum for short text', () => {
    // 单行：源行 26 + 内边距 24 + 结果行 23
    expect(estimateCardHeight('hi')).toBe(73);
    expect(estimateCardHeight('hi')).toBeGreaterThanOrEqual(MIN_CARD_HEIGHT);
  });

  it('should grow with line count', () => {
    const oneLine = estimateCardHeight('a'.repeat(30));
    const twoLines = estimateCardHeight('a'.repeat(40));
    expect(twoLines).toBeGreaterThan(oneLine);
  });

  it('should count explicit newlines as breaks', () => {
    const twoSegs = estimateCardHeight('a\nb');
    expect(twoSegs).toBeGreaterThan(estimateCardHeight('a'));
  });

  it('should cap at maximum height', () => {
    expect(estimateCardHeight('a'.repeat(100000))).toBe(MAX_CARD_HEIGHT);
  });
});
