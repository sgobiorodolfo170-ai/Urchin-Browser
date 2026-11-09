/**
 * 邮箱页三区布局计算（纯函数，可单测）
 *
 * 依据：用户反馈「左中右分割线可自由拖动 + 持久化位置；写邮件未铺满右区」（2026-11-10）
 * 持久化的是左/中两区的像素宽度（右区始终铺满余量），与 notebook 的比例方案不同：
 * 邮件客户端的文件夹/列表栏是「固定宽」语义——窗口缩放时栏宽保持稳定，读信区自适应。
 *
 * 约束：
 * - 两条分割线各占 SPLITTER_WIDTH px，不参与内容区
 * - 默认宽度与既有 Tailwind 固定宽一致（w-48=192 / w-72=284），首启外观不变
 * - 左分割线只调文件夹栏宽，右分割线只调列表栏宽（Outlook/Thunderbird 语义，
 *   拖一条线只动它紧邻的栏），右区保底 DETAIL_MIN 反向约束两栏上限
 */

/** mail.state 持久化结构（settings 表 JSON） */
export interface MailLayoutState {
  /** 结构版本，便于未来演进 */
  v: 1;
  /** 文件夹栏宽度（px） */
  folderWidth: number;
  /** 邮件列表栏宽度（px） */
  listWidth: number;
}

export const SPLITTER_WIDTH = 6;

/** 文件夹栏宽度下限（px） */
export const MIN_FOLDER_WIDTH = 140;

/** 邮件列表栏宽度下限（px） */
export const MIN_LIST_WIDTH = 200;

/** 右区（详情/撰写）宽度下限（px） */
export const MIN_DETAIL_WIDTH = 320;

/** 默认宽度与既有固定宽对齐：w-48=192px、w-72=284px */
export const DEFAULT_FOLDER_WIDTH = 192;
export const DEFAULT_LIST_WIDTH = 284;

/** 持久化键：与 notebook.state 同机制（settings 表，须登记 SettingsManager 默认列表） */
export const MAIL_STATE_KEY = 'mail.state';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 可用内容宽度（扣除两条分割线；容器极小时保底最小总宽，避免负数） */
export function usableWidth(totalWidth: number): number {
  return Math.max(
    totalWidth - SPLITTER_WIDTH * 2,
    MIN_FOLDER_WIDTH + MIN_LIST_WIDTH + MIN_DETAIL_WIDTH,
  );
}

/** 拖左分割线：文件夹栏增减；列表栏保持（过窄时先收敛到下限），右区铺满余量 */
export function resizeFolderWidth(
  folderWidth: number,
  listWidth: number,
  delta: number,
  totalWidth: number,
): { folderWidth: number; listWidth: number } {
  const usable = usableWidth(totalWidth);
  const list = clamp(listWidth, MIN_LIST_WIDTH, usable - MIN_FOLDER_WIDTH - MIN_DETAIL_WIDTH);
  const next = clamp(folderWidth + delta, MIN_FOLDER_WIDTH, usable - list - MIN_DETAIL_WIDTH);
  return { folderWidth: next, listWidth: list };
}

/** 拖右分割线：列表栏增减；文件夹栏保持（过宽时先收敛到上限），右区铺满余量 */
export function resizeListWidth(
  folderWidth: number,
  listWidth: number,
  delta: number,
  totalWidth: number,
): { folderWidth: number; listWidth: number } {
  const usable = usableWidth(totalWidth);
  const folder = clamp(folderWidth, MIN_FOLDER_WIDTH, usable - MIN_LIST_WIDTH - MIN_DETAIL_WIDTH);
  const next = clamp(listWidth + delta, MIN_LIST_WIDTH, usable - folder - MIN_DETAIL_WIDTH);
  return { folderWidth: folder, listWidth: next };
}

/**
 * 从持久化值恢复合法宽度：非有限数回退默认值，并按当前容器宽度收敛上限
 * （窗口比上次更窄时，避免左/中两栏把右区挤到小于 DETAIL_MIN）。
 */
export function restoreWidths(
  raw: unknown,
  totalWidth: number,
): { folderWidth: number; listWidth: number } {
  const usable = usableWidth(totalWidth);
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawFolder =
    typeof obj.folderWidth === 'number' && Number.isFinite(obj.folderWidth)
      ? obj.folderWidth
      : DEFAULT_FOLDER_WIDTH;
  const rawList =
    typeof obj.listWidth === 'number' && Number.isFinite(obj.listWidth)
      ? obj.listWidth
      : DEFAULT_LIST_WIDTH;
  const folder = clamp(rawFolder, MIN_FOLDER_WIDTH, usable - MIN_LIST_WIDTH - MIN_DETAIL_WIDTH);
  const list = clamp(rawList, MIN_LIST_WIDTH, usable - folder - MIN_DETAIL_WIDTH);
  return { folderWidth: folder, listWidth: list };
}

/** 组装待持久化状态（拖拽结束时调用） */
export function buildMailState(folderWidth: number, listWidth: number): MailLayoutState {
  return { v: 1, folderWidth, listWidth };
}
