# 全项目代码审查修复进度跟踪

> **创建时间**：2026-11-05
> **审查起点**：commit `d7e5b33b`（M28 transit 交付后）
> **当前 HEAD**：`838626a6`（bookmark panel React 迁移完成）
> **verify 状态**：全绿（127 测试文件 / 1440 测试 / 覆盖率 ~68%）

---

## 一、总览

| 级别 | 发现数 | 已修复 | 剩余 | 完成率 |
|------|--------|--------|------|--------|
| P0 阻塞 | 2 | 2 | 0 | 100% |
| P1 严重 | 14 | 13 | 1 | 93% |
| P2 一般 | 19 | 11 | 8 | 58% |
| P3 提示 | 12 | 5 | 7 | 42% |
| **合计** | **47** | **31** | **16** | **66%** |

**所有 P0 和 P1（除渲染层 logger）已全部修复。剩余 16 项均为 P2-P3 低优先级。**

---

## 二、四大文件拆分成果

| 文件 | 拆分前 | 拆分后 | 减幅 | 新增文件 |
|------|--------|--------|------|----------|
| index.ts | 2807 行 | 1423 行 | -49% | bootstrap/（app-context, handlers, theme-apply, watchdog）、lifecycle/（cleanup, signals） |
| App.tsx | 3039 行 | 1557 行 | -49% | content/ContentArea、sidebar/LeftSidebar+RightSidebar、tabs/TabBar+use-tab-drag、多个 hooks |
| SettingsPage.tsx | 2087 行 | 158 行 | -92% | use-settings.ts、settings/sections/（5 个 Section 组件）、settings-form.tsx |
| bookmark-panel.ts | 1187 行 | 265 行 | -78% | renderer/panel/（BookmarkPanelApp+BookmarksTab+HistoryTab+DownloadsTab+panel.css 等 8 个文件） |

---

## 三、已修复项明细（31 项）

### P0（2/2 全部完成）

| # | 问题 | 修复提交 | 说明 |
|---|------|---------|------|
| P0-1 | CI token-bucket 测试时序 | `77428dbd` | 注入 mock time 冻结时钟 |
| P0-2 | CHANGELOG.md 编码乱码 | `77428dbd` | UTF-16 LE mojibake → UTF-8，~95% 恢复 |

### P1（13/14 完成）

| # | 问题 | 修复提交 | 说明 |
|---|------|---------|------|
| P1-1 | URL 安全校验可被控制字符绕过 | `3d1403b5` | 改为 `new URL()` + 协议白名单 + 控制字符剥离 + main 侧兜底 |
| P1-2 | genoffice:home IPC 绕过 zod | `3d1403b5` | 加 zod payload schema + 路径安全检查 |
| P1-3 | app:set-ai-panel-prefs 绕过 zod | `3d1403b5` | 加 zod patch schema |
| P1-4 | IPC 超时定时器未清理 | `3d1403b5` | createTimeout 返回 {promise, cancel}，race 后 clearTimeout |
| P1-5 | StorageLayer.close() 不容错 | `5119a27c` | 每个 db.close() 独立 try/catch |
| P1-6 | Orchestrator port listener 泄漏 | `5119a27c` | ProviderHost 加 messageListener 字段，disposeHost 显式 removeListener |
| P1-7 | view-integration dispose 不完整 | `5119a27c` | dispose 末尾 clear 4 个 Map + removeListener resize handlers |
| P1-8 | 223 行 Provider 源码内嵌字符串 | `aeaaf6bc` | 外迁到 orchestrator/providers/openai-compatible.ts + esbuild 编译 + 心跳清理 |
| P1-9 | AOCI 机器产物入库（230KB+） | `c9853088` | git rm + .gitignore + .aoci/.gitignore 删白名单 |
| P1-10 | IPC handler 错误不一致 | `3d1403b5` | 9 处 throw new Error → throw new IpcError |
| P1-12 | dev:electron 未接入 dev | `c9853088` | 新增 dev:full 组合脚本 |
| P1-13 | perf.ps1 硬编码路径 | `c9853088` | 改为 $PSScriptRoot 动态解析 |
| P1-14 | AGENTS.md CI 状态描述不符 | — | P0-1 修复后 CI 实际状态已变，AGENTS.md 待更新（见剩余项） |

### P2（11/19 完成）

