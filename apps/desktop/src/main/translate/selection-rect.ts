/**
 * 选区几何采集（划词翻译结果卡的尺寸基准）
 *
 * 设计（2026-11-10 用户需求）：结果卡此前只按「译文自身排版」定尺寸——短译文会把卡片
 * 折叠成一个小方块，与用户选中的那段文字的宽高、行数完全不成比例。现在卡片以选区
 * 几何为基准：宽高至少覆盖选区矩形，行数作为高度下限参考（见 selection-card-overlay
 * 的 resolveTextSize）。
 *
 * 为什么把脚本放主进程而不是页面注入 preload：
 * - 右键菜单点击那一刻选区仍在页面里，`executeJavaScript` 在页面主世界求值即可拿到
 *   `window.getSelection()`；无需为所有网页挂接 preload（仓库已有教训：BrowserView
 *   注入 preload 会阻塞网页加载，见 create-browser-view.ts 头部说明）。
 * - 只在右键菜单弹出时读一次，代价为一次同步脚本求值，对页面无副作用、不写入任何状态。
 *
 * 坐标系：`getClientRects()` 返回页面 CSS px（与 context-menu 事件 params.x/y 同口径），
 * 安装方按 BrowserView 偏移量补偿后即为窗口相对坐标。
 */

/** 选区几何（页面 CSS px，页面坐标系） */
export interface SelectionRect {
  /** 选区矩形左缘 */
  x: number;
  /** 选区矩形上缘 */
  y: number;
  /** 选区矩形宽度（跨行时取各行并集，即最宽行） */
  width: number;
  /** 选区矩形高度（首行顶到最后一行底） */
  height: number;
  /** 选区跨行数（client rect 按行中线去重计数） */
  lines: number;
}

/** 单个几何值的合理上限（px）：防异常页面返回离谱尺寸把窗口撑爆 */
const MAX_RECT_VALUE = 10000;

/**
 * 页面世界求值脚本：返回当前选区并集矩形与行数，无选区时返回 null。
 *
 * 行数用「rect 中线四舍五入」去重而非 rect 个数——同一行内的多个内联节点（<b>、<a>
 * 等）会各自返回 rect，按 top 直接计数会把单行误判成多行。
 */
export const READ_SELECTION_RECT_SCRIPT = `(() => {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const lines = new Set();
  for (let i = 0; i < sel.rangeCount; i += 1) {
    const range = sel.getRangeAt(i);
    const rects = range.getClientRects ? Array.from(range.getClientRects()) : [];
    for (const rect of rects) {
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      lines.add(Math.round(rect.top + rect.height / 2));
    }
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    lines: lines.size,
  };
})()`;

/** 将脚本返回值规整为 SelectionRect；结构不符或尺寸非正时返回 null（调用方退回估算） */
export function normalizeSelectionRect(raw: unknown): SelectionRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const { x, y, width, height, lines } = raw as Partial<Record<keyof SelectionRect, unknown>>;
  const nums = [x, y, width, height, lines];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const w = width as number;
  const h = height as number;
  if (w <= 0 || h <= 0) return null;
  return {
    x: Math.min(MAX_RECT_VALUE, x as number),
    y: Math.min(MAX_RECT_VALUE, y as number),
    width: Math.min(MAX_RECT_VALUE, w),
    height: Math.min(MAX_RECT_VALUE, h),
    lines: Math.max(1, Math.min(MAX_RECT_VALUE, Math.round(lines as number))),
  };
}

/** 采集选区几何所需的最小 webContents 接口（真实 WebContents 与测试 mock 均满足） */
export interface SelectionRectSource {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
}

/**
 * 读取当前网页选区几何（失败/无选区/接口缺失一律返回 null，调用方按译文估算兜底）。
 *
 * `userGesture = true`：右键菜单点击属用户手势上下文，允许脚本读取选区。
 */
export async function readSelectionRect(wc: SelectionRectSource): Promise<SelectionRect | null> {
  if (typeof wc.executeJavaScript !== 'function') return null;
  try {
    const raw = await wc.executeJavaScript(READ_SELECTION_RECT_SCRIPT, true);
    return normalizeSelectionRect(raw);
  } catch {
    // 页面已销毁 / 求值被拒 / 跨进程异常：几何缺省即可，不影响翻译本身
    return null;
  }
}
