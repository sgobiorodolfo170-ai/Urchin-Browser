/**
 * 中转区 · 拖拽解析工具
 *
 * 供目标投放区（笔记/邮箱/主页等）解析来自中转区的拖拽数据。
 * 目标组件在 onDrop 中调用 parseTransitDrag 即可获取 TransitItem。
 */
import { TRANSIT_DRAG_MIME, normalizeItem, type TransitItem } from './types';

/** 判断当前拖拽是否来自中转区 */
export function isTransitDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TRANSIT_DRAG_MIME);
}

/** 解析中转区拖拽数据为 TransitItem；非中转区拖拽或解析失败返回 null */
export function parseTransitDrag(dataTransfer: DataTransfer): TransitItem | null {
  const raw = dataTransfer.getData(TRANSIT_DRAG_MIME);
  if (!raw) return null;
  try {
    return normalizeItem(JSON.parse(raw));
  } catch {
    return null;
  }
}
