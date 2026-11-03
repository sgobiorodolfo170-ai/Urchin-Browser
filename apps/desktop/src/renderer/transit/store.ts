/**
 * 中转区 · 状态加载与持久化
 *
 * 状态存放在 settings 键 `transit.items`（SQLite settings 表）：
 * - 与 notebook.state 同模式：复用 settings.get / settings.set IPC
 * - 写入防抖 400ms，避免频繁拖入时频繁落盘
 * - 组件卸载时 flush 未写入的变更
 * - 主进程 SettingsManager 构造时需在 DEFAULT_SETTINGS 登记 `transit.items`
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TRANSIT_ITEMS_KEY,
  makeTransitId,
  normalizeItems,
  truncateTitle,
  TRANSIT_ITEMS_MAX,
  type TransitItem,
  type TransitItemKind,
} from './types';

export const TRANSIT_SAVE_DEBOUNCE_MS = 400;

type ItemsUpdater = (prev: readonly TransitItem[]) => readonly TransitItem[];

export interface TransitStore {
  readonly items: readonly TransitItem[];
  readonly loaded: boolean;
  readonly add: (input: TransitItemInput) => TransitItem | null;
  readonly remove: (id: string) => void;
  readonly reorder: (fromId: string, toId: string) => void;
  readonly markMissing: (id: string, missing: boolean) => void;
  readonly togglePin: (id: string) => void;
  readonly setPinned: (ids: readonly string[], pinned: boolean) => void;
  readonly clear: () => void;
}

/** 创建 TransitItem 的输入参数（id/addedAt 由 store 自动填充） */
export interface TransitItemInput {
  readonly kind: TransitItemKind;
  readonly title: string;
  readonly filePath?: string;
  readonly url?: string;
  readonly text?: string;
  readonly mdDocPath?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly thumbnailDataUri?: string;
  readonly sourceApp?: 'browser' | 'desktop' | 'explorer' | 'webview';
}

interface SettingsGetResult {
  readonly value?: unknown;
}

function invokeSettingsGet(): Promise<SettingsGetResult> {
  return window.urchin.invoke('settings.get', {
    key: TRANSIT_ITEMS_KEY,
  }) as Promise<SettingsGetResult>;
}

function persistItems(items: readonly TransitItem[]): void {
  void window.urchin
    .invoke('settings.set', { key: TRANSIT_ITEMS_KEY, value: items })
    .catch((error: unknown) => {
      console.error('Failed to persist transit items:', error);
    });
}

export function useTransitStore(): TransitStore {
  const [items, setItems] = useState<readonly TransitItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef<readonly TransitItem[]>([]);
  const pendingRef = useRef<readonly TransitItem[] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback((next: readonly TransitItem[]) => {
    pendingRef.current = next;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persistItems(pending);
    }, TRANSIT_SAVE_DEBOUNCE_MS);
  }, []);

  const applyUpdate = useCallback(
    (updater: ItemsUpdater) => {
      const prev = itemsRef.current;
      const next = updater(prev);
      if (next === prev) return;
      itemsRef.current = next;
      setItems(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await invokeSettingsGet();
        if (!alive) return;
        const normalized = normalizeItems(result.value);
        itemsRef.current = normalized;
        setItems(normalized);
      } catch (error) {
        console.error('Failed to load transit items:', error);
        if (!alive) return;
        const fallback: readonly TransitItem[] = [];
        itemsRef.current = fallback;
        setItems(fallback);
      } finally {
        if (alive) setLoaded(true);
      }
    })();

    return () => {
      alive = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persistItems(pending);
    };
  }, []);

  const add = useCallback(
    (input: TransitItemInput): TransitItem | null => {
      const prev = itemsRef.current;
      if (prev.length >= TRANSIT_ITEMS_MAX) return null;
      const item: TransitItem = {
        id: makeTransitId(),
        kind: input.kind,
        title: truncateTitle(input.title),
        addedAt: Date.now(),
        ...(input.filePath ? { filePath: input.filePath } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.mdDocPath ? { mdDocPath: input.mdDocPath } : {}),
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
        ...(input.thumbnailDataUri ? { thumbnailDataUri: input.thumbnailDataUri } : {}),
        ...(input.sourceApp ? { sourceApp: input.sourceApp } : {}),
      };
      applyUpdate((items) => [item, ...items]);
      return item;
    },
    [applyUpdate],
  );

  const remove = useCallback(
    (id: string) => {
      applyUpdate((items) => items.filter((it) => it.id !== id));
    },
    [applyUpdate],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      applyUpdate((items) => {
        const fromIdx = items.findIndex((it) => it.id === fromId);
        const toIdx = items.findIndex((it) => it.id === toId);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return items;
        const next = [...items];
        const [moved] = next.splice(fromIdx, 1);
        if (!moved) return items;
        next.splice(toIdx, 0, moved);
        return next;
      });
    },
    [applyUpdate],
  );

  const markMissing = useCallback(
    (id: string, missing: boolean) => {
      applyUpdate((items) => items.map((it) => (it.id === id ? { ...it, missing } : it)));
    },
    [applyUpdate],
  );

  const togglePin = useCallback(
    (id: string) => {
      applyUpdate((items) =>
        items.map((it) => (it.id === id ? { ...it, pinned: !it.pinned || undefined } : it)),
      );
    },
    [applyUpdate],
  );

  const setPinned = useCallback(
    (ids: readonly string[], pinned: boolean) => {
      const idSet = new Set(ids);
      const pinVal = pinned || undefined;
      applyUpdate((items) =>
        items.map((it) => (idSet.has(it.id) ? { ...it, pinned: pinVal } : it)),
      );
    },
    [applyUpdate],
  );

  const clear = useCallback(() => {
    applyUpdate(() => []);
  }, [applyUpdate]);

  return { items, loaded, add, remove, reorder, markMissing, togglePin, setPinned, clear };
}
