import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('pi-web: #root 不存在');
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
