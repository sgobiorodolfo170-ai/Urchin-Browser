import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * apps/pi-web · 自研前端构建（阶段 2）。
 * base './'：产物由 pi-web-host 以任意 http://127.0.0.1:<port>/ 路径前缀托管，
 * 不能使用默认绝对 base（会指向站点根之外的路径）。
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
