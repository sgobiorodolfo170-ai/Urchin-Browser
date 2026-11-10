/**
 * SelectionCardOverlay 单元测试
 *
 * 覆盖：
 * 1. computeSelectionCardBounds：锚点下方定位 / 底部翻转上方 / 贴底兜底 / 水平夹边
 * 2. estimateCardSize：短文本下限 / CJK 宽字符 / 折行 / 显式换行
 * 3. clampCardSize：文本尺寸 → 卡片尺寸夹边（上下限）
 * 4. SelectionCardOverlay.applyMeasuredSize：seq 关联（过期测量丢弃 / 实测优先于估算）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SelectionCardOverlay,
  computeSelectionCardBounds,
  estimateCardSize,
  clampCardSize,
  maxCardHeightFor,
  resolveTextSize,
  CARD_WIDTH,
  SHADOW_PAD,
  CARD_PAD,
  MIN_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MAX_CARD_HEIGHT,
  MAX_CARD_HEIGHT_LIMIT,
  MAX_TEXT_WIDTH,
  type SelectionCardHostWindow,
} from '../../src/main/translate/selection-card-overlay';

const CONTENT = { x: 0, y: 0, width: 1280, height: 800 };
const W = CARD_WIDTH; // 几何测试用固定宽
const H = MIN_CARD_HEIGHT; // 高度用固定值

describe('selection-card-overlay geometry', () => {
  it('should size window to card plus shadow padding', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 100,
      cardWidth: W,
      cardHeight: H,
    });
    expect(bounds.width).toBe(W + SHADOW_PAD * 2);
    expect(bounds.height).toBe(H + SHADOW_PAD * 2);
  });

  it('should place below anchor with 12px offset', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 100,
      cardWidth: W,
      cardHeight: H,
    });
    expect(bounds.y).toBe(100 + 12);
  });

  it('should flip above anchor when below overflows content bottom', () => {
    // 锚点 740：下方 740 + 12 + 64(窗高) > 800 - 8 放不下，翻到锚点上方
    const bounds = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 100,
      anchorY: 740,
      cardWidth: W,
      cardHeight: H,
    });
    expect(bounds.y).toBe(740 - (H + SHADOW_PAD * 2) - 8);
  });

  it('should clamp to content bottom when flipping would overflow top', () => {
    // 小内容区：卡高接近内容高，锚点靠顶时下方放不下、上方也放不下 → 贴底兜底
    const bounds = computeSelectionCardBounds({
      contentBounds: { x: 0, y: 0, width: 600, height: 300 },
      anchorY: 10,
      anchorX: 100,
      cardWidth: W,
      cardHeight: MAX_CARD_HEIGHT,
    });
    expect(bounds.y).toBe(300 - (MAX_CARD_HEIGHT + SHADOW_PAD * 2) - 8);
  });

  it('should clamp x into content area with edge padding', () => {
    const nearRight = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 1200,
      anchorY: 100,
      cardWidth: W,
      cardHeight: H,
    });
    expect(nearRight.x).toBe(1280 - (W + SHADOW_PAD * 2) - 8);

    const negative = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: -50,
      anchorY: 100,
      cardWidth: W,
      cardHeight: H,
    });
    expect(negative.x).toBe(8);
  });

  it('should respect contentBounds origin (multi-display offset)', () => {
    const bounds = computeSelectionCardBounds({
      contentBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      anchorX: 100,
      anchorY: 100,
      cardWidth: W,
      cardHeight: H,
    });
    expect(bounds.x).toBe(-1920 + 100);
    expect(bounds.y).toBe(112);
  });

  it('should honor compact card width (short text) in x clamping', () => {
    // 窄卡（MIN_CARD_WIDTH）右缘夹边时窗口右探更少
    const nearRight = computeSelectionCardBounds({
      contentBounds: CONTENT,
      anchorX: 1200,
      anchorY: 100,
      cardWidth: MIN_CARD_WIDTH,
      cardHeight: H,
    });
    expect(nearRight.x).toBe(1280 - (MIN_CARD_WIDTH + SHADOW_PAD * 2) - 8);
    expect(nearRight.width).toBe(MIN_CARD_WIDTH + SHADOW_PAD * 2);
  });
});

describe('estimateCardSize', () => {
  it('should return text-area minimum for short text', () => {
    // 'hi' 窄字符 2×8=16，抬高到文本区最小宽（MIN_CARD_WIDTH - CARD_PAD）
    const size = estimateCardSize('hi');
    expect(size.width).toBe(MIN_CARD_WIDTH - CARD_PAD);
    expect(size.height).toBe(23); // 单行
  });

  it('should measure CJK text wider than latin', () => {
    // 4 个宽字符 4×15=60 → 仍被最小宽抬高；换更长的 CJK 验证宽度按字宽增长
    expect(estimateCardSize('你好世界你好世界').width).toBe(8 * 15);
    expect(estimateCardSize('你好世界你好世界').width).toBeGreaterThan(
      estimateCardSize('abcdefgh').width,
    );
  });

  it('should wrap at max text width for long text', () => {
    // 100 个窄字符 = 800px > MAX_TEXT_WIDTH(424) → 定宽 424、折 2 行
    const size = estimateCardSize('a'.repeat(100));
    expect(size.width).toBe(MAX_TEXT_WIDTH);
    expect(size.height).toBe(2 * 23);
  });

  it('should count explicit newlines as breaks', () => {
    const twoSegs = estimateCardSize('a\nb');
    expect(twoSegs.height).toBe(2 * 23);
    expect(twoSegs.width).toBe(MIN_CARD_WIDTH - CARD_PAD);
  });

  it('should not cap height (clamping belongs to clampCardSize)', () => {
    expect(estimateCardSize('a'.repeat(100000)).height).toBeGreaterThan(MAX_CARD_HEIGHT);
  });
});

describe('clampCardSize', () => {
  it('should lift empty size to card minimums', () => {
    expect(clampCardSize(0, 0)).toEqual({ cardWidth: MIN_CARD_WIDTH, cardHeight: MIN_CARD_HEIGHT });
  });

  it('should cap at card maximums', () => {
    expect(clampCardSize(10000, 10000)).toEqual({
      cardWidth: CARD_WIDTH,
      cardHeight: MAX_CARD_HEIGHT,
    });
  });

  it('should honor a custom max height (content area larger than default cap)', () => {
    expect(clampCardSize(10000, 10000, MAX_CARD_HEIGHT_LIMIT)).toEqual({
      cardWidth: CARD_WIDTH,
      cardHeight: MAX_CARD_HEIGHT_LIMIT,
    });
  });

  it('should add padding for in-range text size', () => {
    expect(clampCardSize(400, 200)).toEqual({
      cardWidth: 400 + CARD_PAD,
      cardHeight: 200 + CARD_PAD,
    });
  });

  it('should round fractional measured sizes', () => {
    expect(clampCardSize(100.4, 47.6)).toEqual({
      cardWidth: 100 + CARD_PAD,
      cardHeight: 48 + CARD_PAD,
    });
  });
});

// ── 选区几何基准（2026-11-10 用户需求） ─────────────────────────────

describe('maxCardHeightFor', () => {
  it('should keep the default cap on a normal window', () => {
    // 内容区 800 高 → 可容纳 784，硬上限 560 > 264 → 560
    expect(maxCardHeightFor(800)).toBe(MAX_CARD_HEIGHT_LIMIT);
  });

  it('should never go below the default cap', () => {
    expect(maxCardHeightFor(120)).toBe(MAX_CARD_HEIGHT);
  });

  it('should follow the content height on small windows', () => {
    expect(maxCardHeightFor(300)).toBe(300 - 16);
  });
});

describe('resolveTextSize', () => {
  it('should return the translated size when no selection geometry is available', () => {
    expect(resolveTextSize({ width: 120, height: 23 })).toEqual({ width: 120, height: 23 });
  });

  it('should grow a short translation card to the selection width and height', () => {
    // 选中 380×70（3 行）的段落，译文只有「短」两字（估算 72×23）
    expect(
      resolveTextSize({ width: 72, height: 23 }, { width: 380, height: 70, lines: 3 }),
    ).toEqual({
      width: 380,
      height: 70,
    });
  });

  it('should keep a wider translation width instead of truncating it', () => {
    expect(
      resolveTextSize({ width: 400, height: 46 }, { width: 200, height: 24, lines: 1 }),
    ).toEqual({ width: 400, height: 46 });
  });

  it('should floor the height by selection line count when rect height is small', () => {
    // 页面行高比结果卡行高小：2 行 × 23 = 46 > 选区矩形高 20
    expect(
      resolveTextSize({ width: 10, height: 10 }, { width: 10, height: 20, lines: 2 }).height,
    ).toBe(46);
  });

  it('should ceil fractional selection geometry', () => {
    expect(
      resolveTextSize({ width: 10, height: 10 }, { width: 99.2, height: 30.4, lines: 1 }),
    ).toEqual({ width: 100, height: 31 });
  });
});

// ── applyMeasuredSize（seq 关联 + 实测优先） ─────────────────────────────

/** 最小 webContents mock（open() 只用到这几个方法） */
function makeFakeWin() {
  const boundsHistory: { x: number; y: number; width: number; height: number }[] = [];
  const win = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      isLoadingMainFrame: vi.fn(() => false),
    },
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
      boundsHistory.push(b);
    }),
  };
  return { win, boundsHistory };
}

