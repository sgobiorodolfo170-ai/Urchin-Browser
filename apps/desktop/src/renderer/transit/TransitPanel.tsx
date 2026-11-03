/**
 * 中转区 · 容器面板
 *
 * 位于左侧栏折叠按钮下方、功能区上方。两种渲染态：
 * - 展开态（leftExpanded=true，220px 宽）：标题栏 + 图钉按钮 + 清空按钮 + 可滚动项目列表
 * - 折叠态（leftExpanded=false，44px 宽）：迷你图标列表
 *
 * 拖入来源（P1 实现外部文件拖入）：
 * - OS 文件（桌面/资源管理器）：e.dataTransfer.files → filePath 索引
 * - 内部排序：自定义 MIME application/x-urchin-transit
 *
 * 拖出落盘他处后移除（被定住的除外）：
 * - 拖出时 onDragStart 设置 draggingIdRef；内部排序 drop 时清除该 ref
 * - onDragEnd 检测到 ref 未被清除（= 外部落盘）且 dropEffect !== 'none'（= 成功落盘）
 *   时，若该 item 未被图钉定住则从中转区移除
 *
 * 图钉定住（pinned）：
 * - 展开态标题栏图钉按钮：点击进入多选，选中文件再次点击图钉即确认定住
 * - Ctrl+单击任意条目：切换该条目定住状态（不限展开/折叠）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Inbox, Pin } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTransitStore, type TransitItemInput } from './store';
import { TransitItemRow } from './TransitItemRow';
import { TransitItemIcon } from './TransitItemIcon';
import { TRANSIT_DRAG_MIME, normalizeItem, type TransitItem } from './types';
import { resolveDroppedFilePath } from './file-path';

interface TransitPanelProps {
  /** 左侧栏是否展开（true=220px 列表态，false=44px 迷你态） */
  readonly expanded: boolean;
}

/** 从 DataTransfer 提取 OS 文件并转为 TransitItem 输入 */
export function collectDroppedFiles(dataTransfer: DataTransfer): {
  kind: 'file';
  title: string;
  filePath: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceApp: 'desktop';
}[] {
  const files = dataTransfer.files;
  if (!files || files.length === 0) return [];
  const results: {
    kind: 'file';
    title: string;
    filePath: string;
    mimeType?: string;
    sizeBytes?: number;
    sourceApp: 'desktop';
  }[] = [];
  for (const file of Array.from(files)) {
    const path = resolveDroppedFilePath(file);
    if (!path) continue;
    results.push({
      kind: 'file',
      title: file.name || path,
      filePath: path,
      mimeType: file.type || undefined,
      sizeBytes: file.size,
      sourceApp: 'desktop',
    });
  }
  return results;
}

