/**
 * 悬浮球拖动几何单元测试（2026-11-13 拖动引擎重写回归，同日二次修订）
 *
 * 背景：右键拖动由渲染层增量 dx/dy IPC 改为主进程光标轮询；与地址栏的重叠
 * 约束为「拖动期自由置顶 + 松手结算」。四条用户实测故障（焦点脱离 / 偶发
 * 卡住 / 拖入地址栏被覆盖 / 左右无法咬住）的几何约束必须有确定性测试守护：
 * 1. rectsIntersect / rectsOverlapHorizontally：边缘相切不算重叠——默认布局
 *    球左缘与地址栏窗口右缘可能恰好相切，「同行跟随」前提与结算判定都依赖此语义。
 * 2. computeBallNudge（松手结算 / 地址栏落位兜底共用）：上方优先 / 下方兜底 /
 *    均放不下放弃。
 * 3. 默认布局：地址栏与球不相交（守护 STATUS_BALL_RESERVED_WIDTH 一致性，
 *    防止几何常量改动后球默认就被地址栏压住或触发移球）。
 * 拖动期自由移动无需防重叠纯函数：dragTick 直落 target，重叠约束由置顶
 * （拖动中球永不被盖）与松手结算（ensureClearOfRect）承担。
 */
import { describe, it, expect } from 'vitest';
import {
  computeBallBounds,
  rectsIntersect,
  rectsOverlapHorizontally,
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

describe('computeBallNudge（松手结算 / 地址栏落位兜底）', () => {
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
