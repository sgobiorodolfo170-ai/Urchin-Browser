/** 地址栏与书签栏共用的宽度规则（不依赖 Electron，可在两侧进程使用）。 */
export const STATUS_BAR_SHADOW_PAD = 8;
export const STATUS_BALL_SIZE = 40;
export const STATUS_BALL_PAD = 6;
export const STATUS_SCROLLBAR_WIDTH = 17;
export const STATUS_BALL_GAP = 8;
export const STATUS_BALL_RESERVED_WIDTH =
  STATUS_SCROLLBAR_WIDTH + STATUS_BALL_GAP + STATUS_BALL_SIZE + STATUS_BALL_PAD * 2;

/** 保证地址输入框可用的最小卡片宽度；不足时仍受中区/悬浮球可用空间限制。 */
const MIN_BAR_WIDTH = 496;
const WIDTH_RATIO = 0.6;

/** 返回可见卡片宽度，不含透明阴影边距。 */
export function computeStatusBarCardWidth(middleWidth: number, reserveRight = 0): number {
  const maxBarWidth = Math.max(0, middleWidth - reserveRight - STATUS_BAR_SHADOW_PAD * 2);
  return Math.max(
    0,
    Math.min(Math.max(Math.round(middleWidth * WIDTH_RATIO), MIN_BAR_WIDTH), maxBarWidth),
  );
}
