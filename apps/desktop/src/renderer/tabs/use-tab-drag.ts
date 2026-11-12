/**
 * 标签拖出浏览器窗口 / 标签卡片右键菜单（App 域 hook，
 * refactor-plan-p2 §2.3 步骤 7，代码自 App.tsx 原样迁出）
 *
 * 拖出浏览器窗口：自定义指针拖拽，检测到鼠标移出窗口边界时把 detach 决策
 * 移交主进程光标看护（tab.detachDrag.start，2026-11-13「拖出可拖回」重写）。
 *
 * 方案背景：
 * - v1 HTML5 系统拖放（text/uri-list）→ Windows 对拖到桌面的 URL 默认生成快捷方式，
 *   且拖出窗口后 DOM 事件由 OS 接管、主进程拿不到 URL
 * - v2 自定义拖拽：窗口内全程受控（指针事件），移出边界即触发打开
 * - v3（用户反馈）：① 拖出后关闭原窗口标签（移动语义，与原窗口不再保留一致）；
 *   ② 新窗口定位到拖出瞬间的屏幕坐标（跟随拖拽位置，不重叠在原窗口上）。
 *   指针移出 OS 窗口后渲染进程收不到事件，故用出界瞬间的屏幕坐标定位（出界即开窗）
 * - v4（2026-11-13 用户指令「拖出后也可以拖回」）：出界不再立即开窗，改为挂起并
 *   由主进程 screen.getCursorScreenPoint() 轮询看护（与悬浮球拖动引擎同一模式）：
 *   光标拖回窗内 → reentered 事件取消（标签保留）；窗外静止 1s（视为松手）→
 *   committed 事件（主进程已开新窗口并关闭原标签，渲染层只做状态清理）。
 * 仅 http/https 可拖（内部页无法外部打开）。
 *
 * 右键菜单状态也在此收拢：菜单渲染在 App 根层（TabCardContextMenu），
 * 跨工作区打开/关闭等动作依赖 App 的标签生命周期，故状态经 hook 归 App 域。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

/** 主进程看护事件的 payload（tabId 用于丢弃陈旧会话的迟到事件）。 */
interface DetachDragEventPayload {
  tabId?: number;
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

  /**
   * 拖出挂起态：指针已越过窗口边界、tab.detachDrag.start 已上报，等待主进程
   * 光标看护裁决（reentered = 拖回取消 / committed = 松手提交）。
   * ref 而非 state：纯拖拽协议状态，不参与渲染。
   */
  const detachPendingRef = useRef(false);

  // 订阅主进程看护裁决（拖回 / 提交）。tabId 不匹配或无活动拖拽时忽略
  //（防上一轮会话的迟到事件污染当前状态）。
  useEffect(() => {
    const offReentered = window.urchin.on('tab.detachDrag.reentered', (payload) => {
      const p = payload as DetachDragEventPayload;
      if (tabDragRef.current && (p.tabId === undefined || p.tabId === tabDragRef.current.tabId)) {
        // 拖回成立：清除挂起态，恢复常规拖拽（窗内松手 = 无动作；
        // 再次出界会重新上报 start，天然支持反复拖出拖回）
        detachPendingRef.current = false;
      }
    });
    const offCommitted = window.urchin.on('tab.detachDrag.committed', (payload) => {
      const p = payload as DetachDragEventPayload;
      if (tabDragRef.current && (p.tabId === undefined || p.tabId === tabDragRef.current.tabId)) {
        // 主进程已开新窗口并关闭原标签（标签卡片将随 tabs-changed 卸载），
        // 渲染层只清理拖拽状态；不改 detachPendingRef（会话已结束）
        tabDragRef.current = null;
        detachPendingRef.current = false;
      }
    });
    return () => {
      offReentered();
      offCommitted();
    };
  }, []);

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
    detachPendingRef.current = false;
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
    if (
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight
    ) {
      // 指针越过窗口边界：不立即开新窗口（v3 行为，无法拖回），改为挂起并
      // 上报主进程开始光标看护。挂起中重复出界只上报一次（幂等守卫）；
      // 上报失败回滚挂起态，窗内松手仍可正常结束。
      if (!detachPendingRef.current) {
        detachPendingRef.current = true;
        void window.urchin
          .invoke('tab.detachDrag.start', {
            tabId: st.tabId,
            url: st.url,
            workspaceId: st.workspaceId,
          })
          .catch((err) => {
            detachPendingRef.current = false;
            console.error('Failed to start tab detach drag supervision:', err);
          });
      }
    }
  }, []);

  const handleTabPointerEnd = useCallback((e: React.PointerEvent) => {
    const st = tabDragRef.current;
    tabDragRef.current = null;
    if (!st || !detachPendingRef.current) return;
    detachPendingRef.current = false;
    // 窗内松手 = 拖回成立，明确取消主进程看护（幂等；常规路径 reentered 先到，
    // 此处兜底「松手时窗内但轮询尚未判定」的竞态）。
    // 窗外松手（事件仍可达的平台/环境）不取消：主进程静止看门狗按松手提交。
    if (
      e.clientX >= 0 &&
      e.clientY >= 0 &&
      e.clientX <= window.innerWidth &&
      e.clientY <= window.innerHeight
    ) {
      void window.urchin.invoke('tab.detachDrag.cancel', {}).catch(() => {
        /* 取消失败无需回滚：主进程看门狗独立裁决 */
      });
    }
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
