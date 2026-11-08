import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 单测目录只覆盖纯模块（无 DOM、无 electron / node-pty / ssh2 依赖）。
// 与 vite.config.ts 保持同一别名口径：前端与宿主共享的纯模块统一从 pi-web-host 的
// 并入源目录取，避免出现 apps/pi-web/server 第二份快照。
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@urchin/pi-web-host/shared": resolve(root, "../../packages/pi-web-host/src/pi-server"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});