/**
 * 底部悬浮状态栏渲染入口（独立透明子窗口加载 ?view=statusbar）。
 *
 * 不挂载完整 App——状态由主渲染进程经主进程中转同步；用户动作回传主渲染进程。
 * 页面背景透明，仅渲染 3D 卡片，透出底层网页。
 */
import { useEffect, useState } from 'react';
import { StatusBar } from './status-bar';
import type { StatusBarState, StatusBarAction } from '@urchin/ipc-contract';

/** 建议面板额外高度（与主进程 computeStatusBarBounds 常量对齐） */
const SUGGESTIONS_PANEL_HEIGHT = 332;
/** toast 额外高度 */
const TOAST_PANEL_HEIGHT = 44;

const DEFAULT_STATE: StatusBarState = {
  visible: false,
  url: '',
  loading: false,
  securityState: 'insecure',
  canGoBack: false,
  canGoForward: false,
  reloadDisabled: true,
  bookmarkSaved: false,
  bookmarkable: false,
  summarizeDisabled: true,
  screenshotDisabled: true,
  translateActive: false,
  translateDisabled: true,
  searchEngine: 'duckduckgo',
  suggestions: [],
  toast: null,
  theme: 'light',
};

export function StatusBarRoot() {
  const [state, setState] = useState<StatusBarState>(DEFAULT_STATE);
  const [focused, setFocused] = useState(false);

  // 取缓存状态 + 订阅后续更新
  useEffect(() => {
    let cancelled = false;
    void window.urchin
      .invoke('ui.statusbar.getState', {})
      .then((res) => {
        if (!cancelled && res) {
          setState(res as StatusBarState);
        }
      })
      .catch((e) => {
        console.error('statusbar getState failed:', e);
      });
    const off = window.urchin.on('ui.statusbar.state', (payload) => {
      if (cancelled) return;
      setState(payload as StatusBarState);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // 主题：直接设置 <html data-theme>，使 globals/tokens 变量生效
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // 窗口标题（便于 E2E / a11y 识别悬浮层）
  useEffect(() => {
    document.title = 'Urchin Status Bar';
    document.documentElement.dataset.window = 'statusbar';
  }, []);

  const suggestionsOpen = focused && state.suggestions.length > 0;
  const toast = suggestionsOpen ? null : state.toast;
  const panelHeight = suggestionsOpen ? SUGGESTIONS_PANEL_HEIGHT : toast ? TOAST_PANEL_HEIGHT : 0;

  // 上报额外面板高度，主进程据此调整窗口高度（向上展开）
  useEffect(() => {
    void window.urchin.invoke('ui.statusbar.setExpanded', { panelHeight }).catch((e) => {
      console.error('statusbar setExpanded failed:', e);
    });
  }, [panelHeight]);

  const handleAction = (action: StatusBarAction): void => {
    void window.urchin.invoke('ui.statusbar.action', action).catch((e) => {
      console.error('statusbar action failed:', e);
    });
  };

  return (
    <StatusBar state={state} focused={focused} onAction={handleAction} onFocusChange={setFocused} />
  );
}
