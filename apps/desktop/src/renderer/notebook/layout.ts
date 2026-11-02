/**
 * 笔记页三区布局计算（纯函数，可单测）
 *
 * 持久化的是「比例」（left/middle/right 归一化为 1），而非绝对像素。
 * 这样三区始终铺满整个内容区，并随主窗口尺寸变化自动按比例伸缩。
 *
 * 约束：
 * - 两条分割线各占 6px，不参与可伸缩区域
 * - 默认比例 1:2:2（左 / 中 / 右）
 * - 拖拽时只移动相邻两区的边界，第三区宽度随之铺满余量
 */
import type { NotebookLayout } from './types';

export const SPLITTER_WIDTH = 6;
export const MIN_LEFT = 160;
export const MIN_MIDDLE = 220;
export const MIN_RIGHT = 220;
const MIN_TOTAL = MIN_LEFT + MIN_MIDDLE + MIN_RIGHT;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 可用内容宽度（扣除两条分割线；容器极小时保底最小总宽） */
export function usableWidth(totalWidth: number): number {
  return Math.max(totalWidth - SPLITTER_WIDTH * 2, MIN_TOTAL);
}

/** 默认 1:2:2 比例布局 */
export function defaultLayout(): NotebookLayout {
  return { left: 0.2, middle: 0.4, right: 0.4, custom: false };
}

/**
 * 规范化为合法比例：三值必须为正数，归一化到和为 1。
 * 用于读取持久化值时兼容旧版像素值（如 200/400/400 → 0.2/0.4/0.4）。
 */
export function normalizeLayout(layout: NotebookLayout): NotebookLayout {
  const left = Number.isFinite(layout.left) && layout.left > 0 ? layout.left : 0.2;
  const middle = Number.isFinite(layout.middle) && layout.middle > 0 ? layout.middle : 0.4;
  const right = Number.isFinite(layout.right) && layout.right > 0 ? layout.right : 0.4;
  const sum = left + middle + right;
  return {
    left: left / sum,
    middle: middle / sum,
    right: right / sum,
    custom: layout.custom,
  };
}

/** 由比例与容器宽度算出各区像素宽度（铺满可用宽度） */
export function widthsFromLayout(
  layout: NotebookLayout,
  totalWidth: number,
): { left: number; middle: number; right: number } {
  const usable = usableWidth(totalWidth);
  const ratios = normalizeLayout(layout);
  return {
    left: ratios.left * usable,
    middle: ratios.middle * usable,
    right: ratios.right * usable,
  };
}

/** 拖拽左分割线：左侧增减、中区反向、右区铺满余量 */
export function resizeLeftLayout(
  layout: NotebookLayout,
  delta: number,
  totalWidth: number,
): NotebookLayout {
  const usable = usableWidth(totalWidth);
  const ratios = normalizeLayout(layout);
  const leftPx = clamp(ratios.left * usable + delta, MIN_LEFT, usable - MIN_MIDDLE - MIN_RIGHT);
  const middlePx = clamp(ratios.middle * usable - delta, MIN_MIDDLE, usable - leftPx - MIN_RIGHT);
  const rightPx = usable - leftPx - middlePx;
  return {
    left: leftPx / usable,
    middle: middlePx / usable,
    right: rightPx / usable,
    custom: true,
  };
}

/** 拖拽右分割线：中区增减、右区反向、左区铺满余量 */
export function resizeRightLayout(
  layout: NotebookLayout,
  delta: number,
  totalWidth: number,
): NotebookLayout {
  const usable = usableWidth(totalWidth);
  const ratios = normalizeLayout(layout);
  const middlePx = clamp(ratios.middle * usable + delta, MIN_MIDDLE, usable - MIN_LEFT - MIN_RIGHT);
  const rightPx = clamp(ratios.right * usable - delta, MIN_RIGHT, usable - MIN_LEFT - middlePx);
  const leftPx = usable - middlePx - rightPx;
  return {
    left: leftPx / usable,
    middle: middlePx / usable,
    right: rightPx / usable,
    custom: true,
  };
}
