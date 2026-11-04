/**
 * 收藏夹悬浮面板 · 渲染进程入口（独立 vite 入口 panel.html）
 *
 * P2 Session 4（2026-11-05）：自 bookmark-panel.ts 的 ~700 行内联 JS 字符串迁移为
 * React 组件。子窗口由主进程 BookmarkPanel 加载本入口：
 * - dev：vite dev server /panel.html；
 * - prod：loadFile dist/renderer/panel.html（?mode=picker 进入选择文件夹保存模式）。
 *
 * window.urchin 由子窗口复用的主窗口 preload 注入（file:/urchin: 协议下均暴露）。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarkPanelApp } from './BookmarkPanelApp';
import './panel.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <BookmarkPanelApp />
  </StrictMode>,
);
