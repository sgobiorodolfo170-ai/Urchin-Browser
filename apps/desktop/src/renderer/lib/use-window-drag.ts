/**
 * 按住侧边栏空白处拖动窗口（手动实现，非 -webkit-app-region）。
 *
 * -webkit-app-region: drag 会吞掉鼠标事件（双击展开/折叠、悬停自动展开失效），
 * 故手动：pointerdown 记录起点，移动超过阈值（3px）才真正拖窗，经 IPC
 * ui.window.dragBy 发送屏幕坐标增量，主进程移动窗口。
 * - 交互元素（按钮/输入/拖拽手柄等）上不触发拖窗（保留原有交互）
 * - 未超阈值的按下-抬起视为点击/双击，不受影响
 */
import { useCallback, useEffect, useRef } from 'react';

export function useWindowDrag() {
  const dragStateRef = useRef<{
    lastX: number;
    lastY: number;
    started: boolean;
    captureEl?: HTMLElement;
    pointerId?: number;
  } | null>(null);

  const endDrag = useCallback(() => {
    const st = dragStateRef.current;
    // 主动释放指针捕获：不释放的话捕获残留在侧边栏元素上，
    // 拖窗时指针移出窗口导致 pointerup 错过，后续所有点击被吞（表现为卡死/无法操作）。
    if (st?.captureEl && st.pointerId !== undefined) {
      try {
        st.captureEl.releasePointerCapture(st.pointerId);
      } catch {
        /* 指针未捕获/已释放，忽略 */
      }
    }
    dragStateRef.current = null;
  }, []);

  // 兜底清理：拖拽期间 pointerup/pointercancel 若在侧边栏元素外错过（如拖窗时指针
  // 短暂移出窗口再松开），捕获会永久卡在侧边栏上。在 window 层兜底监听，
  // 任何位置松手都能清除拖拽状态。
  useEffect(() => {
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [endDrag]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // 交互元素上不触发窗口拖拽（含标签卡片：卡片自身支持拖出窗口，见 handleTabPointerDown）
    if (
      target.closest(
        'button, input, select, textarea, a, [role="button"], [role="separator"], [data-tab-card]',
      )
    ) {
      return;
    }
    dragStateRef.current = { lastX: e.screenX, lastY: e.screenY, started: false };
    // 捕获指针：拖出元素后仍持续接收 move/up（jsdom 无此方法时跳过）
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
        dragStateRef.current.captureEl = el;
        dragStateRef.current.pointerId = e.pointerId;
      } catch {
        /* 指针已捕获（如旧拖拽状态未清），忽略，仍可拖拽 */
      }
    }
  }, []);

  const moveDrag = useCallback((e: React.PointerEvent) => {
    const st = dragStateRef.current;
    if (!st) return;
    // 仅处理由当前元素发起的拖拽：避免事件冒泡到外框时重复触发 moveDrag（如侧栏拖拽冒泡）
    if (st.captureEl && st.captureEl !== (e.currentTarget as HTMLElement | null)) return;
    // 未超阈值：视为点击/双击，不拖窗
    if (!st.started) {
      const dist = Math.hypot(e.screenX - st.lastX, e.screenY - st.lastY);
      if (dist < 3) return;
      st.started = true;
    }
    const dx = e.screenX - st.lastX;
    const dy = e.screenY - st.lastY;
    st.lastX = e.screenX;
    st.lastY = e.screenY;
    void window.urchin.invoke('ui.window.dragBy', { dx, dy }).catch(() => {
      // 主进程窗口移动失败静默（测试环境等）
    });
  }, []);

  return { startDrag, moveDrag, endDrag };
}
