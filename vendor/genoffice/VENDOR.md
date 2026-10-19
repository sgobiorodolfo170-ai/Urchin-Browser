# vendor/genoffice — GenOffice 嵌入源（Urchin「打开文件」模块框架）

本目录是 [GenOffice](https://github.com/genspark-ai/genoffice) 的**源码镜像**，
用于把它的编辑器（Markdown / PDF / HTML / Docs，后续 Sheets / Slides）接入
Urchin Browser 的「打开文件」模块。集成方案与阶段划分见 `docs/` 与 CHANGELOG
v0.1.0-dev.91 起（dev.90 为前置的 Electron 43 升级）。

## 来源与版本

| 项         | 值                                                                       |
| ---------- | ------------------------------------------------------------------------ |
| 上游仓库   | `https://github.com/genspark-ai/genoffice`                               |
| 固定 commit | `ad1b303431eb4d3571f0485d046141ca26e748da`（2026-09-20 取源）           |
| 许可证     | Apache-2.0（根 `LICENSE`）；`NOTICE` 与第三方声明随源保留                |
| 特殊许可   | `ee/` 目录为企业许可（当前无代码）；`packages/pptx-engine/src/vendor/mtx` 为 MPL-2.0；`packages/ui/src/fonts` 为 OFL-1.1 |

## 与本仓的关系

- Urchin 主进程**不**把 `@genoffice/*` 打进自己的构建：编辑器以独立页面
  （`genoffice-app://` 协议）与独立 preload 运行，宿主经运行时 `require` 加载
  嵌入包 `@genoffice/urchin-embed`（见下）。
- 计划与执行记录见根 `CHANGELOG.md`（dev.91 起）与 Urchin 的 `docs/decisions/`。

## 本仓对上游的改动（vendor patch 清单）

> 目标：改动最小化，升级上游时逐条复核。

1. **新增 `apps/urchin-embed/`**（本仓自研，非上游）：宿主嵌入层。
   - `src/main/index.ts`：`GENOFFICE_SCHEME_PRIVILEGES`（特权 scheme 数据，
     由宿主并入自己的 `registerSchemesAsPrivileged` 单次调用，含 html 的
     html-preview/html-asset）、`initGenOfficeEmbed()`（六编辑器运行时装配
     markdown/pdf/html/docs/slides/sheets + docs 的 `registerDocsIpc` 一次性注册；
     `extraRendererRoots` 供宿主挂载 shell Home 渲染产物）、`initGenOfficeAi()`
     （ai:*/project:* 与 `genoffice:ai-catalogs`）、`createGenOfficeView()`、
     `createGenOfficeBlankView()`（Home「新建」）、`writeBlankPdfFile()`、
     `setGenOfficeLanguage()`、`genOfficeIsDirty()`（docs 走 close-check
     查询、slides 走 sessions map 同步查询、sheets 走 pendingEditCount>0，
     均故为异步；md/pdf/html 同步）、`requestGenOfficeClose()`。
   - 构建：`npm run build -w @genoffice/urchin-embed` → `out/main/index.js`
     （CommonJS、自包含，仅 electron/node 内置外部依赖）。
   - `tsconfig.json` 含上游声明 shim（`packages/pdf2docx/src/bidi-js.d.ts`、
     `packages/html2docx/src/raw.d.ts`，同 apps/shell 约定）。
   - 已知 Windows 坑：传入的 renderer root 必须经 `path.resolve` 归一化，
     否则 `resolveRendererFile` 的前缀校验（`root + path.sep`）失败、全部
     资源 404（上游 shell 传 `path.join` 结果，故上游不涉及）。
   - 上游 shell Home 前端（`apps/shell` 渲染产物）由宿主以**自有 preload**
     承载：`window.aiOffice` 适配层（genoffice:home 通道）与 `window.aiOfficeTabs`
     最小桩在 Urchin preload 内实现；Home 自带 `.tab-bar` 由宿主注入 CSS 隐藏
     （浏览器侧栏即标签条）。
   - `registerProjectIpc` 设计：docs/sheets/slides 各自导出 `registerProjectIpc`，
     都注册同一 `project:resolveChat` 通道。上游 shell 只调用 docs 版本一次
     （三者共用 `<userData>/project-store`，等价；sheets/slides 版本仅供各自
     standalone 模式）。embed 沿用上游做法，`initGenOfficeAi` 只调 docs 版本，
     **不调用** sheets/slides 的 `registerProjectIpc`。若未来 sheets 或 slides 的
     session→path 反查需要其内部 map 而 docs 版本不足，优先
     **改该 app 通道名**（如 `sheets:project:resolveChat`）隔离，不动其他 app。
   - `includeAiHandlers=false`（sheets 关键修复）：`createSheetsView` 默认
     `includeAiHandlers: true` 会调 `registerSheetsAiIpc()`，注册 `ai:get-settings`
     等通道——但 `initGenOfficeAi` 已调 docs 的 `registerAiIpc()` 注册了全部
     `ai:*` 通道，二次注册抛 "second handler"。embed 对 sheets 一律传
     `includeAiHandlers: false`（AI 通道由 docs 的 registerAiIpc 统一注册，
     sheets/slides 共用；与上游 shell 行为一致）。`createGenOfficeBlankView`
     的 sheets 分支同款。
   - sheets sidecar 路径：`GenOfficeEmbedOptions.sheetsSidecarPath` 由宿主
     `resolveSheetsSidecarPath()` 解析后传入（开发态 vendor/.../target/release，
     打包态 resources/native/）。不传时 sheets-main 自行解析，但开发态
     `app.getAppPath()` 指 apps/desktop 而非 vendor，路径不对。
   - sheets sidecar 退出清理：上游 shell 在其 before-quit 钩子调用
     sheets-main 的 `stopSheetsSidecar()`（Windows 父进程退出不自动杀
     spawn 子进程，不显式停会遗留 `xlsx-sidecar.exe`）。embed 导出
     `stopGenOfficeSidecars()`（直接 re-export），宿主在自身退出清理
     （`performCleanup`）中调用。
2. **`package-lock.json`**：新增 `apps/urchin-embed` workspace 条目后经
   `npm install` 更新（`npm ci` 要求锁文件与 workspace 同步）。
   上游升级流程中，替换整树后需重新执行 `npm install` 再提交锁文件。
3. **`packages/html2docx/src/convert.ts`**（一行类型修复）：`pageBgShotIds`
   构造时对 `shotId` 加类型守卫（`.filter((id): id is string => ...)`）。
   原因：`docs-main` 导入该模块后，strict 工程（含上游 `apps/shell`）在
   TS 5.9 下报 TS2769（`(string|undefined)[]` 不可赋给 `Iterable<string>`）；
   修复后 `apps/urchin-embed` 与上游 shell 的 typecheck 均恢复绿色。
   逻辑不变，可直接回馈上游。
4. **移除 GenOffice 原生账号/登录体系**（Urchin 不接入原项目账号；用户指令）：

   涉及文件：
   - `apps/shell/src/renderer/src/Home.tsx`：删除 `AccountEntry` 组件（登录状态/
     等待/登出/authUrl/技能更新红点）、`CloudProjectsView` 组件 + `cloudMode`
     状态 + 侧栏「云项目」导航项；新增 `SettingsEntry`（纯设置按钮，开设置弹窗，
     仅保留技能更新红点探测）；greeting 去账号昵称。
   - `apps/shell/src/renderer/src/SettingsModal.tsx`：删除 account 面板（未登录/
     邮箱/积分/登录/登出按钮）与相关 props（status/loggingOut/loginWaiting/
     loginUrl/urlCopied/onOpenLoginUrl/onCopyLoginUrl/onLogin/onLogout）；
     默认区段改为 `general`；同时移除 `aiModel`/`aiMedia` 区段（其
     `getAiProviders()` 假定同步返回数组，与 Urchin preload 的 Promise 形状
     冲突会崩；AI 设置由 Urchin 自身设置页 `GenOfficeAiSettings.tsx` 承载，
     不再重复）。
   - `apps/shell/src/shared/home-api.ts`：删除 `AccountStatus`/
     `AccountLoginEvent`/`CloudProjectsSnapshot`/`CloudProjectEntry`/
     `CloudProjectKind` 类型，以及 HomeApi 接口中的 account/cloud/credit
     方法签名与通道映射表条目。
   - `apps/docs/src/renderer/ai/AiPanel.tsx`：中和出错时的内嵌「登录」按钮
     （`loginRequired` setter + render），避免 BYOK 用户看到无效登录入口；
     `gskLoggedInRef` 图片生成门禁保留（恒 false，Genspark 图片生成本就不可用）。
   - `apps/markdown` 仅 `gskLoggedInRef` 门禁（同上保留），无 `loginRequired`。

   宿主侧对应删除（`apps/desktop`，非 vendor）：home-handlers 的
   `accountStatus`/`accountLogin`/`openLoginUrl`/`accountLogout`/
   `cloudProjectsCached`/`cloudProjectsSync`/`openCloudProject`/`openGenTeam`/
   `openCreditUsage` 九个 handler，以及 preload `window.aiOffice` 桥同名方法。

   功能影响：BYOK AI、文件打开/最近/文件夹/新建、主题/语言/MCP/分析开关均
   不受影响；Genspark 云 AI/云项目/云端积分/Genspark 图片生成本就不可用，
   移除后更明确。`ai:gsk-status` 通道由 vendor docs-main 提供（恒
   `{loggedIn:false}`），宿主未实现登录流，行为不变。
5. **shell SettingsModal 的 AI 面板异步 catalog 适配**（用户指令：BYOK 配置
   移回文档首页设置弹窗）：上游 `AiModelPane`/`AiMediaPane` 假定
   `getAiProviders()/getAiMediaProviders()/getAiSearchProviders()` **同步**
   返回数组（`useState(() => window.aiOffice.getAiProviders?.() ?? [])`），
   而 Urchin 宿主 preload 走 `ipcRenderer.invoke` 返回 **Promise**——catalog
   实际被存为 Promise，随后 `catalog.find()` 崩溃（`TypeError: catalog.find
   is not a function`）。适配：改为 `useState([])` + `Promise.all` 一次性加载
   catalog 与 settings（AiModelPane 先取 catalog 再取 settings，codex 模型
   刷新才能落到完整 catalog）；并对 `getAiSettings` 补 `.catch` 防未处理拒绝。
   逻辑/UI 不变，纯加载时序修正。设置弹窗默认区段改为 `aiModel`（与原「账号」
   首屏等价的信息架构）。
6. **`apps/urchin-embed/src/main/env.d.ts`**（slides 接入伴随的 type shim）：
   slides 的 `fonts.ts`/`shaped-metrics.ts` 用了 electron-vite 的 `?asset`
   后缀导入（字体/wasm 文件路径）与 harfbuzzjs 深路径 factory，纯 `tsc --noEmit`
   不识别。本仓在 embed 下新建 `src/main/env.d.ts`，仅声明 `*?asset` 与
   `*/harfbuzzjs/dist/harfbuzz.js` 两个模块（**不含** `bidi-js`——让
   `packages/pdf2docx/src/bidi-js.d.ts` 的完整声明生效，避免与 slides 自带
   `env.d.ts` 的简化版 bidi-js 冲突）。embed tsconfig 的 include 改指向此
   本地文件（而非 `../slides/src/main/env.d.ts` 整文件）。

## 安装与构建（Urchin 侧）

```bash
# 一条命令：确保 vendor 依赖（缺失时 npm ci）→ 构建各 app → 构建嵌入包 → 校验产物
pnpm genoffice:build            # 默认全部（markdown/pdf/html/docs/slides/shell）；可传 app：pnpm genoffice:build slides
```

产物路径（开发态，Urchin 主进程直接读；打包态由 electron-builder
`extraResources` 复制到 `resources/genoffice/`）：

```
vendor/genoffice/apps/urchin-embed/out/main/index.js          # 宿主唯一运行时入口
vendor/genoffice/apps/<app>/out/renderer/                     # 编辑器页面
vendor/genoffice/apps/<app>/out/preload/index.js              # 编辑器 preload
```

- `node_modules/`、各 app 的 `out/` 均不入库（根 `.gitignore` 已覆盖）。
- 首次安装需联网；本机/国内网络建议镜像（脚本已默认注入
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

## 升级上游流程（建议）

1. 在上游 checkout 拉取目标 commit，记录新 SHA 与 release notes；
2. 用新树整体替换本目录（保留 `apps/urchin-embed/` 与 `package-lock.json`
   的 workspace 条目——对比 `git status` 逐条恢复本清单改动）；
3. `npm install` 更新锁文件 → `pnpm genoffice:build` → Urchin 全量验证
   （typecheck/lint/单测/e2e + 手工打开各格式）；
4. 更新 CHANGELOG 与 `docs/pi-web-评估` 类似的上游变更审计留痕。
