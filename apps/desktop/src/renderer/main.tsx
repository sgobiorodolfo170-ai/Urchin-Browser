/**
 * Urchin Browser · 渲染进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / 04-模块全景 M2* Tab UI 镜像
 * v0.1 W2-D1：挂载 React + ThemeProvider + 全局样式
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './theme/theme-provider';
import './styles/globals.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
