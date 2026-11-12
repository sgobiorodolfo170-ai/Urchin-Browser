/**
 * 悬浮球渲染入口（独立透明子窗口 ?view=statusbar-ball）。
 *
 * - 图标使用项目主图标（urchin://app-icon），铺满整个球。
 * - 左键单击：展开/隐藏地址栏。
 * - 左键按住拖动：上下/左右滚动网页（摇杆模式），球体轻微位移配合，反方向残影辅助识别；
 *   拖到限位后继续按住，网页仍持续滚动直到松手。灵敏度由设置控制（上下/左右独立）。
 * - 右键按住拖动：移动悬浮球位置（可拖出主窗口到桌面任意位置），地址栏随之保持同一行。
 *   移动由主进程光标轮询驱动（dragStart/dragEnd 起止上报），渲染层不逐事件发 IPC——
 *   52px 小窗口在自身移动时事件流不可靠，增量上报会焦点脱离/卡死（2026-11-13 重写）。
 *   拖动期间球临时置顶、四向自由咬住光标（允许穿过地址栏上方）；松手时若停在
 *   地址栏区域内由主进程结算移出，球不会被地址栏覆盖。
 * - 按下/长按时增强 3D 按压效果。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';
import { createLogger } from '../lib/logger';

const log = createLogger('status-bar-ball');

/** 球直径（与主进程 BALL_SIZE 一致） */
const BALL_SIZE = 40;
/** 拖动位移最大跟随量（px） */
const MAX_DRAG_FOLLOW = 6;
/** 点击阈值（px），位移小于此值视为点击 */
const CLICK_THRESHOLD = 3;
/** 持续滚动帧间隔（ms） */
const SCROLL_INTERVAL = 16;

type DragMode = 'none' | 'scroll' | 'move';

interface BallConfig {
  theme: 'light' | 'dark';
  sensitivityVertical: number;
  sensitivityHorizontal: number;
}

