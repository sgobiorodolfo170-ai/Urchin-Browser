/**
 * 中转区 · 迷你图标（折叠态）
 *
 * 44px 宽折叠态下的项目图标列表：仅显示类型图标，hover tooltip 显示标题。
 * 可拖拽用于拖出到目标区域。
 * 拖出落盘他处后由 onDragEndItem 回调通知面板移除（被定住的除外）。
 * Ctrl+单击切换图钉定住状态。
 */
import { memo } from 'react';
import { Pin } from 'lucide-react';
import { cn } from '../lib/utils';
import { getTransitItemIcon } from './icons';
import { TRANSIT_DRAG_MIME, type TransitItem } from './types';

interface TransitItemIconProps {
  readonly item: TransitItem;
  readonly onDragEndItem: (id: string, dropEffect: string) => void;
  readonly onTogglePin: (id: string) => void;
}

function TransitItemIconImpl({
  item,
  onDragEndItem,
  onTogglePin,
}: TransitItemIconProps): React.ReactElement | null {
  const Icon = getTransitItemIcon(item);
  return (
    <div
      data-transit-item
      className={cn(
        'relative flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded',
        'hover:bg-surface-secondary',
        item.missing && 'opacity-40',
        item.pinned && 'bg-primary/10',
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(TRANSIT_DRAG_MIME, JSON.stringify(item));
      }}
      onDragEnd={(e) => {
        onDragEndItem(item.id, e.dataTransfer.dropEffect);
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.stopPropagation();
          e.preventDefault();
          onTogglePin(item.id);
        }
      }}
      title={item.missing ? `${item.title}（原文件已不存在）` : item.title}
    >
      <Icon className="h-4 w-4 text-text-secondary" />
      {item.pinned && <Pin className="absolute right-0 top-0 h-2.5 w-2.5 rotate-45 text-primary" />}
    </div>
  );
}

export const TransitItemIcon = memo(TransitItemIconImpl);
