/**
 * Urchin Browser · 渲染进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / 04-模块全景 M2* Tab UI 镜像
 * v0.1 W2-D1：挂载 React + ThemeProvider + 全局样式
 *
 * 2026-10-23：底部状态栏改为独立透明子窗口悬浮于网页之上。该子窗口加载同一
 * index.html 并附加 ?view=statusbar 查询参数，此处按参数动态导入对应入口：
 * - 主窗口：动态导入 App（含完整功能模块，按需拆分 chunk）
 * - 状态栏子窗口：仅动态导入 StatusBarRoot（轻量 chunk，不加载 App/pi/AI 等，
 *   显著降低悬浮层渲染进程内存占用）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initRuntimeErrorLog } from './lib/runtime-error-log';
import './styles/globals.css';

// 启动即安装运行时错误采集（设置页「调试 → 运行报错日志」数据源）。
// 设置页是按需挂载的，只有在这里安装才能记录设置页打开前发生的错误。
initRuntimeErrorLog();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

const view = new URLSearchParams(location.search).get('view');
const isStatusBarView = view === 'statusbar';
const isBallView = view === 'statusbar-ball';

void (isStatusBarView
  ? import('./status-bar/status-bar-app').then(({ StatusBarRoot }) =>
      createRoot(rootEl).render(
        <StrictMode>
          <StatusBarRoot />
        </StrictMode>,
      ),
    )
  : isBallView
    ? import('./status-bar/status-bar-ball').then((mod) => {
        // status-bar-ball.tsx 自挂载（动态导入副作用）
        void mod;
      })
    : import('./App').then(({ App }) =>
        import('./theme/theme-provider').then(({ ThemeProvider }) =>
          createRoot(rootEl).render(
            <StrictMode>
              <ThemeProvider>
                <App />
              </ThemeProvider>
            </StrictMode>,
          ),
        ),
      ));