function StatusBarBallRoot() {
  const [config, setConfig] = useState<BallConfig>({
    theme: 'light',
    sensitivityVertical: 1,
    sensitivityHorizontal: 1,
  });
  const [pressed, setPressed] = useState(false);
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);
  // 摇杆向量：归一化后的拖动方向（限位后仍保留真实方向，持续滚动）
  const joystickRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    document.title = 'Urchin Status Ball';
    document.documentElement.dataset.window = 'statusbar';
    document.documentElement.setAttribute('data-theme', config.theme);
  }, [config.theme]);

  useEffect(() => {
    const off = window.urchin.on('ui.statusbar.ball.state', (payload) => {
      const p = payload as Partial<BallConfig>;
      setConfig((prev) => ({ ...prev, ...p }));
    });
    return off;
  }, []);

  const stopScroll = useCallback((): void => {
    if (scrollTimerRef.current) {
      clearInterval(scrollTimerRef.current);
      scrollTimerRef.current = null;
    }
    joystickRef.current = { x: 0, y: 0 };
    setOffset({ x: 0, y: 0 });
  }, []);

  /** 结束拖动并清理状态（幂等；按钮处理器与 window 层兜底共用，先到先得） */
  const finishDrag = useCallback(
    (e?: { screenX: number; screenY: number }): void => {
      const st = dragRef.current;
      if (!st) return;
      dragRef.current = null;
      setPressed(false);
      if (st.mode === 'move') {
        // 右键拖动：通知主进程停止光标轮询
        void window.urchin.invoke('ui.statusbar.ball.dragEnd', {}).catch((err) => {
          log.error('ball dragEnd failed:', err);
        });
        return;
      }
      if (
        !st.moved ||
        (e && Math.hypot(e.screenX - st.startX, e.screenY - st.startY) < CLICK_THRESHOLD)
      ) {
        // 左键单击：切换地址栏显示/隐藏
        void window.urchin.invoke('ui.statusbar.ball.click', {}).catch((err) => {
          log.error('ball click failed:', err);
        });
      }
      stopScroll();
    },
    [stopScroll],
  );

  // 兜底清理（同 use-window-drag 的教训）：右键拖动时窗口在光标下移动，capture
  // 可能静默丢失，pointerup 落在球窗口内但不在按钮上（或完全丢失）。window 层
  // 监听保证任何位置松手都结束拖动并上报 dragEnd；正常路径已清空 dragRef 时为 no-op。
  useEffect(() => {
    const onWindowPointerEnd = (e: PointerEvent): void => finishDrag(e);
    const onLostCapture = (): void => finishDrag();
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    window.addEventListener('lostpointercapture', onLostCapture);
    window.addEventListener('blur', onLostCapture);
    return () => {
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
      window.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('blur', onLostCapture);
    };
  }, [finishDrag]);

  const handlePointerDown = (e: React.PointerEvent): void => {
    setPressed(true);
    dragRef.current = {
      mode: e.button === 2 ? 'move' : 'scroll',
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 指针已被捕获（如上一轮状态未清），忽略，仍可拖动 */
    }
    if (e.button === 2) {
      // 右键拖动：主进程按「光标 − 球位置」记录抓取偏移并启动轮询，此后移动
      // 不经过渲染层（事件流不可靠），四向自由咬住光标；dragEnd 由松手兜底网
      // 统一上报，主进程恢复层级并结算与地址栏的重叠
      void window.urchin.invoke('ui.statusbar.ball.dragStart', {}).catch((err) => {
        log.error('ball dragStart failed:', err);
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent): void => {
    const st = dragRef.current;
    if (!st) return;
    if (st.mode === 'move') return; // 移动由主进程光标轮询驱动
    const dx = e.screenX - st.lastX;
    const dy = e.screenY - st.lastY;
    if (dx === 0 && dy === 0) return;
    st.moved = true;
    st.lastX = e.screenX;
    st.lastY = e.screenY;

    // 左键拖动：摇杆模式
    const totalDx = e.screenX - st.startX;
    const totalDy = e.screenY - st.startY;
    const len = Math.hypot(totalDx, totalDy) || 1;
    const scale = Math.min(MAX_DRAG_FOLLOW, len) / len;
    const clampedX = totalDx * scale;
    const clampedY = totalDy * scale;
    setOffset({ x: Math.round(clampedX), y: Math.round(clampedY) });
    // 摇杆向量：方向归一化 × 限位长度比例（限位后仍保留最大力度，持续滚动）
    const intensity = Math.min(1, len / MAX_DRAG_FOLLOW);
    joystickRef.current = {
      x: (totalDx / len) * intensity,
      y: (totalDy / len) * intensity,
    };
    // 启动持续滚动循环（摇杆模式：拖到限位后继续按住仍持续滚动直到松手）
    scrollTimerRef.current ??= setInterval(() => {
      const j = joystickRef.current;
      if (j.x === 0 && j.y === 0) return;
      const sx = j.x * config.sensitivityHorizontal * MAX_DRAG_FOLLOW;
      const sy = j.y * config.sensitivityVertical * MAX_DRAG_FOLLOW;
      void window.urchin.invoke('ui.statusbar.ball.scroll', { dx: sx, dy: sy }).catch((err) => {
        log.error('ball scroll failed:', err);
      });
    }, SCROLL_INTERVAL);
  };

  const handlePointerUp = (e: React.PointerEvent): void => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* 指针未捕获/已释放，忽略 */
    }
    finishDrag(e);
  };

  // 反方向残影：阴影偏移与拖动方向相反
  const shadowX = -offset.x;
  const shadowY = -offset.y;

  const ballStyle: React.CSSProperties = {
    width: BALL_SIZE,
    height: BALL_SIZE,
    borderRadius: '50%',
    padding: 0,
    border: '1px solid rgba(15,23,42,0.18)',
    background: 'var(--color-address-bar)',
    overflow: 'hidden',
    cursor: 'grab',
    transform: `translate(${offset.x}px, ${offset.y}px) scale(${pressed ? 0.92 : 1})`,
    transition: dragRef.current ? 'none' : 'transform 120ms ease-out',
    boxShadow: pressed
      ? `0 2px 6px rgba(15,23,42,0.35), rgba(15,23,42,0.45) ${shadowX * 1.5}px ${shadowY * 1.5}px 8px`
      : `0 4px 12px rgba(15,23,42,0.28), rgba(15,23,42,0.28) ${shadowX * 1.5}px ${shadowY * 1.5}px 8px`,
    touchAction: 'none',
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        aria-label="悬浮球"
        title="左键单击展开/隐藏地址栏，左键拖动滚动网页，右键拖动移动位置"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          // contextmenu 作为拖动结束的补充信号：capture 丢失时 pointerup 可能收不到
          finishDrag();
        }}
        style={ballStyle}
      >
        <img
          src="./ball-icon.png"
          alt=""
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          onError={(e) => {
            // 兜底链：ball-icon（玻璃球本体严格裁剪版，无光晕白边）→ app-icon（原版，
            // 含光晕）→ browser-icon。裁剪版由 build/icon.png 像素级测量裁出
            // （cx=255.5, cy=237, r=227.5 外接框），球本体铺满整个悬浮球。
            const img = e.currentTarget;
            if (img.dataset.fallback) return;
            img.dataset.fallback = '1';
            img.src = 'urchin://app-icon';
          }}
          style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
        />
      </button>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}
createRoot(rootEl).render(<StatusBarBallRoot />);
