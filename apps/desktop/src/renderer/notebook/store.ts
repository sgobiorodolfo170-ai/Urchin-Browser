/**
 * 笔记 / 便利贴模块 · 状态加载与持久化
 *
 * 状态存放在 settings 键 `notebook.state`（SQLite settings 表）：
 * - 与右侧栏宽度等 UI 偏好一致，复用 settings.get / settings.set
 * - 写入防抖 400ms，避免每次按键都落盘
 * - 组件卸载时 flush 未写入的变更
 *
 * 主进程 SettingsManager 构造时只加载 DEFAULT_SETTINGS 中登记的键，
 * 因此 `notebook.state` 必须同步加入其默认列表，否则重启会读不到。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeNotebookState } from './normalize';
import { NOTEBOOK_STATE_KEY, type NotebookState } from './types';

export const NOTEBOOK_SAVE_DEBOUNCE_MS = 400;

type StateUpdater = (prev: NotebookState) => NotebookState;

export interface NotebookStore {
  readonly state: NotebookState | null;
  readonly update: (updater: StateUpdater) => void;
}

interface SettingsGetResult {
  readonly value?: unknown;
}

function invokeSettingsGet(): Promise<SettingsGetResult> {
  return window.urchin.invoke('settings.get', {
    key: NOTEBOOK_STATE_KEY,
  }) as Promise<SettingsGetResult>;
}

function persistState(state: NotebookState): void {
  void window.urchin
    .invoke('settings.set', { key: NOTEBOOK_STATE_KEY, value: state })
    .catch((error: unknown) => {
      console.error('Failed to persist notebook state:', error);
    });
}

export function useNotebookStore(): NotebookStore {
  const [state, setState] = useState<NotebookState | null>(null);
  const stateRef = useRef<NotebookState | null>(null);
  const pendingRef = useRef<NotebookState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback((next: NotebookState) => {
    pendingRef.current = next;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) persistState(pending);
    }, NOTEBOOK_SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await invokeSettingsGet();
        if (!alive) return;
        const normalized = normalizeNotebookState(result.value);
        stateRef.current = normalized;
        setState(normalized);
      } catch (error) {
        console.error('Failed to load notebook state:', error);
        if (!alive) return;
        const fallback = normalizeNotebookState(null);
        stateRef.current = fallback;
        setState(fallback);
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
      if (pending) persistState(pending);
    };
  }, []);

  const update = useCallback(
    (updater: StateUpdater) => {
      const prev = stateRef.current;
      if (!prev) return;
      const next = updater(prev);
      if (next === prev) return;
      stateRef.current = next;
      setState(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  return { state, update };
}
