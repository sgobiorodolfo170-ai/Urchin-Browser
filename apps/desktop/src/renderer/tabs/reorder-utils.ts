/**
 * 侧栏标签拖拽排序的落点计算（纯函数，DOM 无关，可单测）
 *
 * 为什么不用 elementFromPoint 找指针下的卡片（2026-11-15 重写根因）：
 * 旧实现只在「指针恰好压在另一张卡片本体上」时才识别落点——卡片间 6px 间隙、
 * 列表 8px 内边距、末卡下方的大片空白（列表 flex-1，标签少时大部分是空白）
 * 全是静默死区，松手后什么都不发生，表现为「有时能拖动有时拖不动」。
 * 改为按卡片矩形序列 + 指针 Y 做几何边界计算：任何 Y 都落在某个插入边界上，
 * 死区归入相邻卡片的上下半（与用户「放到它上面/下面」的直觉一致）。
 *
 * 边界模型：边界 b ∈ 0..n 表示「插到第 b 张卡片之前」（b = n 即末尾追加）。
 * 指针在卡片 i 的上半 → 边界 i（插到它前面）；下半 → 边界 i+1（插到它后面）；
 * 卡片间间隙 → 归入下方卡的上半；首卡上方 → 边界 0；末卡下方 → 边界 n。
 * 拖拽卡自身要先从序列中摘除再算插入位（边界在自身之下时前移一位），
 * 映射后与原位相同 = 原地放下 = 返回 null（不发无意义的 reorder）。
 */

/** 插入方位：相对 targetId 在当前渲染顺序中的位置 */
export type ReorderPosition = 'before' | 'after';

/** 一次落点计算的结果（targetId + 方位，直接对应 tab.reorder 入参） */
export interface ReorderTarget {
  targetId: number;
  position: ReorderPosition;
}

/** 参与计算的卡片（id + 视口矩形；只用纵向两个值，DOM 无关便于单测） */
export interface ReorderCard {
  id: number;
  /** 视口坐标：矩形上缘 */
  top: number;
  /** 视口坐标：矩形下缘 */
  bottom: number;
}

/**
 * 由指针 Y 与卡片矩形序列（渲染顺序，上→下）计算拖拽排序落点。
 *
 * @param cards 当前渲染顺序的卡片序列（须含被拖拽卡自身）
 * @param draggedId 被拖拽的标签 id
 * @param clientY 松手时指针的视口 Y
 * @returns 需要 reorder 时返回 { targetId, position }；原地放下 / 参数无效返回 null
 */
export function computeReorderTarget(
  cards: readonly ReorderCard[],
  draggedId: number,
  clientY: number,
): ReorderTarget | null {
  const from = cards.findIndex((c) => c.id === draggedId);
  // 被拖卡不在列表中（拖拽期间标签被关等）：无从计算
  if (from < 0) return null;
  const count = cards.length;
  // 只剩自己一张：任何落点都是原地
  if (count < 2) return null;

  // 1. 求插入边界 b ∈ 0..n
  const first = cards[0]!;
  const last = cards[count - 1]!;
  let boundary: number;
  if (clientY < first.top) {
    // 首卡上方（列表 padding / 新建标签区）：置顶
    boundary = 0;
  } else if (clientY >= last.bottom) {
    // 末卡下方（列表空白 / 底部留白）：追加到末尾
    boundary = count;
  } else {
    boundary = count; // 防御式兜底：理论上下方循环必命中
    for (let i = 0; i < count; i++) {
      const rect = cards[i]!;
      if (clientY < rect.top) {
        // 卡片间间隙：归入下方卡的上半（插到它前面）
        boundary = i;
        break;
      }
      if (clientY <= rect.bottom) {
        // 压在卡片本体上：上下半分界（中点以上 = 它前面，以下 = 它后面）
        boundary = clientY < (rect.top + rect.bottom) / 2 ? i : i + 1;
        break;
      }
    }
  }

  // 2. 摘除自身后边界平移：边界在自身位之下时前移一位，得到最终落位
  const finalIndex = boundary <= from ? boundary : boundary - 1;
  // 原地放下（含压在自己上半 / 下半 / 紧邻自己下方的间隙）：不动作
  if (finalIndex === from) return null;

  // 3. 边界 → (targetId, position)：b < n 表达为「第 b 张之前」；
  // b = n（末尾追加）只能表达为「末张之后」
  const targetIndex = Math.min(boundary, count - 1);
  return {
    targetId: cards[targetIndex]!.id,
    position: boundary >= count ? 'after' : 'before',
  };
}
