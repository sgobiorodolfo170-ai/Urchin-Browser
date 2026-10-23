/**
 * 侧栏标签列表滚动 Hook（用户指令 2026-10-23）
 *
 * 需求：标签溢出时隐藏滚动条，支持鼠标滚轮查看，并支持「长按左键 + 上下拖动」
 * 平移列表。滚轮由 overflow-y-auto 原生处理（配合隐藏滚动条样式）；本 Hook 只
 * 补充长按拖动，并吞掉平移结束后的 click，避免误触切标签。
 *
 * 设计理由：
 * - 长按阈值 300ms：与单击/双击、标签「拖出窗口」手势区分，短按仍走原逻辑
 * - 长按前移动超过 6px 视为拖动标签而非平移，立即取消长按计时
 * - 平移期间 stopPropagation，阻断 React 根上的标签拖出窗口逻辑，防止两者叠加
 * - click 捕获阶段拦截：平移后浏览器仍会派发 click，必须阻止卡片选中
 * - 只在标签项上启动（data-tab-card / button），空白区域保留侧栏拖窗手势
 */
import { useEffect, useRef } from 'react';

/** 长按进入平移的等待时间（ms） */
const LONG_PRESS_MS = 300;

/** 长按判定前允许的指针位移（px），超过则视为普通拖动 */
const MOVE_CANCEL_PX = 6;

interface PanState {
  readonly pointerId: number;
  readonly startY: number;
  readonly startScrollTop: number;
  panning: boolean;
}

export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const stateRef = useRef<PanState | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const handlePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // 仅标签项启用长按平移；空白处不拦截，保留侧栏拖窗
      if (!target.closest('[data-tab-card], button')) return;
      // 关闭按钮是独立交互，不参与平移
      if (target.closest('button[aria-label="关闭标签"]')) return;

      suppressClickRef.current = false;
      const state: PanState = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startScrollTop: el.scrollTop,
        panning: false,
      };
      stateRef.current = state;
      clearTimer();
      timer = setTimeout(() => {
        if (stateRef.current === state) {
          state.panning = true;
        }
      }, LONG_PRESS_MS);
    };

    const handlePointerMove = (e: PointerEvent): void => {
      const state = stateRef.current;
      if (state?.pointerId !== e.pointerId) return;
      const deltaY = e.clientY - state.startY;

      if (!state.panning) {
        // 长按前明显移动：按普通点击/拖拽处理，取消平移
        if (Math.abs(deltaY) > MOVE_CANCEL_PX) {
          clearTimer();
          stateRef.current = null;
        }
        return;
      }

      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 0) return;
      el.scrollTop = Math.min(maxScroll, Math.max(0, state.startScrollTop - deltaY));
      suppressClickRef.current = true;
      // 阻断 React 根事件：避免与标签「拖出窗口」手势同时生效
      e.stopPropagation();
    };

    const finishPan = (e: PointerEvent): void => {
      const state = stateRef.current;
      if (state?.pointerId !== e.pointerId) return;
      clearTimer();
      stateRef.current = null;
    };

    const handleClickCapture = (e: MouseEvent): void => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('pointerdown', handlePointerDown);
    el.addEventListener('pointermove', handlePointerMove);
    el.addEventListener('pointerup', finishPan);
    el.addEventListener('pointercancel', finishPan);
    el.addEventListener('click', handleClickCapture, true);
    // 指针移出列表后松开：兜底清理平移状态
    window.addEventListener('pointerup', finishPan);
    window.addEventListener('pointercancel', finishPan);

    return () => {
      clearTimer();
      el.removeEventListener('pointerdown', handlePointerDown);
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', finishPan);
      el.removeEventListener('pointercancel', finishPan);
      el.removeEventListener('click', handleClickCapture, true);
      window.removeEventListener('pointerup', finishPan);
      window.removeEventListener('pointercancel', finishPan);
    };
  }, []);

  return ref;
}
