/**
 * Urchin Browser · 渲染进程入口
 *
 * 依据：02-架构设计 §1 进程模型 / 04-模块全景 M2* Tab UI 镜像
 * v0.1 W1-D1 最小骨架：挂载 React + 验证 IPC 链路
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
