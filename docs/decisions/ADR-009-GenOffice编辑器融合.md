# ADR-009 · 「打开文件」模块融合 GenOffice 编辑器框架

> 状态：Accepted  · 决策日：2026-09-20  · 关联：GF1 / GF2 / GF3 / GF4 / GF5
> GF4 更新（2026-09-24）：Tiptap 2 文本编辑器已退役（dev.103）；GenOffice 四编辑器稳定运行后，保底 Markdown 编辑器不再保留，file-viewer 的 .md 编辑改用 PlainTextEditor（纯文本），.md 富文本编辑由 GenOffice markdown 独占。
> 影响范围：本地文件查看/编辑模块、Electron 主版本、AI 模块边界、打包体积与许可合规

## 决策

1. **GF1**：「打开文件」模块的文档编辑器**以 GenOffice 为框架**——vendor 整棵源码（固定 commit）并以 `WebContentsView` 形态嵌入 Urchin 标签体系；重复能力（Markdown 富文本、PDF 查看、HTML 打开）以 GenOffice 实现为准，Urchin 原查看器仅作保底。
2. **GF2**：Electron 从 32.3.3 **升级到 43.x** 以对齐 GenOffice 声明的 `^43.3.0`（BrowserView 保留；GenOffice 视图用 WebContentsView 混挂）。
3. **GF3**：文档编辑器内置 AI **完整使用 GenOffice 原生 AI 栈**（`ai:*` / `project:*`，密钥存 `<userData>/ai-settings.json`），与 Urchin 的 pi 模块**完全隔离、互不读写**；首期仅 BYOK（自备密钥），不接 Genspark 登录。
4. **GF4**：~~保底策略~~ **已退役（dev.103, 2026-09-24）**——Urchin 内置 Tiptap 2 Markdown 编辑器（`files/editor/MarkdownEditor.tsx`）及 `@tiptap/*` / `tiptap-markdown` 依赖已移除；file-viewer 的 .md 编辑改用 PlainTextEditor（纯文本），富文本编辑由 GenOffice markdown 独占。内置查看器（图片/音视频/JSON/纯文本只读）保留。
5. **GF5**：左侧栏文档入口**直接使用上游 shell Home 前端**（`apps/shell` 渲染产物），宿主以自有 preload 提供 `window.aiOffice` 适配层（可用子集 + 中性桩），不引入上游 shell 主进程（菜单/更新/MCP/账号等壳能力不在 Urchin 范围）。

## 背景

Urchin「打开文件」模块原本自研查看器（React + marked/iframe/媒体元素）与 Markdown 编辑器（Tiptap 2），
覆盖面有限：docx/xlsx/pptx 不可打开，PDF 只读，HTML 直开无法编辑。
GenOffice 是 Apache-2.0 的 AI Office 套件（Electron 43 + React 19），其六编辑器（Docs/Sheets/Slides/PDF/Markdown/HTML）
以独立 Vite 页面 + preload + 主进程模块的形式运行，官方 shell 通过 `WebContentsView` 承载——这一形态天然适合被外部 Electron 宿主复用。
用户决策：**以 GenOffice 为「打开文件」模块的主要框架**，能复用的一律复用，重复项以 GenOffice 为主。

## 候选方案

| 方案 | 说明 | 工程量 | 风险 |
|---|---|---|---|
| A. 视图级嵌入（选定） | vendor 源码；宿主 `require` 嵌入包（自包含 CJS）；`WebContentsView` 挂进 Urchin 标签 | 中 | BrowserView/WebContentsView 混挂、Electron 版本、打包体积 |
| B. 引擎包 + 自建 UI | 只复用 docx/pptx/pdf 引擎，UI 全部自研 | 大 | 编辑器 UI 数千行自研，长期维护成本高 |
| C. 独立进程/窗口 | 打包 GenOffice 可执行文件，用 CLI/协议联动 | 小 | 不满足「融合进标签页」；窗口/焦点/主题分裂 |
| D. 运行时 npm 依赖 | 把 `@genoffice/*` 当依赖安装 | 不可行 | 全部 private + 裸 TS 源码，未发布 npm |

