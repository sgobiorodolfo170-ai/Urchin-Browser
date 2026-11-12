/**
 * 标签拖出窗口拖拽看护（2026-11-13「拖出可拖回」用户指令）
 *
 * 背景：标签卡片拖拽出窗口边界的旧逻辑在出界瞬间立即开新窗口——用户无法
 * 「拖出去再拖回来」。但指针移出 OS 窗口后渲染进程收不到后续事件（2026-08-19
 * 实测，use-tab-drag.ts），渲染层无法独立追踪窗外轨迹与松手，故看护由主进程
 * 以 screen.getCursorScreenPoint() 轮询承担（与悬浮球拖动引擎同一模式，
 * status-bar-ball.ts 2026-11-13 重写已验证该模式可靠）。
 *
 * 状态机（start → 每帧 evaluateDetachTick → reentered / commit / abort）：
 * - 光标回到源窗口内侧超过 REENTER_MARGIN → onReentered：渲染层清除挂起态
 *   （拖回成立，窗内松手无动作；再次出界会重新 start，天然支持反复拖出拖回）；
 * - 光标在窗外静止超过 COMMIT_IDLE_MS → onCommit(x, y)：视为松手提交——
 *   开新窗口（定位光标处）+ 关闭原标签。松手本身在窗外无法直接观测（无全局
 *   鼠标键态 API），静止看门狗与悬浮球 DRAG_IDLE_TIMEOUT 同一兜底思路；
 * - 源窗口关闭 / 隐藏 / 最小化 → abort：终止且不提交（拖拽语义已失效）。
 *
 * 纯函数 evaluateDetachTick / isCursorInsideBounds 导出供单测；Supervisor
 * 仅薄封装轮询定时器，getCursorPoint 可注入（测试用假光标）。
 */
import { screen } from 'electron';
import { createLogger } from '@urchin/logger';

const log = createLogger('tab-detach-drag');

/** 轮询间隔（ms）：16ms ≈ 60fps，与悬浮球拖动轮询一致 */
const POLL_INTERVAL = 16;
/** 判定「拖回」所需的窗内侧安全边距（px）：光标越过边界瞬间贴边抖动不算拖回 */
export const TAB_DETACH_REENTER_MARGIN = 8;
/**
 * 窗外静止判松手的超时（ms）：与悬浮球 DRAG_IDLE_TIMEOUT 一致。
 * 按住未松的鼠标存在手抖（通常 <1px 偶发），会重置计时；真松手后光标完全
 * 静止，超时即提交。代价是「按住窗外不动 1s」会被视为松手（可接受：用户
 * 把标签拖出窗外悬停不动，语义上已接近「放开」）。
 */
export const TAB_DETACH_COMMIT_IDLE_MS = 1000;

/** 屏幕坐标点（DIP） */
export interface DetachCursorPoint {
  x: number;
  y: number;
}

/** 屏幕坐标矩形（DIP）——源窗口内容区 bounds */
export interface DetachBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 光标是否在 bounds 内侧超过 margin（四边同时满足）。
 * margin 用于防贴边抖动：出界瞬间光标可能反复在边界 ±1px 徘徊，
 * 只有深入窗内 margin 才认定拖回。
 */
export function isCursorInsideBounds(
  cursor: DetachCursorPoint,
  bounds: DetachBounds,
  margin: number,
): boolean {
  return (
    cursor.x >= bounds.x + margin &&
    cursor.x <= bounds.x + bounds.width - margin &&
    cursor.y >= bounds.y + margin &&
    cursor.y <= bounds.y + bounds.height - margin
  );
}

/** 单次轮询判定结果 */
export type DetachTickDecision =
  | { action: 'keep' }
  | { action: 'reentered' }
  | { action: 'commit'; x: number; y: number }
  | { action: 'abort' };

/**
 * 单帧判定（纯函数，导出供单测）。
 * bounds 传 null 表示源窗口不可用（关闭/隐藏/最小化）→ abort。
 */
