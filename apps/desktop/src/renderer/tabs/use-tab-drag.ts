/**
 * 标签拖出浏览器窗口 / 标签卡片右键菜单（App 域 hook，
 * refactor-plan-p2 §2.3 步骤 7，代码自 App.tsx 原样迁出）
 *
 * 拖出浏览器窗口：自定义指针拖拽，检测到鼠标移出窗口边界时
 * 经 window.createWithUrl 在新窗口打开该 URL。
 *
 * 方案背景（2026-08-19 迭代）：
 * - v1 HTML5 系统拖放（text/uri-list）→ Windows 对拖到桌面的 URL 默认生成快捷方式，
 *   且拖出窗口后 DOM 事件由 OS 接管、主进程拿不到 URL
 * - v2 自定义拖拽：窗口内全程受控（指针事件），移出边界即触发打开
 * - v3（用户反馈）：① 拖出后关闭原窗口标签（移动语义，与原窗口不再保留一致）；
 *   ② 新窗口定位到拖出瞬间的屏幕坐标（跟随拖拽位置，不重叠在原窗口上）。
 *   指针移出 OS 窗口后渲染进程收不到事件，故用出界瞬间的屏幕坐标定位（出界即开窗）
 * 仅 http/https 可拖（内部页无法外部打开）。
 *
 * 右键菜单状态也在此收拢：菜单渲染在 App 根层（TabCardContextMenu），
 * 跨工作区打开/关闭等动作依赖 App 的标签生命周期，故状态经 hook 归 App 域。
 */
import { useCallback, useRef, useState } from 'react';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/types';
import type { TabSnapshot } from './types';

/** 标签卡片右键菜单状态（TabCardContextMenu 渲染于 App 根层）。 */
export interface TabCardMenuState {
  x: number;
  y: number;
  tab: {
    id: number;
    url: string;
    title: string;
    workspaceId: string;
  };
}

export function useTabDrag() {
  /** 标签卡片右键菜单状态。 */
  const [tabCardMenu, setTabCardMenu] = useState<TabCardMenuState | null>(null);

  const tabDragRef = useRef<{
    pointerId: number;
    url: string;
    tabId: number;
    workspaceId: string;
    captureEl: HTMLElement;
  } | null>(null);

  const handleTabPointerDown = useCallback((e: React.PointerEvent, tab: TabSnapshot) => {
    // TP7：右键不触发拖拽（右键弹出工作区菜单）
    if (e.button !== 0) return;
    if (!/^https?:\/\//i.test(tab.url)) return;
    // 关闭按钮等交互元素上不启动拖拽：setPointerCapture 会把 pointerup 后的
    // click 事件重定向到卡片（捕获目标），关闭按钮的 onClick 永远不触发（关闭阻塞）
    if ((e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    tabDragRef.current = {
      pointerId: e.pointerId,
      url: tab.url,
      tabId: tab.id,
      workspaceId: tab.workspaceId ?? DEFAULT_WORKSPACE_ID,
      captureEl: el,
    };
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 指针捕获失败忽略：仍可拖拽 */
      }
    }
  }, []);

  const handleTabPointerMove = useCallback((e: React.PointerEvent) => {
    const st = tabDragRef.current;
    if (!st) return;
    // 指针移出窗口边界 → 在新窗口打开该标签 URL（定位到出界屏幕坐标），并关闭原窗口标签
    if (
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight
    ) {
      tabDragRef.current = null;
      try {
        st.captureEl.releasePointerCapture(st.pointerId);
      } catch {
        /* 未捕获/已释放忽略 */
      }
      const { url, tabId, workspaceId } = st;
      void window.urchin
        .invoke('window.createWithUrl', { url, x: e.screenX, y: e.screenY, workspaceId })
        .then(() => window.urchin.invoke('tab.close', { tabId }))
        .catch((err) => console.error('Failed to open tab in new window:', err));
    }
  }, []);

  const handleTabPointerEnd = useCallback(() => {
    tabDragRef.current = null;
  }, []);

  /** 标签卡片右键菜单：记录点击位置与标签快照（跨工作区打开/关闭标签）。 */
  const handleTabContextMenu = useCallback((e: React.MouseEvent, tab: TabSnapshot) => {
    e.preventDefault();
    setTabCardMenu({
      x: e.clientX,
      y: e.clientY,
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title || tab.url || '新标签页',
        workspaceId: tab.workspaceId ?? DEFAULT_WORKSPACE_ID,
      },
    });
  }, []);

  return {
    tabCardMenu,
    setTabCardMenu,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerEnd,
    handleTabContextMenu,
  } as const;
}
