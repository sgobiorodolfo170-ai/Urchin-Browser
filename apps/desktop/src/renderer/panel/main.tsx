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
import { FolderMenuApp } from './FolderMenuApp';
// folder-menu 模式复用主页同款组件（BookmarkListPanel 的 Tailwind 类与
// --color-* token），故先引入主入口全局样式；panel.css 在其后加载以保证
// 既有面板手写样式优先（同特异性后者胜）。
import '../styles/globals.css';
import './panel.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

/** folder-menu 模式：收藏栏文件夹菜单子窗口（与收藏夹面板同入口、不同模式）。 */
const isFolderMenu = new URLSearchParams(location.search).get('mode') === 'folder-menu';

createRoot(rootEl).render(
  <StrictMode>{isFolderMenu ? <FolderMenuApp /> : <BookmarkPanelApp />}</StrictMode>,
);
