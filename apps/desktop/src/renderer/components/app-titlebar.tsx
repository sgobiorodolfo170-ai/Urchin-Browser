/**
 * Windows 自绘标题栏（frameless 窗口）。
 *
 * 背景：原生标题栏由 OS 绘制，CSS 无法把 8px 外框包到标题栏之外；
 * 因此 Windows 下改为 frame:false + 本组件自绘标题栏，窗口控制经 IPC
 * 委托主进程（register-handlers.ts）。
 *
 * 设计要点：
 * - 整条标题栏使用 -webkit-app-region: drag，保留系统拖动 / Aero Snap /
 *   双击最大化；按钮显式 no-drag，避免点击被拖拽区域吞掉。
 * - 最大化状态在挂载与 resize 时经 window.getState 同步：双击标题栏最大化
 *   不经过本组件按钮，必须监听窗口尺寸变化才能更新「最大化/还原」图标。
 * - 关闭复用既有 window.close（按 sender 反查窗口 id），不新增关闭通道。
 */
import { useCallback, useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { getCurrentWindowId } from '../lib/current-window';

/** 自绘标题栏：品牌区 + 最小化/最大化/关闭按钮。 */
export function AppTitleBar() {
  const [maximized, setMaximized] = useState(false);

  // 挂载时同步一次；之后窗口每次 resize（最大化/还原/手动缩放）再同步。
  useEffect(() => {
    let disposed = false;
    const syncMaximized = (): void => {
      void window.urchin
        .invoke('window.getState', {})
        .then((res) => {
          // 测试环境 mock 可能返回非窗口状态对象；只在布尔值时采用。
          const next = (res as { maximized?: unknown }).maximized;
          if (!disposed && typeof next === 'boolean') {
            setMaximized(next);
          }
        })
        .catch(() => {
          /* 窗口正在销毁/测试环境：保持当前图标 */
        });
    };
    syncMaximized();
    window.addEventListener('resize', syncMaximized);
    return () => {
      disposed = true;
      window.removeEventListener('resize', syncMaximized);
    };
  }, []);

  const handleMinimize = useCallback(() => {
    void window.urchin.invoke('window.minimize', {}).catch(() => {
      /* 窗口正在销毁：忽略 */
    });
  }, []);

  const handleToggleMaximize = useCallback(() => {
    void window.urchin
      .invoke('window.toggleMaximize', {})
      .then((res) => {
        const next = (res as { maximized?: unknown }).maximized;
        if (typeof next === 'boolean') setMaximized(next);
      })
      .catch(() => {
        /* 窗口正在销毁：忽略 */
      });
  }, []);

  const handleClose = useCallback(() => {
    void (async () => {
      try {
        const windowId = await getCurrentWindowId();
        await window.urchin.invoke('window.close', { windowId });
      } catch {
        /* 窗口正在关闭/测试环境：忽略 */
      }
    })();
  }, []);

  return (
    <header className="app-titlebar flex shrink-0 items-center justify-between">
      <div className="flex min-w-0 items-center gap-2 px-3">
        <img
          src="./browser-icon.png"
          alt=""
          draggable={false}
          className="h-4 w-4 shrink-0 object-contain"
        />
        <span className="truncate text-[11px] font-medium tracking-wide text-text-secondary">
          Urchin Browser
        </span>
      </div>

      <div className="flex h-full shrink-0 items-stretch">
        <button
          type="button"
          className="app-window-control"
          onClick={handleMinimize}
          aria-label="最小化窗口"
          title="最小化"
        >
          <Minus className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="app-window-control"
          onClick={handleToggleMaximize}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          title={maximized ? '还原' : '最大化'}
        >
          {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          className="app-window-control app-window-control-close"
          onClick={handleClose}
          aria-label="关闭窗口"
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