## 决策理由（方案 A）

1. **官方嵌入缝现成**：每个编辑器导出 `configure*Runtime` / `create*View` / `*IsDirty` / `request*Close`，
   宿主只做装配；文件读写白名单、脏状态、保存/另存为、关闭守卫全部由 GenOffice 自己维护。
2. **依赖树隔离**：嵌入包由 GenOffice 自己的 electron-vite 构建为自包含 CJS（仅 electron/node 内置外部依赖），
   Urchin 不 import 任何 `@genoffice/*`——React 18/19、Tiptap 2/3、Vite 5/7 并存而不冲突。
3. **升级路径清晰**：vendor 固定 commit + `VENDOR.md` 改动清单 + `pnpm genoffice:build` 一条命令重建；
   上游升级 = 替换整树 + 重放补丁 + 全量验证。
4. **与既有架构一致**：Urchin 已有 `vendor/pi` 源码内置先例；标签模型扩展 `viewKind` 后，
   编辑器视图与网页 BrowserView 互斥挂载，bounds/布局/事件推送沿用 `view-integration`。

## 否决方案理由

- **B（引擎 + 自建 UI）**：用户明确要求「前端使用 GenOffice 项目里的前端」；自研 UI 无法在合理工期内达到其成熟度。
- **C（独立进程）**：编辑器不在 Urchin 标签体系内，主题/语言/关闭守卫/拖拽排序全部断裂，与「融合」目标相悖。
- **D（npm 依赖）**：`@genoffice/*` 全部 `private: true` 且导出裸 TS，不存在可消费的发布物。

## 后果

### 正面

- 「打开文件」一次性获得 docx/xlsx/pptx（分期）/PDF 编辑/Markdown 块编辑/HTML 编辑 + 原生 AI 面板。
- Urchin 与 GenOffice 解耦清晰：宿主只依赖嵌入包 API（`GENOFFICE_SCHEME_PRIVILEGES` / `initGenOfficeEmbed` /
  `initGenOfficeAi` / `createGenOfficeView` / `genOfficeIsDirty` / `requestGenOfficeClose`）。
- 关闭守卫、脏点、主题跟随、BYOK 设置均有确定性验收（单测 + E2E）。

### 负面

- **安装包显著增大**：dev.94 打包 266.2MB（Electron 43 本体 + GenOffice 四编辑器产物 + pdfium/hb-subset wasm）。
- **Electron 升级连带成本**：原生模块（better-sqlite3 N-API 预编译）、electron-builder 26、Playwright 1.63、
  pi 注入脚本的 Chromium 兼容修复（见 dev.90）。
- **vendor 维护义务**：上游升级需重放补丁；许可合规需随包分发 LICENSE/NOTICE/THIRD-PARTY-NOTICES。
- **Sheets/Slides 未接入**：xlsx/pptx 仍走保底（查看器提示外部打开），二期评估 Rust sidecar 与体积代价。

## 后续受影响决策

- T1 Electron 主版本：32.3.3 → 43.7.3（GF2 执行记录见 CHANGELOG dev.90）
- T7 文件查看器富文本编辑器：Urchin 自研 Tiptap 2 编辑器在融合路径稳定后退役（GF4 触发）
- 打包配置：`electron-builder.yml` extraResources 增补 `resources/genoffice/**` 与 `resources/wasm/**`
- AI 边界：pi（Urchin 原生）与 GenOffice AI 并存、配置隔离（GF3）

## 参考

- `vendor/genoffice/VENDOR.md`（来源 commit / 改动清单 / 升级流程）
- CHANGELOG v0.1.0-dev.90 ~ dev.94（阶段 0-4 执行留痕）
- GenOffice 上游：`apps/shell/src/main/index.ts`（嵌入缝调用示例）、`packages/electron-utils`（渲染协议）
