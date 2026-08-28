/**
 * M1 Window Lifecycle · 窗口状态记忆（window-state）单元测试
 *
 * 验证：
 * 1. loadWindowState：无记录/形状非法/尺寸过小/显示器不可见 → null；合法记录 → 原样返回
 * 2. trackWindowState：resize/move 防抖 500ms 落盘；窗口期内多次变更只写一次
 * 3. 最大化/全屏时保存 getNormalBounds（保住「还原尺寸」），isMaximized 随状态落盘
 * 4. maximize/unmaximize/close 事件立即落盘（不等待防抖；退出前冲刷未落盘变更）
 * 5. 已销毁窗口 / 非法 bounds 不落盘（防御）
 *
 * 设计说明：window-state 通过最小依赖接口（TrackedWindow / settings get/set）
 * 与 Electron、SettingsManager 解耦，测试无需 mock electron。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadWindowState,
  trackWindowState,
  WINDOW_STATE_SETTINGS_KEY,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
  type WindowState,
} from '../../src/main/windows/window-state';

/** 单显示器 1920x1080（虚拟屏幕坐标从原点开始） */
const SINGLE_DISPLAY = [{ x: 0, y: 0, width: 1920, height: 1080 }];

/** 双显示器：主屏 1920 宽 + 副屏从 x=1920 起 */
const DUAL_DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1280, height: 1024 },
];

function makeSettings(saved: unknown = null): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  return { get: vi.fn().mockReturnValue(saved), set: vi.fn() };
}

/** 最小窗口替身：记录事件监听、可编程 bounds/最大化/全屏/销毁状态 */
class FakeWindow {
  private readonly handlers = new Map<string, () => void>();
  bounds = { x: 10, y: 20, width: 1280, height: 800 };
  /** 最大化/全屏时 getNormalBounds 的返回值（正常态 bounds） */
  normalBounds = { x: 10, y: 20, width: 1280, height: 800 };
  maximized = false;
  fullscreen = false;
  minimized = false;
  destroyed = false;

  on(event: string, handler: () => void): void {
    this.handlers.set(event, handler);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds };
  }

  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.normalBounds };
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 测试辅助：触发窗口事件 */
  emit(event: string): void {
    this.handlers.get(event)?.();
  }

  /** 测试辅助：调整尺寸并触发 resize */
  resizeTo(width: number, height: number): void {
    this.bounds = { ...this.bounds, width, height };
    this.emit('resize');
  }

  /** 测试辅助：移动并触发 move */
  moveTo(x: number, y: number): void {
    this.bounds = { x, y, width: this.bounds.width, height: this.bounds.height };
    this.emit('move');
  }
}

describe('loadWindowState', () => {
  it('should return null when no saved value exists', () => {
    expect(loadWindowState(makeSettings(null), () => SINGLE_DISPLAY)).toBeNull();
    expect(loadWindowState(makeSettings(undefined), () => SINGLE_DISPLAY)).toBeNull();
  });

  it('should return the saved state when it is valid and visible', () => {
    const saved: WindowState = { x: 100, y: 50, width: 1024, height: 768, isMaximized: false };
    const settings = makeSettings(saved);

    expect(loadWindowState(settings, () => SINGLE_DISPLAY)).toEqual(saved);
    expect(settings.get).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY);
  });

  it('should return null for malformed values', () => {
    for (const bad of [
      42,
      '1280x800',
      [],
      {},
      { x: 0, y: 0, width: 1024, height: 768 }, // 缺 isMaximized
      { x: 0, y: 0, width: 1024, height: 768, isMaximized: 'yes' },
      { x: Number.NaN, y: 0, width: 1024, height: 768, isMaximized: false },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 768, isMaximized: false },
    ]) {
      expect(loadWindowState(makeSettings(bad), () => SINGLE_DISPLAY)).toBeNull();
    }
  });

  it('should return null when size is below the window minimum', () => {
    // minWidth/minHeight 800x600（window-geometry 单一真源）
    const tooSmall: WindowState = { x: 0, y: 0, width: 799, height: 800, isMaximized: false };
    const tooShort: WindowState = { x: 0, y: 0, width: 1024, height: 599, isMaximized: false };
    expect(loadWindowState(makeSettings(tooSmall), () => SINGLE_DISPLAY)).toBeNull();
    expect(loadWindowState(makeSettings(tooShort), () => SINGLE_DISPLAY)).toBeNull();
  });

  it('should return null when the window is off-screen (display unplugged)', () => {
    // 完全在主屏之外且无副屏
    const offScreen: WindowState = {
      x: 5000,
      y: 5000,
      width: 1024,
      height: 768,
      isMaximized: false,
    };
    expect(loadWindowState(makeSettings(offScreen), () => SINGLE_DISPLAY)).toBeNull();
  });

  it('should return null when overlap with any display is too small to grab the title bar', () => {
    // 右缘仅 70px 露在屏内（< 最小可见宽度 100px）→ 无法拖回，回退默认
    const barelyVisible: WindowState = {
      x: 1850,
      y: 0,
      width: 1024,
      height: 768,
      isMaximized: false,
    };
    expect(loadWindowState(makeSettings(barelyVisible), () => SINGLE_DISPLAY)).toBeNull();
    // 足够可见（120px 重叠）→ 恢复
    const visibleEnough: WindowState = {
      x: 1800,
      y: 0,
      width: 1024,
      height: 768,
      isMaximized: false,
    };
    expect(loadWindowState(makeSettings(visibleEnough), () => SINGLE_DISPLAY)).toEqual(
      visibleEnough,
    );
  });

  it('should restore a window that lives on a secondary display', () => {
    const onSecond: WindowState = { x: 2200, y: 100, width: 900, height: 700, isMaximized: false };
    expect(loadWindowState(makeSettings(onSecond), () => DUAL_DISPLAYS)).toEqual(onSecond);
  });

  it('should return null when no displays are reported or screen access throws', () => {
    const valid: WindowState = { x: 0, y: 0, width: 1024, height: 768, isMaximized: false };
    expect(loadWindowState(makeSettings(valid), () => [])).toBeNull();
    expect(
      loadWindowState(makeSettings(valid), () => {
        throw new Error('no screen');
      }),
    ).toBeNull();
  });
});

