import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { retainBuildAssets } from "./build-assets";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const buildId = process.env.PI_WEB_BUILD_ID ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);

function swBuildIdPlugin(id: string) {
  return {
    name: "sw-build-id",
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: "pi-web-build-id", content: id }, injectTo: "head" as const }];
    },
    closeBundle() {
      const swPath = join(__dirname, "dist", "sw.js");
      if (existsSync(swPath)) {
        const content = readFileSync(swPath, "utf-8");
        writeFileSync(swPath, content.replace(/__BUILD_ID__/g, id), "utf-8");
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), swBuildIdPlugin(buildId), retainBuildAssets(join(__dirname, "dist"))],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  resolve: {
    // 前端与后端共享的纯模块（protocol / 工具目录 / 设备中心常量等）统一从
    // pi-web-host 的并入源目录取，不再保留 apps/pi-web/server 快照。
    alias: {
      "@urchin/pi-web-host/shared": resolve(__dirname, "../../packages/pi-web-host/src/pi-server"),
      "@urchin/pi-web-host/browser": resolve(__dirname, "../../packages/pi-web-host/src/browser"),
    },
  },
  build: {
    outDir: join(__dirname, "dist"),
    emptyOutDir: false,
    target: "es2022",
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});