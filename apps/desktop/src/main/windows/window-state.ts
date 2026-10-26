/**
 * M1 Window Lifecycle · 主窗口状态记忆（尺寸/位置/最大化态）
 *
 * 依据：用户需求 2026-08-28（拖拽改尺寸后关闭，下次启动恢复关闭前尺寸）
 * 职责：
 * 1. loadWindowState：从 SettingsManager 读取 window.bounds 记录并校验
 *    （形状 / 最小尺寸 / 显示器可见性），不可恢复时返回 null 回退默认
 * 2. trackWindowState：监听窗口 resize/move/maximize/unmaximize/close，
 *    防抖落盘，下次启动由主进程入口恢复
 *
 * 设计理由（AGENTS.md §七.2）：
 * - 持久化复用 SettingsManager（主库 SQLite settings 表 KV），不新建存储通道
 * - 经最小依赖接口（TrackedWindow / settings get/set / getDisplays 注入）解耦
 *   Electron 与 SettingsManager，纯单测可覆盖，无需 mock electron
 * - 最大化/全屏时 getBounds 返回的是最大化 bounds，直接保存会破坏「还原尺寸」，
 *   改存 getNormalBounds（Electron 内部记住的正常态 bounds）
 * - 显示器可见性校验：拔掉显示器 / 改分辨率后，旧位置可能落在屏幕外，
 *   恢复前要求与任一显示器有足够重叠（标题栏可拖回），否则回退默认居中
 */
import { MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } from './window-geometry';
import { createLogger } from '@urchin/logger';

const log = createLogger('window-state');

/** 设置键：主窗口几何记录（x/y/width/height/isMaximized），null = 尚无记录 */
export const WINDOW_STATE_SETTINGS_KEY = 'window.bounds';

/** resize/move 落盘防抖（毫秒）：拖拽过程中高频触发，只在停顿后写一次 SQLite */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;

/**
 * 恢复时与显示器要求的最小重叠（DIP）：
 * 宽 100px / 高 40px——保证标题栏仍有可抓取区域，用户能把窗口拖回屏内。
 */
const MIN_VISIBLE_OVERLAP_WIDTH = 100;
const MIN_VISIBLE_OVERLAP_HEIGHT = 40;

/** 屏幕矩形（Electron Rectangle 的结构子集，测试可注入纯对象） */
export interface WindowStateBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 持久化的窗口状态：正常态 bounds + 最大化标志 */
export interface WindowState extends WindowStateBounds {
  isMaximized: boolean;
}

/** trackWindowState 依赖的最小窗口接口（BrowserWindowLike 结构兼容，测试可注入替身） */
export interface TrackedWindow {
  on(event: string, handler: () => void): void;
  getBounds(): WindowStateBounds;
  /** 最大化/全屏/最小化时的正常态 bounds（Electron getNormalBounds）；测试替身可省略 */
  getNormalBounds?(): WindowStateBounds;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  /** 是否最小化（可选）：Windows 最小化时 getBounds 返回 -32000 哨兵位，须改存正常态 */
  isMinimized?(): boolean;
  isDestroyed(): boolean;
}

/** loadWindowState 依赖的设置读取接口（SettingsManager 结构兼容） */
export interface WindowStateSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** 显示器 bounds 提供者（主进程入口注入 electron screen；测试注入纯矩形） */
export type DisplayBoundsProvider = () => readonly WindowStateBounds[];

/**
 * 形状与取值校验：四个字段均为有限数字、尺寸不低于窗口最小值、
 * isMaximized 为布尔。SQLite 中的记录经 JSON 往返，必须防御任意形状。
 */
export function isWindowState(raw: unknown): raw is WindowState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  return (
    typeof rec.x === 'number' &&
    Number.isFinite(rec.x) &&
    typeof rec.y === 'number' &&
    Number.isFinite(rec.y) &&
    typeof rec.width === 'number' &&
    Number.isFinite(rec.width) &&
    typeof rec.height === 'number' &&
    Number.isFinite(rec.height) &&
    rec.width >= MIN_WINDOW_WIDTH &&
    rec.height >= MIN_WINDOW_HEIGHT &&
    typeof rec.isMaximized === 'boolean'
  );
}

/** 窗口与任一显示器的重叠是否足够（标题栏可抓取）。 */
function isVisibleOnAnyDisplay(
  bounds: WindowStateBounds,
  displays: readonly WindowStateBounds[],
): boolean {
  return displays.some((display) => {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
    const overlapHeight =
      Math.min(bounds.y + bounds.height, display.y + display.height) -
      Math.max(bounds.y, display.y);
    return overlapWidth >= MIN_VISIBLE_OVERLAP_WIDTH && overlapHeight >= MIN_VISIBLE_OVERLAP_HEIGHT;
  });
}

/**
 * 读取并校验上次会话保存的窗口状态。
 *
 * @param settings 设置源（读 window.bounds）
 * @param getDisplays 显示器 bounds 提供者（screen 不可用/抛错按无显示器处理）
 * @returns 可安全恢复的状态；无记录 / 非法 / 屏幕外 → null（调用方回退默认）
 */
export function loadWindowState(
  settings: WindowStateSettings,
  getDisplays: DisplayBoundsProvider,
): WindowState | null {
  const raw = settings.get(WINDOW_STATE_SETTINGS_KEY);
  if (!isWindowState(raw)) return null;

  let displays: readonly WindowStateBounds[];
  try {
    displays = getDisplays();
  } catch (err) {
    // 无头/测试环境 screen 可能不可用：放弃恢复，走默认尺寸
    log.warn('failed to query displays, fallback to default window size', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!isVisibleOnAnyDisplay(raw, displays)) {
    log.info('saved window bounds off-screen, fallback to default', {
      x: raw.x,
      y: raw.y,
      width: raw.width,
      height: raw.height,
    });
    return null;
  }
  return raw;
}

/**
 * 追踪窗口几何变更并防抖落盘。
 *
 * 监听事件：
 * - resize / move → 防抖 WINDOW_STATE_SAVE_DEBOUNCE_MS 后保存
 * - maximize / unmaximize → 立即保存（先冲刷未到期的防抖）
 * - close → 立即保存（应用退出前防抖可能不再触发）
 *
 * @param win 被追踪窗口（主窗口）
 * @param settings 设置 sink（写 window.bounds，同步落 SQLite）
 */
export function trackWindowState(win: TrackedWindow, settings: WindowStateSettings): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 当前应保存的 bounds：最大化/全屏/最小化时取正常态 bounds——最大化尺寸不能
   *  当还原尺寸存；Windows 最小化窗口的 getBounds 会返回 -32000 哨兵坐标。 */
  const currentBounds = (): WindowStateBounds | null => {
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized?.()) {
      return win.getNormalBounds?.() ?? null;
    }
    return win.getBounds();
  };

  const persist = (state: WindowState): void => {
    if (win.isDestroyed()) return;
    if (!isWindowState(state)) return; // 防御：异常 bounds 不落盘
    settings.set(WINDOW_STATE_SETTINGS_KEY, state);
  };

  const saveNow = (): void => {
    const bounds = currentBounds();
    if (bounds) persist({ ...bounds, isMaximized: win.isMaximized() });
  };

  const scheduleSave = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (win.isDestroyed()) return;
      saveNow();
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  };

  /** 立即保存并取消未到期的防抖（maximize/unmaximize/close 共用） */
  const saveImmediately = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (win.isDestroyed()) return;
    saveNow();
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', saveImmediately);
  win.on('unmaximize', saveImmediately);
  win.on('close', saveImmediately);
}