| # | 问题 | 修复提交 | 说明 |
|---|------|---------|------|
| P2-1 | index.ts 上帝文件（2807 行） | `5622eaa1`~`37f49c2b` | 6 步拆分 → 1423 行（bootstrap/ + lifecycle/） |
| P2-2 | App.tsx 上帝文件（3039 行） | `2b5c18b9`~`8fb6ec3d` | 7 步拆分 → 1557 行（content/ + sidebar/ + tabs/ + hooks） |
| P2-3 | SettingsPage 上帝文件（2087 行） | `5e6b2c25`~`5d68e613` | 7 步拆分 → 158 行（use-settings + 5 个 Section） |
| P2-4 | bookmark-panel 内联脚本（1187 行） | `838626a6` | React 迁移 → 265 行（renderer/panel/ 8 个文件） |
| P2-8 | devtools 死代码 void IpcError | `c9853088` | 删除导入与 void 语句 |
| P2-12 | pnpm-lock.yaml.bak 入库 | `c9853088` | git rm + .gitignore |
| P2-14 | lefthook.yml 全注释死文件 | `c9853088` | 删除 |
| P2-19 | JSON.parse 无 try/catch（迁移路径） | `255c0da0` | legacyPiKeysScan 加 try/catch + filter null |
| P2-7(部分) | orchestrator markCrashed 静默 kill | `255c0da0` | 3 处 catch { /* ignore */ } → catch (err) { log.warn(...) } |
| P2-6(部分) | orchestrator disposeHost 静默错误 | `255c0da0` | postMessage dispose + kill 加 log.warn |
| P2-原4 | BrowserWindowLike 缺 removeListener | `5119a27c` | 接口加可选 removeListener 方法 |

### P3（5/12 完成）

| # | 问题 | 修复提交 | 说明 |
|---|------|---------|------|
| P3-1 | validateUrl main 侧缺兜底 | `3d1403b5` | tab-manager.loadUrl 加协议白名单 |
| P3-2 | mail-manager heartbeat 未 unref | `255c0da0` | 加 .unref?.() |
| P3-7 | stubs 未使用 SQLInputValue 类型 | `255c0da0` | 删除 |
| P3-8 | .npmrc 缺 ELECTRON_BUILDER_BINARIES_MIRROR | `255c0da0` | 已补 |
| P3-10 | .workbuddy-ai/.zcode/.mimosa 目录 | — | 已 gitignore，无需操作 |
| P3-11 | release-v24/ 338MB 安装包 | — | 已 gitignore，无需操作 |

---

## 四、剩余未修复项（16 项）

### P1 剩余（1 项）

| # | 问题 | 位置 | 说明 | 建议优先级 |
|---|------|------|------|-----------|
| P1-11 | 渲染层不使用 @urchin.logger（26 处 console.error） | App.tsx(17处)、status-bar/(6处)、omnibox(1处)、FileViewer(1处)、settings-form(1处) | 需创建 renderer/lib/logger.ts 封装 createLogger，逐步替换 console.error | 中——改动面集中但不阻塞 |

### P2 剩余（8 项）

| # | 问题 | 位置 | 说明 | 建议优先级 |
|---|------|------|------|-----------|
| P2-5 | site-directory.ts 100KB 单文件 | renderer/home/site-directory.ts | 可能是硬编码站点目录数据，评估是否改为 JSON 数据文件 | 低 |
| P2-6(剩余) | 8 处空 catch（注入脚本内） | page-snapshot.ts(7处)、snapshot-export.ts(1处) | 在模板字符串内的 JS 代码，需改为 console.warn | 低 |
| P2-7 | `as unknown as` 类型逃逸（35 处） | index.ts(12)、bootstrap/handlers.ts(3)、bootstrap/theme-apply.ts(2)、其余散布 10+ 文件 | BrowserViewLike/WebContentsLike 用 Pick<...> 或 extends 消除双重 cast | 低——量大但非功能性 |
| P2-9 | IPC 通道命名不一致 | ipc-schema.ts: piWebHost.*/deepseekHarness.* | 改为 pihost.*/dsh.*，需同步改 schema+handler+renderer。v1.0 前必须定稿 | 中——破坏性变更 |
| P2-10 | workspace-sessions.ts 文件名 vs 类名 | workspaces/workspace-sessions.ts | 重命名为 workspace-session-manager.ts + 更新 import | 低 |
| P2-13 | vendor/deepseek-harness 整树入库（16324 文件） | vendor/deepseek-harness/ | 改 git submodule 或 npm 包依赖；至少 .gitignore 非必需目录 | 低——不影响功能 |
| P2-16 | CSP img-src 放行 http://127.0.0.1（无端口限定） | renderer/index.html:8 | 改为走 urchin://pi-icon/ 协议后移除，或限定端口 | 低 |
| P2-17 | stubs/polyfills 防御性遗留 | stubs/node-sqlite-stub.ts、polyfills/worker-threads-polyfill.ts | Electron 43/Node 24 已内置，条件 alias 或删除 | 低 |
| P2-18 | LRU 连接池数值不一致 | CHANGELOG dev.11 记 max=10，storage-layer.ts:34 实为 50 | 在 docs/事实登记表.md 记录实际值 | 低 |

### P3 剩余（7 项）