export function evaluateDetachTick(params: {
  cursor: DetachCursorPoint;
  bounds: DetachBounds | null;
  /** 光标最后一次移动的时间戳（ms）；窗外静止 >= COMMIT_IDLE_MS 视为松手 */
  lastMoveAt: number;
  now: number;
}): DetachTickDecision {
  const { cursor, bounds, lastMoveAt, now } = params;
  if (!bounds) return { action: 'abort' };
  if (isCursorInsideBounds(cursor, bounds, TAB_DETACH_REENTER_MARGIN)) {
    return { action: 'reentered' };
  }
  if (now - lastMoveAt >= TAB_DETACH_COMMIT_IDLE_MS) {
    return { action: 'commit', x: cursor.x, y: cursor.y };
  }
  return { action: 'keep' };
}

/** 拖拽期宿主回调（handlers.ts 注入：窗口 bounds 读取 + 渲染层通知 + 提交动作） */
export interface TabDetachDragSession {
  /** 读源窗口内容区 bounds；窗口关闭/隐藏/最小化返回 null（→ abort） */
  bounds: () => DetachBounds | null;
  /** 拖回成立：通知渲染层清除挂起态 */
  onReentered: () => void;
  /** 松手提交：在光标处开新窗口 + 关闭原标签 + 通知渲染层 */
  onCommit: (x: number, y: number) => void;
}

/**
 * 标签拖出拖拽看护器。单实例即可：一台机器同时只有一根拖拽指针，
 * 二次 start 幂等终止上一会话（与悬浮球 startDrag 同策略）。
 */
export class TabDetachDragSupervisor {
  private session: TabDetachDragSession | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCursor: DetachCursorPoint | null = null;
  private lastMoveAt = 0;
  /** 光标读取可注入（单测用假光标；默认真实 screen.getCursorScreenPoint） */
  private readonly getCursorPoint: () => DetachCursorPoint;

  constructor(deps?: { getCursorPoint?: () => DetachCursorPoint }) {
    this.getCursorPoint = deps?.getCursorPoint ?? (() => screen.getCursorScreenPoint());
  }

  /** 是否在看护中（诊断用） */
  get isWatching(): boolean {
    return this.timer !== null;
  }

  /** 开始看护（幂等：重复调用先终止上一会话） */
  start(session: TabDetachDragSession): void {
    this.stop();
    this.session = session;
    this.lastCursor = this.getCursorPoint();
    this.lastMoveAt = Date.now();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL);
  }

  /** 渲染层窗内松手 / 明确取消：终止且不提交（幂等） */
  cancel(): void {
    this.stop();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.session = null;
    this.lastCursor = null;
    this.lastMoveAt = 0;
  }

  /** 轮询帧：静止检测 → evaluateDetachTick → 分派（判定动作先 stop 再回调，防回调内重入） */
  private tick(): void {
    const session = this.session;
    if (!session || !this.timer) return;
    const cursor = this.getCursorPoint();
    const last = this.lastCursor;
    if (last?.x !== cursor.x || last?.y !== cursor.y) {
      this.lastCursor = cursor;
      this.lastMoveAt = Date.now();
    }
    const decision = evaluateDetachTick({
      cursor,
      bounds: session.bounds(),
      lastMoveAt: this.lastMoveAt,
      now: Date.now(),
    });
    switch (decision.action) {
      case 'abort':
        this.stop();
        break;
      case 'reentered':
      case 'commit': {
        this.stop();
        // 回调（渲染层通知 / 开新窗口）在定时器上下文执行，抛异常会成为主进程
        // 未捕获异常：包一层防御，失败仅终止看护不崩主进程
        try {
          if (decision.action === 'reentered') {
            session.onReentered();
          } else {
            session.onCommit(decision.x, decision.y);
          }
        } catch (err) {
          log.error('session callback failed', { error: String(err) });
        }
        break;
      }
      case 'keep':
        break;
    }
  }
}