export function TransitPanel({ expanded }: TransitPanelProps): React.ReactElement | null {
  const { items, loaded, add, remove, reorder, clear, togglePin, setPinned } = useTransitStore();
  const [dragOverSelf, setDragOverSelf] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const draggingIdRef = useRef<string | null>(null);

  // ── 监听主进程推送的「加入中转区」事件（右键菜单选中文字/链接/视频） ──
  useEffect(() => {
    const off = window.urchin.on('transit:add', (payload: unknown) => {
      const data = payload as Partial<TransitItemInput> | null;
      if (!data?.kind || !data?.title) return;
      add(data as TransitItemInput);
    });
    return () => {
      off();
    };
  }, [add]);

  // ── Escape 退出多选模式 ──
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectMode(false);
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectMode]);

  // ── 外部文件拖入 / 内部排序 drop / 纯文本拖入 ──
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    // 接受自定义 MIME（内部排序）、OS 文件、或纯文本（笔记/邮件反向拖入）
    if (
      e.dataTransfer.types.includes(TRANSIT_DRAG_MIME) ||
      e.dataTransfer.types.includes('Files') ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files')
        ? 'copy'
        : e.dataTransfer.types.includes(TRANSIT_DRAG_MIME)
          ? 'move'
          : 'copy';
      setDragOverSelf(true);
    }
  }, []);

  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setDragOverSelf(false);
    }
  }, []);

  const handlePanelDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverSelf(false);

      // 优先处理 OS 文件拖入
      const droppedFiles = collectDroppedFiles(e.dataTransfer);
      if (droppedFiles.length > 0) {
        for (const input of droppedFiles) {
          add(input);
        }
        return;
      }

      // 内部排序：拖到空白区 = 移到末尾
      const raw = e.dataTransfer.getData(TRANSIT_DRAG_MIME);
      if (raw) {
        try {
          const item = normalizeItem(JSON.parse(raw));
          if (item && draggingIdRef.current) {
            // 拖到空白区：移到列表末尾（通过 reorder 到最后一项）
            const lastItem = items[items.length - 1];
            if (lastItem && lastItem.id !== draggingIdRef.current) {
              reorder(draggingIdRef.current, lastItem.id);
            }
          }
        } catch {
          // 解析失败：忽略
        }
        // 内部排序：清除 ref，让 onDragEnd 不当作外部落盘
        draggingIdRef.current = null;
        return;
      }

      // 纯文本拖入（笔记/邮件/其他应用选中文本拖出）
      const plainText = e.dataTransfer.getData('text/plain');
      if (plainText.trim()) {
        const trimmed = plainText.trim();
        // URL → link 类型
        if (/^https?:\/\//i.test(trimmed)) {
          add({ kind: 'link', title: trimmed, url: trimmed, sourceApp: 'browser' });
        } else {
          add({ kind: 'text', title: trimmed.slice(0, 40), text: trimmed, sourceApp: 'browser' });
        }
      }
    },
    [add, items, reorder],
  );

  // ── 粘贴存入（P7）：剪贴板文件→file 项目，文本→text/link 项目 ──
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // 剪贴板有文件（从文件管理器复制）
      const files = e.clipboardData.files;
      if (files && files.length > 0) {
        const inputs = collectDroppedFiles(e.clipboardData);
        if (inputs.length > 0) {
          e.preventDefault();
          for (const input of inputs) {
            add(input);
          }
          return;
        }
      }
      // 剪贴板有纯文本
      const text = e.clipboardData.getData('text/plain');
      if (text.trim()) {
        e.preventDefault();
        const trimmed = text.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          add({ kind: 'link', title: trimmed, url: trimmed, sourceApp: 'browser' });
        } else {
          add({ kind: 'text', title: trimmed.slice(0, 40), text: trimmed, sourceApp: 'browser' });
        }
      }
    },
    [add],
  );

  // ── 内部排序：拖到某项上 ──
  const handleItemDragStart = useCallback((id: string) => {
    draggingIdRef.current = id;
  }, []);

  const handleItemDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      const raw = e.dataTransfer.getData(TRANSIT_DRAG_MIME);
      if (!raw) return;
      try {
        const item = normalizeItem(JSON.parse(raw));
        if (item && draggingIdRef.current && draggingIdRef.current !== targetId) {
          reorder(draggingIdRef.current, targetId);
        }
      } catch {
        // 解析失败：忽略
      }
      // 内部排序：清除 ref，让 onDragEnd 不当作外部落盘
      draggingIdRef.current = null;
    },
    [reorder],
  );

  // itemsRef 供 handleDragEndItem 同步读取最新 items
  const itemsRef = useRef<readonly TransitItem[]>(items);
  itemsRef.current = items;

  // ── 拖出落盘他处后移除（被定住的除外） ──
  const handleDragEndItem = useCallback(
    (id: string, dropEffect: string) => {
      const wasInternal = draggingIdRef.current === null;
      draggingIdRef.current = null;
      if (wasInternal) return;
      if (dropEffect === 'none') return;
      // 外部成功落盘：若未被定住则从中转区移除
      const dragged = itemsRef.current.find((it) => it.id === id);
      if (dragged && !dragged.pinned) {
        remove(id);
      }
    },
    [remove],
  );

  // ── 图钉多选模式 ──
  const handlePinButtonClick = useCallback(() => {
    if (!selectMode) {
      // 进入多选模式
      setSelectMode(true);
      setSelectedIds(new Set());
    } else {
      // 确认定住选中项，退出多选
      if (selectedIds.size > 0) {
        setPinned([...selectedIds], true);
      }
      setSelectMode(false);
      setSelectedIds(new Set());
    }
  }, [selectMode, selectedIds, setPinned]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    if (items.length === 0) return;
    clear();
  }, [items.length, clear]);

  // ── 折叠态：迷你图标列表 ──
  if (!expanded) {
    return (
      <div
        className={cn(
          'flex flex-col items-center gap-1 px-1 py-2',
          dragOverSelf && 'bg-primary/10',
        )}
        tabIndex={0}
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={handlePanelDrop}
        onPaste={handlePaste}
      >
        {loaded && items.length === 0 && (
          <Inbox className="h-4 w-4 text-text-secondary opacity-30" />
        )}
        {items.slice(0, 12).map((item) => (
          <TransitItemIcon
            key={item.id}
            item={item}
            onDragEndItem={handleDragEndItem}
            onTogglePin={togglePin}
          />
        ))}
        {items.length > 12 && (
          <span className="text-[10px] text-text-secondary">+{items.length - 12}</span>
        )}
      </div>
    );
  }

  // ── 展开态：标题 + 列表 ──
  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', dragOverSelf && 'bg-primary/5')}
      tabIndex={0}
      onPaste={handlePaste}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">
          {selectMode ? `已选 ${selectedIds.size} 项` : '中转区'}
        </span>
        <div className="flex items-center gap-1">
          {/* 图钉按钮：点击进入多选 / 再次点击确认定住 */}
          <button
            type="button"
            className={cn(
              'rounded p-1 text-text-secondary hover:bg-surface-secondary hover:text-text',
              items.length === 0 && 'pointer-events-none opacity-0',
              selectMode && 'bg-primary/20 text-primary',
            )}
            onClick={handlePinButtonClick}
            aria-label={selectMode ? '确认定住选中项' : '进入多选定住'}
            title={selectMode ? '确认定住选中项' : '多选定住'}
          >
            <Pin className={cn('h-3.5 w-3.5', selectMode && 'rotate-45')} />
          </button>
          {/* 清空按钮 */}
          <button
            type="button"
            className={cn(
              'rounded p-1 text-text-secondary hover:bg-surface-secondary hover:text-text',
              (items.length === 0 || selectMode) && 'pointer-events-none opacity-0',
            )}
            onClick={handleClear}
            aria-label="清空中转区"
            title="清空中转区"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 项目列表（可滚动） */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-1 pb-2',
          dragOverSelf && 'ring-1 ring-inset ring-primary/30',
          selectMode && 'ring-1 ring-inset ring-primary/20',
        )}
        onDragOver={handlePanelDragOver}
        onDragLeave={handlePanelDragLeave}
        onDrop={handlePanelDrop}
      >
        {loaded && items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-2 py-6 text-center">
            <Inbox className="h-6 w-6 text-text-secondary opacity-30" />
            <p className="text-[11px] leading-tight text-text-secondary opacity-60">
              拖入文件、文字、截图
              <br />
              或网页链接到此
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item: TransitItem) => (
              <TransitItemRow
                key={item.id}
                item={item}
                onRemove={remove}
                onDragStartItem={handleItemDragStart}
                onDropItem={handleItemDrop}
                onDragEndItem={handleDragEndItem}
                onTogglePin={togglePin}
                selectMode={selectMode}
                selected={selectedIds.has(item.id)}
                onToggleSelect={handleToggleSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