describe('trackWindowState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(saved: unknown = null): {
    win: FakeWindow;
    settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  } {
    const win = new FakeWindow();
    const settings = makeSettings(saved);
    trackWindowState(win, settings);
    return { win, settings };
  }

  it('should persist bounds after resize, debounced', () => {
    const { win, settings } = setup();
    win.resizeTo(1100, 720);

    expect(settings.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 1100,
      height: 720,
      isMaximized: false,
    });
  });

  it('should coalesce rapid resize/move changes into a single write', () => {
    const { win, settings } = setup();
    win.resizeTo(1000, 700);
    win.resizeTo(1050, 710);
    win.moveTo(30, 40);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 30,
      y: 40,
      width: 1050,
      height: 710,
      isMaximized: false,
    });
  });

  it('should persist after move as well', () => {
    const { win, settings } = setup();
    win.moveTo(200, 100);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 200,
      y: 100,
      width: 1280,
      height: 800,
      isMaximized: false,
    });
  });

  it('should save normal bounds (not maximized bounds) while maximized', () => {
    const { win, settings } = setup();
    win.maximized = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1040 }; // 最大化后的实际 bounds
    win.normalBounds = { x: 10, y: 20, width: 1280, height: 800 };
    win.resizeTo(1920, 1040); // maximize 后的 resize（屏切换等）
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 1280,
      height: 800,
      isMaximized: true,
    });
  });

  it('should persist immediately on maximize with pre-maximize bounds', () => {
    const { win, settings } = setup();
    win.maximized = true;
    win.normalBounds = { x: 10, y: 20, width: 1280, height: 800 };
    win.emit('maximize');

    // 不推进定时器：maximize 立即落盘
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 1280,
      height: 800,
      isMaximized: true,
    });
  });

  it('should persist immediately on unmaximize with restored bounds', () => {
    const { win, settings } = setup();
    win.maximized = false;
    win.bounds = { x: 5, y: 5, width: 900, height: 620 };
    win.emit('unmaximize');

    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 5,
      y: 5,
      width: 900,
      height: 620,
      isMaximized: false,
    });
  });

  it('should flush pending debounced changes on close (quit before timer fires)', () => {
    const { win, settings } = setup();
    win.resizeTo(950, 650);
    win.emit('close'); // 关闭窗口，防抖定时器尚未到期

    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 950,
      height: 650,
      isMaximized: false,
    });
  });

  it('should save normal bounds while fullscreen (fullscreen size is not the restore size)', () => {
    const { win, settings } = setup();
    win.fullscreen = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.resizeTo(1920, 1080);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    // FakeWindow 提供了 getNormalBounds，全屏时同样保存正常 bounds
    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 1280,
      height: 800,
      isMaximized: false,
    });
  });

  it('should save normal bounds when closing while minimized (Windows -32000 sentinel)', () => {
    const { win, settings } = setup();
    win.minimized = true;
    // Windows 最小化窗口 getBounds 返回 -32000 哨兵坐标，不可当作恢复位置
    win.bounds = { x: -32000, y: -32000, width: 800, height: 600 };
    win.emit('close');

    expect(settings.set).toHaveBeenCalledWith(WINDOW_STATE_SETTINGS_KEY, {
      x: 10,
      y: 20,
      width: 1280,
      height: 800,
      isMaximized: false,
    });
  });

  it('should skip saving when the window is destroyed before the debounce fires', () => {
    const { win, settings } = setup();
    win.resizeTo(1000, 700);
    win.destroyed = true;
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('should skip saving when bounds are invalid (defensive guard)', () => {
    const { win, settings } = setup();
    win.bounds = { x: 10, y: 20, width: 400, height: 300 }; // 低于最小尺寸
    win.resizeTo(400, 300);
    vi.advanceTimersByTime(WINDOW_STATE_SAVE_DEBOUNCE_MS);

    expect(settings.set).not.toHaveBeenCalled();
  });
});
