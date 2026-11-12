/**
 * 标签拖出窗口拖拽看护单元测试（2026-11-13「拖出可拖回」重写回归）
 *
 * 渲染层指针出界后收不到后续事件（2026-08-19 实测），detach 决策移交主进程
 * 光标轮询看护。三条用户可感知语义必须有确定性测试守护：
 * 1. 拖回：光标回到源窗口内侧超过安全边距 → reentered（标签保留，可反复拖出拖回）；
 * 2. 松手提交：窗外静止超过 COMMIT_IDLE_MS → commit（开新窗口 + 关闭原标签）；
 * 3. 中止：源窗口关闭/隐藏/最小化 → abort（拖拽语义失效，绝不提交）。
 * evaluateDetachTick / isCursorInsideBounds 为纯函数直接断言；Supervisor 用
 * 注入假光标 + fake timers 验证轮询分派与幂等（start 重入 / cancel）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateDetachTick,
  isCursorInsideBounds,
  TabDetachDragSupervisor,
  TAB_DETACH_REENTER_MARGIN,
  TAB_DETACH_COMMIT_IDLE_MS,
} from '../../src/main/tabs/tab-detach-drag';

/** 源窗口内容区：屏幕坐标 (100,100) 起 800×600 */
const BOUNDS = { x: 100, y: 100, width: 800, height: 600 };

describe('isCursorInsideBounds', () => {
  it('should report inside for cursor well within bounds', () => {
    expect(isCursorInsideBounds({ x: 500, y: 400 }, BOUNDS, TAB_DETACH_REENTER_MARGIN)).toBe(true);
  });

  it('should treat margin band as outside (anti edge-flap)', () => {
    // 距左边界 5px < REENTER_MARGIN(8px)：出界瞬间的贴边抖动不算拖回
    expect(isCursorInsideBounds({ x: 100 + 5, y: 400 }, BOUNDS, TAB_DETACH_REENTER_MARGIN)).toBe(
      false,
    );
    // 深入窗内 margin 才算拖回
    expect(
      isCursorInsideBounds(
        { x: 100 + TAB_DETACH_REENTER_MARGIN, y: 400 },
        BOUNDS,
        TAB_DETACH_REENTER_MARGIN,
      ),
    ).toBe(true);
  });

  it('should report outside for cursor beyond bounds', () => {
    expect(isCursorInsideBounds({ x: 50, y: 400 }, BOUNDS, TAB_DETACH_REENTER_MARGIN)).toBe(false);
    expect(isCursorInsideBounds({ x: 500, y: 50 }, BOUNDS, TAB_DETACH_REENTER_MARGIN)).toBe(false);
  });
});

describe('evaluateDetachTick', () => {
  it('should abort when source window bounds unavailable (closed/hidden/minimized)', () => {
    expect(
      evaluateDetachTick({
        cursor: { x: 50, y: 50 },
        bounds: null,
        lastMoveAt: 0,
        now: TAB_DETACH_COMMIT_IDLE_MS,
      }),
    ).toEqual({ action: 'abort' });
  });

  it('should decide reentered when cursor back inside beyond margin', () => {
    expect(
      evaluateDetachTick({
        cursor: { x: 400, y: 300 },
        bounds: BOUNDS,
        lastMoveAt: 0,
        now: TAB_DETACH_COMMIT_IDLE_MS * 10,
      }),
    ).toEqual({ action: 'reentered' });
  });

  it('should commit at current cursor when still outside beyond idle timeout', () => {
    expect(
      evaluateDetachTick({
        cursor: { x: 60, y: 200 },
        bounds: BOUNDS,
        lastMoveAt: 0,
        now: TAB_DETACH_COMMIT_IDLE_MS,
      }),
    ).toEqual({ action: 'commit', x: 60, y: 200 });
  });

  it('should keep watching while cursor moved recently', () => {
    expect(
      evaluateDetachTick({
        cursor: { x: 60, y: 200 },
        bounds: BOUNDS,
        lastMoveAt: 500,
        now: 500 + TAB_DETACH_COMMIT_IDLE_MS - 1,
      }),
    ).toEqual({ action: 'keep' });
  });

  it('should prefer reentered over commit when both conditions met', () => {
    // 拖回优先于松手提交：光标已回窗内（即使静止超时）也不得开新窗口
    expect(
      evaluateDetachTick({
        cursor: { x: 400, y: 300 },
        bounds: BOUNDS,
        lastMoveAt: 0,
        now: TAB_DETACH_COMMIT_IDLE_MS * 5,
      }),
    ).toEqual({ action: 'reentered' });
  });
});