function makeFakeParent(): SelectionCardHostWindow {
  return {
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
  };
}

describe('SelectionCardOverlay.applyMeasuredSize', () => {
  it('should apply measured size when seq matches current result', () => {
    const { win, boundsHistory } = makeFakeWin();
    const overlay = new SelectionCardOverlay({
      getParentWindow: makeFakeParent,
      preloadPath: 'test',
      getTheme: () => 'light',
      onLoad: () => Promise.resolve(),
      createWindow: () => win as unknown as Electron.BrowserWindow,
    });
    overlay.show({ tabId: 1, source: '原文', result: 'hello world', x: 100, y: 100 });
    const estimateCount = boundsHistory.length;

    // 首个结果 seq = 1；实测 100×30 → 卡片 124×54
    overlay.applyMeasuredSize(1, 100, 30);
    expect(boundsHistory.length).toBeGreaterThan(estimateCount);
    const last = boundsHistory.at(-1);
    expect(last?.width).toBe(100 + CARD_PAD + SHADOW_PAD * 2);
    expect(last?.height).toBe(30 + CARD_PAD + SHADOW_PAD * 2);
  });

  it('should ignore stale measurement from an older result (seq mismatch)', () => {
    const { win, boundsHistory } = makeFakeWin();
    const overlay = new SelectionCardOverlay({
      getParentWindow: makeFakeParent,
      preloadPath: 'test',
      getTheme: () => 'light',
      onLoad: () => Promise.resolve(),
      createWindow: () => win as unknown as Electron.BrowserWindow,
    });
    overlay.show({ tabId: 1, source: 'a', result: 'b', x: 50, y: 50 });
    // seq=1 结果被 seq=2 结果替换：旧测量（seq=1）必须被丢弃
    overlay.show({ tabId: 1, source: 'c', result: 'd', x: 60, y: 60 });
    const before = boundsHistory.length;
    overlay.applyMeasuredSize(1, 400, 200);
    expect(boundsHistory.length).toBe(before);
  });

  it('should prefer measured size over estimate for long text height', () => {
    const { win, boundsHistory } = makeFakeWin();
    const overlay = new SelectionCardOverlay({
      getParentWindow: makeFakeParent,
      preloadPath: 'test',
      getTheme: () => 'light',
      onLoad: () => Promise.resolve(),
      createWindow: () => win as unknown as Electron.BrowserWindow,
    });
    // 长文本估算高度超上限；实测单行窄结果应显著小于估算夹边后的内容区上限
    overlay.show({
      tabId: 1,
      source: 'a',
      result: 'x'.repeat(2000),
      x: 100,
      y: 100,
    });
    const estimatedHeight = boundsHistory.at(-1)?.height ?? 0;
    expect(estimatedHeight).toBe(maxCardHeightFor(800) + SHADOW_PAD * 2);

    overlay.applyMeasuredSize(1, MAX_TEXT_WIDTH, 23);
    const measuredHeight = boundsHistory.at(-1)?.height ?? 0;
    // 单行实测 23+24=47 < 高度下限 48 → 抬到 MIN_CARD_HEIGHT
    expect(measuredHeight).toBe(MIN_CARD_HEIGHT + SHADOW_PAD * 2);
  });

  it('should size the card to the selection geometry for a short translation', () => {
    const { win, boundsHistory } = makeFakeWin();
    const overlay = new SelectionCardOverlay({
      getParentWindow: makeFakeParent,
      preloadPath: 'test',
      getTheme: () => 'light',
      onLoad: () => Promise.resolve(),
      createWindow: () => win as unknown as Electron.BrowserWindow,
    });
    // 选中 380×70、3 行的段落，译文只有「短」：卡片不得折叠成小方块
    overlay.show({
      tabId: 1,
      source: 'a long english paragraph',
      result: '短',
      x: 100,
      y: 100,
      selection: { x: 100, y: 100, width: 380, height: 70, lines: 3 },
    });
    const bounds = boundsHistory.at(-1);
    expect(bounds?.width).toBe(380 + CARD_PAD + SHADOW_PAD * 2);
    expect(bounds?.height).toBe(70 + CARD_PAD + SHADOW_PAD * 2);
  });
});
