import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

/**
 * apps/pi-web · 自研前端构建（阶段 2，全量继承 pi-web-ui 组件）。
 * base './'：产物由 pi-web-host 以任意 http://127.0.0.1:<port>/ 路径前缀托管。
 */
export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14)),
  },
  resolve: {
    alias: {
      '../server': resolve(__dirname, 'server'),
      '../../server': resolve(__dirname, 'server'),
      '../../../server': resolve(__dirname, 'server'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      external: [
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/xterm/css/xterm.css',
        '@pi-web-ui/plugin-sdk/client',
        'html-to-image',
        'mermaid',
        'vis-timeline',
      ],
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
