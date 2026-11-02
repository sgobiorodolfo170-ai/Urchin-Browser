# vendor/genoffice — GenOffice 嵌入源（Urchin「打开文件」模块框架）

本目录是 [GenOffice](https://github.com/genspark-ai/genoffice) 的**源码镜像**，
用于把它的编辑器（Markdown / PDF / HTML / Docs，后续 Sheets / Slides）接入
Urchin Browser 的「打开文件」模块。集成方案与阶段划分见 `docs/` 与 CHANGELOG
v0.1.0-dev.91 起（dev.90 为前置的 Electron 43 升级）。

## 来源与版本

| 项         | 值                                                                       |
| ---------- | ------------------------------------------------------------------------ |
| 上游仓库   | `https://github.com/genspark-ai/genoffice`                               |
| 固定版本   | `v0.12.446`（commit `36a509e8fc16ace85ed7afa3c37acb7b9c441ad1`，2026-10-30；2026-11-02 取源） |
| 上一基线   | `ad1b303`（2026-09-20 取源，对应 `@genoffice/shell@0.10.0` / Electron 43.3.0；该 commit 已被上游 snapshot-sync 历史重写抹除，不可复现，故本次起改为按 tag 锁定） |
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
     html-preview/html-asset、以及 v0.12 新增的 `genoffice-slide-media`）、`initGenOfficeEmbed()`（六编辑器运行时装配
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
   逻辑不变，可直接回馈上游。（v0.12.446 升级复核：上游 HEAD 仍未修，补丁继续保留。）
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
   不识别。本仓在 embed 下新增 `src/main/env.d.ts`，仅声明 `*?asset` 与
   `*/harfbuzzjs/dist/harfbuzz.js` 两个模块（**不含** `bidi-js`——让
   `packages/pdf2docx/src/bidi-js.d.ts` 的完整声明生效，避免与 slides 自带
   `env.d.ts` 的简化版 bidi-js 冲突）。embed tsconfig 的 include 改指向此
   本地文件（而非 `../slides/src/main/env.d.ts` 整文件）。
7. **`apps/shell/src/renderer/src/Home.tsx`**（卡片顺序）：`renderQuickCards()`
   中「打开本地文件」卡片置于 `{NEW_ITEMS.map(...)}` **之前**（最左），而非
   上游默认的最右。升级时需复核此顺序。
8. **默认保存目录对齐**（宿主侧，非 vendor 补丁）：`apps/desktop/src/main/index.ts`
   启动时将 `<userData>/app-settings.json` 的 `defaultSaveDir` 键写入
   `<数据目录>/documents`（仅在未设置时写入，不覆盖用户自定义）。`home-handlers.ts`
   的 `defaultSaveDir()` 读 app-settings.json（与编辑器的 `configuredDefaultSaveDir(app)`
   同源），`pickDefaultSaveDir` 弹目录选择器并写回 app-settings.json（允许用户自定义）。
   此改动在宿主代码（`apps/desktop`），不受 vendor 升级影响。
9. **CL11 剪藏图片本地化 · asset-lifecycle re-export + deleteFiles GC**
   （宿主剪藏功能复用 GenOffice owned-asset 生命周期；详见
   `docs/decisions/ADR-014-网页剪藏模块.md` CL11）：

   - **`apps/urchin-embed/src/main/index.ts`**：末尾 re-export 三个 asset-lifecycle
     函数（`writeImageIntoOwnedAssets` / `reconcileOwnedAssets` /
     `extractMarkdownImageSources`，from `../../../markdown/src/main/asset-lifecycle`）。
     这三个函数已被 markdown-main import（存在于 bundle 依赖树中），re-export 不增加
     bundle 体积。宿主剪藏通过 `loadGenOfficeEmbed()` 返回的 API 调用它们，把远程图片
     下载后写入 `assets/` 并注册 `.genoffice-assets.json` 清单。
   - **`apps/shell/src/main/index.ts`**：`deleteFiles` handler（`home:delete-files`）
     在 `shell.trashItem(p)` 后，对 `.md/.markdown` 文件调
     `reconcileOwnedAssets(p, [])`。传空 imageSources 会从 manifest 删除该文档的
     docKey，`siblingMarkdownReferences` 扫描同目录存活 md 算引用集，GC 自动清理
     不再被任何 md 引用的 owned 图片（共享图片保留）。非 .md 文件无 assets 不触发。
     import 路径：`from '../../../markdown/src/main/asset-lifecycle'`（markdown-main
     import 但未 re-export，故 shell 直接 import 源模块）。
   - **⚠ Urchin 实际走 `apps/desktop/src/main/genoffice/home-handlers.ts` 的
     `deleteFiles` case**（不是 vendor shell 的 `index.ts`）：Urchin 不加载 shell
     主进程代码，Home 页的 `home:delete-files` IPC 由宿主 `home-handlers.ts` 处理。
     **vendor shell 的 deleteFiles GC 改动保留**（上游 genoffice 自己的 shell 受益），
     **但 Urchin 的 GC 在 `home-handlers.ts:deleteFiles` case 中实现**（通过
     `deps.embedApi?.reconcileOwnedAssets(p, [])` 调用）。两处改动逻辑一致，升级时
     均须保留。

   **⚠ vendor 升级时必须逐条恢复此补丁**（升级流程第 2 步「对比 git status 逐条恢复
   本清单改动」）。漏恢复会导致：①宿主剪藏图片本地化功能失效（embedApi 缺方法，
   保留原远程 URL 行为，不崩但功能退化）；②删除 md 时 assets 图片不被清理（磁盘
   孤儿，不崩但不清理）。**改 vendor 源码后必须跑 `node scripts/genoffice-build.mjs
   shell`** 重建 urchin-embed 产物，否则运行时加载旧产物没有新 API。

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

## v0.12.446 升级状态（2026-11-02，Phase A）

本次从 `ad1b303`（2026-09-20，shell 0.10.0 / Electron 43.3.0）升级到
`v0.12.446`（2026-10-30，shell 0.12.0 / Electron 43.8.3）。上游采用
"Sync snapshot" 周期性 squash 发布，旧 commit `ad1b303` 已被历史重写抹除
（GitHub 返回 422），故本次起改为按 **tag** 锁定，并记录取源日期。

### 已落地的改动

- **scheme-privileges**：`genoffice-slide-media` 加入 `GENOFFICE_SCHEME_PRIVILEGES`
  （上游 v0.11+ 新增；不加则 slides 的归档图片从 secure 页加载失败）。
  `scheme-privileges.json` 现含 5 个 scheme。
- **html2docx 类型守卫**：补丁 #3 重新落地（上游仍未修）。
- **SettingsModal AI catalog 异步适配**（补丁 #5）：上游 v0.12 的
  `AiModelPane`/`AiMediaPane` 仍用 `useState(() => window.aiOffice.getAiProviders?.())`
  假定同步数组；Urchin preload 返回 Promise。已改为 `useState([])` + `Promise.all`
  在 effect 内加载 catalog + settings。
- **账号/云项目方法桩**（补丁 #4 的 Phase A 替代）：v0.12 的 Home `AccountEntry`
  在 mount 时调用 `accountStatus?.().then(...)` 等；若 preload 缺该方法则
  `.then` 崩溃。Phase A 未做 Home.tsx 的 AccountEntry 删除（上游 Home 改动大，
  三方合并风险高），改为在宿主 preload（`apps/desktop/src/preload/index.ts`）
  桩化 account/cloud/folder-root 方法（返回已登出/空的 Promise），Home 可正常
  渲染、`.account-entry` 入口可见（显示"登录"但不可用）。

### 已知遗留（Phase B）

- **HomeApi 缺项方法**：宿主 preload 仅实现约 50/120 个 HomeApi 方法。v0.12 新增的
  恢复上次会话/自动更新检查/默认应用/skills/附件/kb* 等方法以桩或 `?.` 静默跳过。
  Phase B 按优先级逐步接入或明确隐藏对应 UI。
- **Electron 版本**：vendor node_modules 仍 43.3.0（满足 embed 的 `^43.3.0`）；
  宿主用 43.7.3。上游 shell 要求 43.8.3，但 embed 构建不依赖 vendor 的 electron
  二进制，运行时由宿主提供，暂不影响。Phase B 可对齐到 43.8.x。

### Phase B 已落地（2026-11-02）

- **AccountEntry → 设置入口**：Home.tsx 的 AccountEntry 按钮文案/图标/tooltip 从
  "登录 Genspark"改为"设置"+齿轮图标（保留 className="account-entry" 复用上游
  CSS）。按钮行为不变（打开 SettingsModal）。登录 hint 块因 stub（waiting=false）
  不显示。SettingsModal 默认区段从 `'account'` 改为 `'aiModel'`，并从 SECTIONS 导航
  移除 `'account'`（打开设置即 AI 模型面板，不再显示账号登录面板）。
- **genoffice e2e 9/9 全绿**：BYOK 测试此前因默认区段为 `'account'`（测试在账号面板
  找不到 `.gs-dd-btn`）失败；改为 `'aiModel'` 后通过。
- **HomeApi 全补齐（零缺项）**：宿主 preload 现覆盖 Home 所有 `window.aiOffice.*`
  调用（120+ 方法）。文件搜索 `searchFiles` 实现基础文件名递归搜索；`unstarPaths`
  实现批量取消星标；设置面板 14 个 `?.` 方法返回合理默认值（restoreLastSession/
  autoUpdateCheck/tabSleep/authorName/documentTheme/defaultApp/updateState 等）；
  订阅类 `onAiSettingsChanged`/`onOpenSettings`/`onDocumentThemeChanged`/
  `onUpdateStateChanged` 返回空 unsubscribe；账号/云/folder-root 方法返回已登出/空桩。
- **Electron 对齐**：声明从 `^43.7.3`/`^43.3.0` 改为 `^43.8.0`（已安装 43.8.0，
  上游 43.8.3 仅差 patch）。
- **verify 全绿**（1345 测试，覆盖率达标）。
