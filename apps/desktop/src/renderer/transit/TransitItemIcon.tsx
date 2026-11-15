/**
 * 中转区 · 迷你图标（折叠态）
 *
 * 44px 宽折叠态下的项目图标列表：仅显示类型图标，hover tooltip 显示标题。
 * 可拖拽用于拖出到目标区域。
 * 拖出落盘他处后由 onDragEndItem 回调通知面板移除（被定住的除外）。
 * Ctrl+单击切换图钉定住状态。
 */
import { memo } from 'react';
import { Pin, PinOff } from 'lucide-react';
import { cn } from '../lib/utils';
import { getTransitItemIcon } from './icons';
import { TRANSIT_DRAG_MIME, type TransitItem } from './types';

interface TransitItemIconProps {
  readonly item: TransitItem;
  readonly onDragStartItem: (id: string) => void;
  readonly onDragEndItem: (id: string, dropEffect: string) => void;
  readonly onTogglePin: (id: string) => void;
}

function TransitItemIconImpl({
  item,
  onDragStartItem,
  onDragEndItem,
  onTogglePin,
}: TransitItemIconProps): React.ReactElement | null {
  const Icon = getTransitItemIcon(item);
  return (
    <div
      data-transit-item
      className={cn(
        'group relative flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded',
        'hover:bg-surface-secondary',
        item.missing && 'opacity-40',
        item.pinned && 'bg-primary/10',
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(TRANSIT_DRAG_MIME, JSON.stringify(item));
        onDragStartItem(item.id);
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
      <button
        type="button"
        className={cn(
          'absolute -right-1 -top-1 rounded bg-surface p-0.5 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          item.pinned
            ? 'text-primary'
            : 'text-text-secondary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        )}
        aria-label={item.pinned ? `取消固定：${item.title}` : `固定：${item.title}`}
        aria-pressed={!!item.pinned}
        title={item.pinned ? '取消固定（拖出成功后移除）' : '固定（拖出后保留）'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(item.id);
        }}
      >
        {item.pinned ? <PinOff className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
      </button>
    </div>
  );
}

export const TransitItemIcon = memo(TransitItemIconImpl);