describe('TabDetachDragSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 构造注入假光标的看护器 + 会话回调 spy */
  function makeSupervisor(cursor: { x: number; y: number }) {
    const getCursorPoint = vi.fn(() => ({ ...cursor }));
    const supervisor = new TabDetachDragSupervisor({ getCursorPoint });
    const onReentered = vi.fn();
    const onCommit = vi.fn();
    const session = {
      bounds: () => ({ ...BOUNDS }),
      onReentered,
      onCommit,
    };
    return { supervisor, session, onReentered, onCommit, getCursorPoint };
  }

  it('should call onCommit when cursor stays outside beyond idle timeout', () => {
    const { supervisor, session, onCommit, onReentered } = makeSupervisor({ x: 50, y: 300 });
    supervisor.start(session);
    expect(supervisor.isWatching).toBe(true);

    vi.advanceTimersByTime(TAB_DETACH_COMMIT_IDLE_MS + 16);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(50, 300);
    expect(onReentered).not.toHaveBeenCalled();
    // 提交后看护终止（幂等，不会重复提交）
    expect(supervisor.isWatching).toBe(false);
    vi.advanceTimersByTime(TAB_DETACH_COMMIT_IDLE_MS * 3);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('should keep watching while cursor keeps moving outside', () => {
    const { supervisor, session, onCommit, getCursorPoint } = makeSupervisor({ x: 50, y: 300 });
    supervisor.start(session);
    // 光标每 100ms 移动一次（重置静止计时），沿窗外持续左移 2s 不提交
    //（向左远离窗口：x 递减恒在 bounds.x=100 左侧，不会误入窗内触发 reentered）
    for (let t = 100; t <= 2000; t += 100) {
      vi.advanceTimersByTime(100);
      getCursorPoint.mockReturnValue({ x: 50 - t / 10, y: 300 });
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(supervisor.isWatching).toBe(true);
  });

  it('should call onReentered once and stop when cursor returns inside window', () => {
    const { supervisor, session, onReentered, onCommit, getCursorPoint } = makeSupervisor({
      x: 50,
      y: 300,
    });
    supervisor.start(session);
    getCursorPoint.mockReturnValue({ x: 400, y: 300 });
    vi.advanceTimersByTime(16);

    expect(onReentered).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(supervisor.isWatching).toBe(false);
  });

  it('should abort without commit when source window disappears (bounds null)', () => {
    const { supervisor, session, onCommit } = makeSupervisor({ x: 50, y: 300 });
    const boundsSpy = vi.fn(() => null);
    supervisor.start({ ...session, bounds: boundsSpy });
    vi.advanceTimersByTime(16);

    expect(onCommit).not.toHaveBeenCalled();
    expect(supervisor.isWatching).toBe(false);
  });

  it('should treat cancel as no-op stop and ignore stale sessions', () => {
    const { supervisor, session, onCommit } = makeSupervisor({ x: 50, y: 300 });
    supervisor.start(session);
    supervisor.cancel();
    expect(supervisor.isWatching).toBe(false);
    // cancel 后时间流逝不触发提交
    vi.advanceTimersByTime(TAB_DETACH_COMMIT_IDLE_MS * 2);
    expect(onCommit).not.toHaveBeenCalled();

    // cancel 在未看护期为幂等 no-op
    expect(() => supervisor.cancel()).not.toThrow();
  });

  it('should terminate previous session when started again (single pointer assumption)', () => {
    const {
      supervisor,
      session: staleSession,
      onCommit: staleCommit,
    } = makeSupervisor({
      x: 50,
      y: 300,
    });
    const freshCommit = vi.fn();
    const freshReentered = vi.fn();
    supervisor.start(staleSession);
    // 同一实例二次 start：上一会话立即终止（其静止计时不再累积），只有新会话裁决
    supervisor.start({
      bounds: () => ({ ...BOUNDS }),
      onReentered: freshReentered,
      onCommit: freshCommit,
    });
    vi.advanceTimersByTime(TAB_DETACH_COMMIT_IDLE_MS + 16);
    expect(staleCommit).not.toHaveBeenCalled();
    expect(freshCommit).toHaveBeenCalledTimes(1);
  });
});