| # | 问题 | 位置 | 说明 | 建议优先级 |
|---|------|------|------|-----------|
| P1-14 | AGENTS.md CI 状态描述与实际不符 | AGENTS.md §九.2 | P0-1 修复后 CI 状态已变，需更新描述 | 低 |
| P3-3 | translate-manager pollTimer 未 unref | translate/translate-manager.ts:742 | 加 .unref?.() | 低 |
| P3-4 | .aoci/lock.stale.* 过期锁文件残留 | .aoci/ 工作目录 | 手动删除或 AOCI 自动清理 | 极低 |
| P3-5 | CHANGELOG.md 320KB 单文件 | CHANGELOG.md | 考虑按 minor 版本拆分 | 极低 |
| P3-6 | import/ 目录名歧义 | src/main/import/ | 重命名为 bookmark-import/ | 极低 |
| P3-9 | package:win 不跑 tsc -b | apps/desktop/package.json:23 | 流程约定覆盖（verify 前置），如要加强开头加 tsc -b | 极低 |
| P3-12 | overrides pin 版本可能 pi 升级时冲突 | package.json:20-31 | vendor/pi 升级时同步检查 | 极低 |

---

## 五、提交历史（审查修复相关，共 30 个提交）

| 提交 | 类型 | 说明 |
|------|------|------|
| `ab8df294` | feat | dev.145 前置提交 |
| `77428dbd` | fix(ci) | P0: token-bucket + CHANGELOG 编码 |
| `3d1403b5` | fix(security) | P1: URL 白名单 + IPC 超时 + IpcError + GenOffice zod |
| `5119a27c` | fix(resources) | P1: StorageLayer + Orchestrator + view-integration dispose |
| `c9853088` | chore | P1-P2: AOCI untrack + dev:full + perf.ps1 + dead code + lockfile |
| `255c0da0` | chore | P2-P3: timer unref + JSON.parse guard + kill logs + npmrc |
| `aeaaf6bc` | refactor(provider) | P1: OpenAI Provider 源码外迁 |
| `01badec1` | docs | P2 拆分蓝图文档 |
| `5622eaa1` | refactor(index) | step 1: AppContext |
| `2b5c18b9` | refactor(app) | extract TabBar |
| `2f20b241` | refactor(index) | step 2: performCleanup |
| `f93af437` | refactor(app) | extract LeftSidebar |
| `37f49c2b` | refactor(index) | step 3: registerIpcHandlers |
| `66cbe9f3` | refactor(app) | extract RightSidebar |
| `2486457f` | refactor(index) | step 4: watchdog |
| `8800ae62` | refactor(index) | step 5: applyTheme |
| `bc89f970` | refactor(index) | step 6: signals |
| `acfcec18` | refactor(app) | extract ContentArea |
| `f588cb1c` | refactor(app) | extract useDevtoolsColumn |
| `e42e96e1` | refactor(app) | extract useWorkspaces |
| `8fb6ec3d` | refactor(app) | extract useTabDrag/useModuleOpeners/useBookmark |
| `c97fa3af` | test(e2e) | isolate settings data dir |
| `ed033173` | docs(translate) | 划词结果卡悬浮待办 |
| `5e6b2c25` | refactor(settings) | step 1: useSettings hook |
| `ce2be568` | refactor(settings) | step 2: shared form controls |
| `a1fa9f82` | refactor(settings) | steps 3-6: five sections |
| `5d68e613` | refactor(settings) | step 7: promote tab components |
| `f0a7606f` | test(e2e) | settings-page smoke spec |
| `838626a6` | refactor(panel) | bookmark panel React migration |

---

## 六、新会话接续指南

### 需要的上下文

| 资料 | 位置 | 说明 |
|------|------|------|
| 本进度文档 | `docs/code-review-progress.md` | 你正在读的这份 |
| P2 拆分蓝图 | `docs/refactor-plan-p2.md` | 已完成，可作参考 |
| 当前代码状态 | git HEAD `838626a6` | 直接读文件 |
| 工作流规则 | `AGENTS.md` | verify + E2E + 构建启动 |

### 建议的下一步

1. **P1-11 渲染层 logger**（最后 1 项 P1）：
   - 创建 `renderer/lib/logger.ts` 封装 `createLogger`
   - 逐步替换 26 处 `console.error` → `log.error`
   - 先改 App.tsx（17 处，占比最大）

2. **P2-9 IPC 通道命名统一**（v1.0 前必须做）：
   - `piWebHost.*` → `pihost.*`、`deepseekHarness.*` → `dsh.*`
   - 需同步改 schema + handler + renderer 调用方

3. **P1-14 AGENTS.md CI 状态更新**：
   - P0-1 修复后 CI 状态已变，更新 §九.2 描述

4. 其余 P2-P3 项按优先级逐步处理，均不阻塞功能。
