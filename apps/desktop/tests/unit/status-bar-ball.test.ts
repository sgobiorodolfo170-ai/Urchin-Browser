/**
 * 悬浮球拖动几何单元测试（2026-11-13 拖动引擎重写回归）
 *
 * 背景：右键拖动由渲染层增量 dx/dy IPC 改为主进程光标轮询 + 防重叠滑移后，
 * 三条用户实测故障（焦点脱离 / 偶发卡住 / 拖入地址栏被覆盖）的几何约束必须
 * 有确定性测试守护：
 * 1. rectsIntersect / rectsOverlapHorizontally：边缘相切不算重叠——默认布局
 *    球左缘与地址栏窗口右缘可能恰好相切，「同行跟随」与「防重叠」都依赖此语义。
 * 2. resolveBallDragTarget：自由放行 / 轴向滑移 / 原地贴边 / 被困后大步距跳出。
 * 3. computeBallNudge：上方优先 / 下方兜底 / 均放不下放弃。
 * 4. 默认布局：地址栏与球不相交（守护 STATUS_BALL_RESERVED_WIDTH 一致性，
 *    防止几何常量改动后球默认就被地址栏压住或触发移球）。
 */
import { describe, it, expect } from 'vitest';
import {
  computeBallBounds,
  rectsIntersect,
  rectsOverlapHorizontally,
  resolveBallDragTarget,
  computeBallNudge,
  STATUS_BALL_RESERVED_WIDTH,
  type Rect,
} from '../../src/main/status-bar/status-bar-ball';
import { computeStatusBarBounds } from '../../src/main/status-bar/status-bar-overlay';

/** 球窗口边长 = 直径 40 + 上下左右阴影边距 12 */
const BALL_SIZE = 52;

/** 地址栏窗口（含阴影边距）：x 100..500，y 500..556 */
const BAR: Rect = { x: 100, y: 500, width: 400, height: 56 };

describe('rectsIntersect', () => {
  it('should report overlap for intersecting rects', () => {
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toBe(true);
  });

  it('should treat edge-touching as not intersecting (default layout relies on this)', () => {
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBe(false);
    expect(
      rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 10, width: 10, height: 10 }),
    ).toBe(false);
  });

  it('should report false for disjoint rects', () => {
    expect(
      rectsIntersect(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 100, y: 100, width: 5, height: 5 },
      ),
    ).toBe(false);
  });
});

describe('rectsOverlapHorizontally', () => {
  it('should report overlap when x ranges intersect', () => {
    expect(rectsOverlapHorizontally({ x: 0, width: 10 }, { x: 5, width: 10 })).toBe(true);
  });

  it('should treat x-edge-touching as not overlapping (bar follow stays enabled when adjacent)', () => {
    expect(rectsOverlapHorizontally({ x: 0, width: 10 }, { x: 10, width: 10 })).toBe(false);
  });
});

