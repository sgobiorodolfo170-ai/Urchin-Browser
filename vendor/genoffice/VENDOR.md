# vendor/genoffice — GenOffice 嵌入源（Urchin「打开文件」模块框架）

本目录是 [GenOffice](https://github.com/genspark-ai/genoffice) 的**源码镜像**，
用于把它的编辑器（Markdown / PDF / HTML / Docs，后续 Sheets / Slides）接入
Urchin Browser 的「打开文件」模块。集成方案与阶段划分见 `docs/` 与 CHANGELOG
v0.1.0-dev.90。

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
- 计划与执行记录见根 `CHANGELOG.md`（dev.90 起）与 Urchin 的 `docs/decisions/`。

## 本仓对上游的改动（vendor patch 清单）

> 目标：改动最小化，升级上游时逐条复核。

1. **新增 `apps/urchin-embed/`**（本仓自研，非上游）：宿主嵌入层。
   - `src/main/index.ts`：`GENOFFICE_SCHEME_PRIVILEGES`（特权 scheme 数据，
     由宿主并入自己的 `registerSchemesAsPrivileged` 单次调用，含 html 的
     html-preview/html-asset）、`initGenOfficeEmbed()`（四编辑器运行时装配 +
     docs 的 `registerDocsIpc` 一次性注册；`extraRendererRoots` 供宿主挂载
     shell Home 渲染产物）、`initGenOfficeAi()`（ai:*/project:* 与
     `genoffice:ai-catalogs`）、`createGenOfficeView()`、
     `createGenOfficeBlankView()`（Home「新建」）、`writeBlankPdfFile()`、
     `setGenOfficeLanguage()`、`genOfficeIsDirty()`（docs 走 close-check
     查询故为异步）、`requestGenOfficeClose()`。
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

## 安装与构建（Urchin 侧）

```bash
# 一条命令：确保 vendor 依赖（缺失时 npm ci）→ 构建 markdown → 构建嵌入包 → 校验产物
pnpm genoffice:build            # 默认 markdown；可传 app：pnpm genoffice:build pdf
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
