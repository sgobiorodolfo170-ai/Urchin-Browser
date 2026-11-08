/**
 * 设置页自动保存 hook（App 域 hook，refactor-plan-p2 §3.3 步骤 1，代码自
 * SettingsPage.tsx 原样迁出）
 *
 * 职责：设置键值对的加载（settings.getAll）、字段更新（entries state）、
 * 自动保存队列（变更后 debounce 800ms 批量 settings.set + 广播
 * urchin:settings-changed）、卸载兜底保存、重置默认值。
 *
 * 为什么是 App 调用的 hook 而不是状态收进各 Section 组件：entries 是全部
 * 设置键的单一真源，跨选项卡共享（切换 tab 不重载），收进任一 Section 都会
 * 迫使其他 Section 层层上提。toast / saving 之外的 UI 状态留在页面组件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** settings.getAll 返回的单条设置 */
export interface SettingsEntry {
  readonly key: string;
  readonly value: unknown;
}

/** 默认值（用于重置） */
const DEFAULTS: Record<string, unknown> = {
  language: 'zh-CN',
  searchEngine: 'google',
  downloadsPath: '',
  blockTrackers: true,
  doNotTrack: true,
  blockAds: true,
  'links.openInNewTab': false,
  'ui.rightSidebarAutoExpand': false,
  'ui.leftSidebarAutoExpand': false,
  'ui.workspaceSwitcherMode': 'cards',
  'debug.sidebarHoverDelay': 300,
  'ui.statusBall.sensitivityVertical': 1,
  'ui.statusBall.sensitivityHorizontal': 1,
  'translate.targetLang': 'zh-CN',
  'translate.engine': 'auto',
  'translate.autoTranslate': false,
  'startup.restoreTabs': true,
  'clipper.defaultFormat': 'markdown',
  'clipper.cleanSnapshot': true,
  'clipper.selectionPriority': true,
  'clipper.loadLazyContent': false,
  'clipper.trimBoilerplate': true,
  'clipper.localizeImages': true,
  'clipper.noteNameFormat': '{{title}}',
  'clipper.properties':
    'title: {{title}}\nsource: {{url}}\nauthor: {{author}}\npublished: {{published}}\ncreated: {{date}}\ndescription: {{description}}\ntags: clippings',
  'clipper.content': '{{content}}',
};

export interface UseSettingsOptions {
  /** 页面级轻提示（已保存 / 保存失败 / 已重置等，1.5s 自动消失） */
  readonly onToast: (msg: string) => void;
}

export function useSettings({ onToast }: UseSettingsOptions) {
  const [entries, setEntries] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 待保存的变更（key → value），自动保存队列
  const pendingRef = useRef<Map<string, unknown>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const settingsRes = (await window.urchin.invoke('settings.getAll', {})) as {
          entries: readonly SettingsEntry[];
        };
        const next: Record<string, unknown> = {};
        for (const e of settingsRes.entries) next[e.key] = e.value;
        setEntries(next);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  // 自动保存：变更后 debounce 800ms 批量写入（与主流浏览器设置页对齐）
  const flushSave = useCallback(async () => {
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    const items = Array.from(pending.entries());
    pending.clear();
    setSaving(true);
    try {
      for (const [key, value] of items) {
        await window.urchin.invoke('settings.set', { key, value });
      }
      onToast('已保存');
      // 通知其他 React 组件设置已变更（如 App.tsx 的侧边栏悬停延迟）
      window.dispatchEvent(
        new CustomEvent('urchin:settings-changed', { detail: { keys: items.map(([k]) => k) } }),
      );
    } catch (e) {
      onToast('保存失败：' + String(e));
    } finally {
      setSaving(false);
    }
  }, [onToast]);

  const updateField = useCallback(
    (key: string, value: unknown) => {
      setEntries((prev) => ({ ...prev, [key]: value }));
      pendingRef.current.set(key, value);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void flushSave();
      }, 800);
    },
    [flushSave],
  );

  // 卸载时保存未提交的变更
  useEffect(() => {
    // 捕获 ref 当前值，避免 cleanup 时读到变化后的引用
    const pending = pendingRef.current;
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // 同步执行最后一批保存（不等待）
      if (pending.size > 0) {
        for (const [key, value] of pending) {
          void window.urchin.invoke('settings.set', { key, value });
        }
      }
    };
  }, []);

  const handleReset = useCallback(async () => {
    if (!window.confirm('确定重置所有设置为默认值？')) return;
    try {
      for (const [k, v] of Object.entries(DEFAULTS)) {
        await window.urchin.invoke('settings.set', { key: k, value: v });
      }
      const next = { ...DEFAULTS };
      setEntries(next);
      onToast('已重置为默认值');
    } catch (e) {
      onToast('重置失败：' + String(e));
    }
  }, [onToast]);

  return {
    entries,
    loading,
    error,
    saving,
    updateField,
    handleReset,
  } as const;
}