describe('resolveBallDragTarget', () => {
  it('should pass through freely when no bar bounds (bar hidden/collapsed)', () => {
    const next = resolveBallDragTarget({
      target: { x: 999, y: 999 },
      current: { x: 0, y: 0 },
      ballSize: BALL_SIZE,
      barBounds: null,
    });
    expect(next).toEqual({ x: 999, y: 999, clamped: false });
  });

  it('should pass through when target does not intersect the bar', () => {
    const next = resolveBallDragTarget({
      target: { x: 600, y: 300 },
      current: { x: 590, y: 300 },
      ballSize: BALL_SIZE,
      barBounds: BAR,
    });
    expect(next).toEqual({ x: 600, y: 300, clamped: false });
  });

  it('should slide horizontally when vertical motion is blocked (approach bar from above)', () => {
    // 球在地址栏上方（y 300 不相交），目标斜向进入地址栏 → 保留 y 沿边缘滑移
    const next = resolveBallDragTarget({
      target: { x: 200, y: 520 },
      current: { x: 120, y: 300 },
      ballSize: BALL_SIZE,
      barBounds: BAR,
    });
    expect(next).toEqual({ x: 200, y: 300, clamped: true });
  });

  it('should stay left of the bar when moving into it on the same row', () => {
    // 球在地址栏左侧同行（x 40..92 < 100 相切安全），右移进入地址栏 → 横向被挡原地贴边
    const next = resolveBallDragTarget({
      target: { x: 150, y: 520 },
      current: { x: 40, y: 520 },
      ballSize: BALL_SIZE,
      barBounds: BAR,
    });
    expect(next).toEqual({ x: 40, y: 520, clamped: true });
  });

  it('should stay in place when both axes are blocked (diagonal into the corner)', () => {
    // 球在地址栏左上角斜邻位，目标斜向压入角落：两轴单独保留均相交 → 原地
    const next = resolveBallDragTarget({
      target: { x: 150, y: 470 },
      current: { x: 40, y: 470 },
      ballSize: BALL_SIZE,
      barBounds: BAR,
    });
    expect(next).toEqual({ x: 40, y: 470, clamped: true });
  });

  it('should allow a large jump to escape a trapped position (legacy overlap recovery)', () => {
    // 历史遗留：球已被地址栏盖住（重叠位置），一次大步距拖动可直接跳出禁区
    const next = resolveBallDragTarget({
      target: { x: 150, y: 100 },
      current: { x: 150, y: 520 },
      ballSize: BALL_SIZE,
      barBounds: BAR,
    });
    expect(next).toEqual({ x: 150, y: 100, clamped: false });
  });
});

describe('computeBallNudge', () => {
  it('should return null when ball does not overlap the bar', () => {
    expect(
      computeBallNudge({
        ball: { x: 600, y: 100, width: BALL_SIZE, height: BALL_SIZE },
        bar: BAR,
        contentBounds: null,
      }),
    ).toBeNull();
  });

  it('should prefer nudging the ball above the bar', () => {
    const next = computeBallNudge({
      ball: { x: 300, y: 520, width: BALL_SIZE, height: BALL_SIZE },
      bar: BAR,
      contentBounds: null,
    });
    // 上方：bar.y - 球高 - 间隙 = 500 - 52 - 4
    expect(next).toEqual({ x: 300, y: 444 });
  });

  it('should fall back to below the bar when above is outside the content area', () => {
    const next = computeBallNudge({
      ball: { x: 300, y: 520, width: BALL_SIZE, height: BALL_SIZE },
      bar: BAR,
      // 内容区顶部在 480：上方落点 444 越界 → 下方 560
      contentBounds: { x: 0, y: 480, width: 1280, height: 200 },
    });
    expect(next).toEqual({ x: 300, y: 560 });
  });

  it('should give up when neither side fits (degenerate tiny window)', () => {
    const next = computeBallNudge({
      ball: { x: 300, y: 520, width: BALL_SIZE, height: BALL_SIZE },
      bar: BAR,
      // 内容区 0..470：上方 444+52 越下界、下方 560 越下界
      contentBounds: { x: 0, y: 0, width: 1280, height: 470 },
    });
    expect(next).toBeNull();
  });
});

describe('default layout compatibility', () => {
  const CONTENT = { x: 0, y: 0, width: 1280, height: 800 };
  const LAYOUT = { leftWidth: 44, rightWidth: 44, bottomHeight: 48 };

  it('should not overlap the bar at default positions (narrow window where edges touch)', () => {
    const ball = computeBallBounds({
      contentBounds: CONTENT,
      bottomHeight: LAYOUT.bottomHeight,
      rightWidth: LAYOUT.rightWidth,
    });
    const bar = computeStatusBarBounds({
      contentBounds: CONTENT,
      ...LAYOUT,
      panelHeight: 0,
      reserveRight: STATUS_BALL_RESERVED_WIDTH,
    });
    expect(rectsIntersect(bar, ball)).toBe(false);
    expect(rectsOverlapHorizontally(ball, bar)).toBe(false);
  });
});
