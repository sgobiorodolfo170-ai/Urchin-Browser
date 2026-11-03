/**
 * 中转区 · 单项行（展开态）
 *
 * 220px 宽展开态下的项目行：类型图标 + 标题 + 来源徽标 + 图钉指示。
 * 可拖拽（draggable）用于拖出到目标区域或内部排序。
 * 拖出落盘他处后由 onDragEndItem 回调通知面板移除（被定住的除外）。
 * Ctrl+单击切换图钉定住状态；多选模式下单击切换选中。
 */
import { memo } from 'react';
import { X, Pin } from 'lucide-react';
import { cn } from '../lib/utils';
import { getTransitItemIcon } from './icons';
import { TRANSIT_DRAG_MIME, truncateTitle, type TransitItem } from './types';

interface TransitItemRowProps {
  readonly item: TransitItem;
  readonly onRemove: (id: string) => void;
  readonly onDragStartItem: (id: string) => void;
  readonly onDropItem: (e: React.DragEvent, id: string) => void;
  readonly onDragEndItem: (id: string, dropEffect: string) => void;
  readonly onTogglePin: (id: string) => void;
  readonly selectMode: boolean;
  readonly selected: boolean;
  readonly onToggleSelect: (id: string) => void;
}

function TransitItemRowImpl({
  item,
  onRemove,
  onDragStartItem,
  onDropItem,
  onDragEndItem,
  onTogglePin,
  selectMode,
  selected,
  onToggleSelect,
}: TransitItemRowProps): React.ReactElement | null {
  const Icon = getTransitItemIcon(item);
  return (
    <div
      data-transit-item
      className={cn(
        'group relative flex cursor-grab items-center gap-2 rounded px-2 py-1.5 text-xs',
        'hover:bg-surface-secondary',
        item.missing && 'opacity-40',
        selectMode && 'cursor-pointer',
        selected && 'bg-primary/15 ring-1 ring-inset ring-primary/40',
        item.pinned && !selected && 'bg-primary/5',
      )}
      draggable={!selectMode}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(TRANSIT_DRAG_MIME, JSON.stringify(item));
        onDragStartItem(item.id);
      }}
      onDragEnd={(e) => {
        onDragEndItem(item.id, e.dataTransfer.dropEffect);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TRANSIT_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(TRANSIT_DRAG_MIME)) {
          e.preventDefault();
          e.stopPropagation();
          onDropItem(e, item.id);
        }
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.stopPropagation();
          e.preventDefault();
          onTogglePin(item.id);
          return;
        }
        if (selectMode) {
          e.stopPropagation();
          onToggleSelect(item.id);
        }
      }}
      title={item.missing ? `${item.title}（原文件已不存在）` : item.title}
    >
      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="flex-1 truncate text-text">{truncateTitle(item.title)}</span>
      {item.pinned && (
        <Pin className="h-3 w-3 shrink-0 rotate-45 text-primary" aria-label="已定住" />
      )}
      {item.missing && !item.pinned && (
        <span className="shrink-0 text-[10px] text-red-500" title="原文件已不存在">
          !
        </span>
      )}
      <button
        type="button"
        className={cn(
          'shrink-0 rounded p-0.5 text-text-secondary opacity-0',
          'hover:bg-surface hover:text-text group-hover:opacity-100',
        )}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item.id);
        }}
        aria-label="移除"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export const TransitItemRow = memo(TransitItemRowImpl);
