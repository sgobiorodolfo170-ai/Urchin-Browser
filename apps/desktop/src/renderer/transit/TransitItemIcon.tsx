/**
 * 中转区 · 迷你图标（折叠态）
 *
 * 44px 宽折叠态下的项目图标列表：仅显示类型图标，hover tooltip 显示标题。
 * 可拖拽用于拖出到目标区域。
 */
import { memo } from 'react';
import { cn } from '../lib/utils';
import { getTransitItemIcon } from './icons';
import { TRANSIT_DRAG_MIME, type TransitItem } from './types';

interface TransitItemIconProps {
  readonly item: TransitItem;
}

function TransitItemIconImpl({ item }: TransitItemIconProps): React.ReactElement | null {
  const Icon = getTransitItemIcon(item);
  return (
    <div
      className={cn(
        'flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded',
        'hover:bg-surface-secondary',
        item.missing && 'opacity-40',
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(TRANSIT_DRAG_MIME, JSON.stringify(item));
      }}
      title={item.missing ? `${item.title}（原文件已不存在）` : item.title}
    >
      <Icon className="h-4 w-4 text-text-secondary" />
    </div>
  );
}

export const TransitItemIcon = memo(TransitItemIconImpl);
