# 全项目代码审查修复进度跟踪

> **创建时间**：2026-11-05
> **审查起点**：commit `d7e5b33b`（M28 transit 交付后）
> **当前 HEAD**：`29143aa6`（进度文档提交后）
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

---

## 二、四大文件拆分成果

| 文件 | 拆分前 | 拆分后 | 减幅 |
|------|--------|--------|------|
| index.ts | 2807 行 | 1423 行 | -49% |
| App.tsx | 3039 行 | 1557 行 | -49% |
| SettingsPage.tsx | 2087 行 | 158 行 | -92% |
| bookmark-panel.ts | 1187 行 | 265 行 | -78% |

---

## 三、按批次逐步对账

### 批次 1：解除 CI 阻塞（P0）— ✅ 全部完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 1.0 | CHANGELOG.md 先提交当前未提交改动 | ✅ | `ab8df294` | dev.145 全部改动一并提交 |
| 1.1 | token-bucket.test.ts:44 加 mock time | ✅ | `77428dbd` | |
| 1.2 | CHANGELOG.md 编码转换 | ✅ | `77428dbd` | ~95% 恢复，剩余 PUA 字符需人工修补 |
| 1.V | pnpm verify | ✅ | — | 全绿 |
| 1.C | git commit | ✅ | `77428dbd` | |

### 批次 2：安全与契约一致性（P1）— ✅ 全部完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 2.1 | validate-url 全重写 + tab-manager 兜底 + 测试补用例 | ✅ | `3d1403b5` | 协议白名单 + 控制字符剥离 + main 侧兜底 |
| 2.2 | genoffice home-handlers + host-channels 加 zod | ✅ | `3d1403b5` | payload schema + 路径安全检查 |
| 2.3 | server.ts createTimeout 返回 {promise, cancel} | ✅ | `3d1403b5` | race 后 clearTimeout |
| 2.4 | 9 处 throw new Error → throw new IpcError | ✅ | `3d1403b5` | tabs(5) + workspaces(2) + ai(2) |
| 2.V | pnpm verify + pnpm e2e | ✅ | — | |
| 2.C | git commit | ✅ | `3d1403b5` | |

### 批次 3：资源管理（P1）— ✅ 全部完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 3.1 | storage-layer.ts close() 每个 db 独立 try/catch | ✅ | `5119a27c` | |
| 3.2 | orchestrator types + orchestrator.ts messageListener | ✅ | `5119a27c` | ProviderHost 加字段 + disposeHost removeListener |
| 3.3 | view-integration.ts dispose clear Maps + removeListener | ✅ | `5119a27c` | + BrowserWindowLike 加 removeListener 方法 |
| 3.V | pnpm verify + pnpm e2e | ✅ | — | |
| 3.C | git commit | ✅ | `5119a27c` | |

### 批次 4：质量与流程（P1-P2）— ⚠️ 1 步未完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 4.1 | AOCI 产物移出版本控制 | ✅ | `c9853088` | git rm 5 文件 + .gitignore |
| 4.2 | dev:full 组合脚本 | ✅ | `c9853088` | |
| 4.3 | perf.ps1 动态路径 | ✅ | `c9853088` | $PSScriptRoot |
| 4.4 | 空 catch 补日志（12 处） | ❌ | — | **page-snapshot.ts(7处) + snapshot-export.ts(1处) 在注入脚本模板字符串内，未改；transit/drag-injection.ts(4处) + screenshots(1处) 未改** |
| 4.5 | devtools 死代码删除 | ✅ | `c9853088` | |
| 4.6 | pnpm-lock.yaml.bak 移除 | ✅ | `c9853088` | |
| 4.V | pnpm verify | ✅ | — | |
| 4.C | git commit | ✅ | `c9853088` | |

### 批次 5：架构治理（P1+P2）— ✅ 5 个子项全部完成，2 个子项细节未做

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 5.1 | Provider 源码外迁 | ✅ | `aeaaf6bc` | 外迁到 openai-compatible.ts + esbuild 编译 + 心跳清理 |
| 5.1 子项 | HTTPS 请求加 AbortController 超时 | ❌ | — | **未做** |
| 5.1 子项 | 接入 @urchin/ai-provider-contract 类型 | ⚠️ | — | 部分接入（消息类型自定义，未引用 contract 包） |
| 5.2 | index.ts 拆分（6 步） | ✅ | `5622eaa1`~`bc89f970` | AppContext → cleanup → handlers → watchdog → theme-apply → signals |
| 5.2 子项 | 冷启动性能测试 P95 ≤ 1011ms | ❌ | — | **未做** |
| 5.3 | App.tsx 拆分（7 步） | ✅ | `2b5c18b9`~`8fb6ec3d` | TabBar → LeftSidebar → RightSidebar → ContentArea → DevtoolsColumn → Workspaces → hooks |
| 5.4 | SettingsPage 拆分（7 步） | ✅ | `5e6b2c25`~`5d68e613` | useSettings → form controls → 5 sections → promote tabs |
| 5.5 | bookmark-panel React 迁移 | ✅ | `838626a6` | BookmarkPanelApp + 3 Tab 组件 + panel.css |
| 5.V | 每步 verify + e2e | ✅ | — | |
| 5.C | 每步独立 commit | ✅ | — | 共 18 个提交 |

### 批次 6：仓库卫生（P2-P3）— ❌ 5/6 未完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 6.1 | 删除 lefthook.yml | ✅ | `c9853088` | 在批次 4 中提前完成 |
| 6.2 | 删除 build-and-run.cmd/.bat | ❌ | — | **未做（已 gitignore 但文件仍在）** |
| 6.3 | workspace-sessions.ts 重命名 | ❌ | — | **未做** |
| 6.4 | IPC 通道命名统一 piWebHost→pihost | ❌ | — | **未做（破坏性变更，v1.0 前必须做）** |
| 6.5 | docs/事实登记表.md 记录 LRU max=50 | ❌ | — | **未做** |
| 6.6 | AGENTS.md §九.2 更新 CI 状态 | ❌ | — | **未做** |
| 6.V | pnpm verify | N/A | — | |
| 6.C | git commit | N/A | — | |

### 批次 7：收尾提示项（P3）— ⚠️ 1 步未完成

| 步骤 | 计划内容 | 状态 | 实际提交 | 备注 |
|------|----------|------|---------|------|
| 7.1 | tab-manager loadUrl 协议白名单兜底 | ✅ | `3d1403b5` | 在批次 2 中提前完成 |
| 7.2 | mail-manager unref + translate-manager unref | ⚠️ | `255c0da0` | **mail-manager ✅，translate-manager ❌ 未做** |
| 7.3 | stubs SQLInputValue 删除 | ✅ | `255c0da0` | |
| 7.4 | .npmrc ELECTRON_BUILDER_BINARIES_MIRROR | ✅ | `255c0da0` | |
| 7.5 | index.ts JSON.parse try/catch | ✅ | `255c0da0` | legacyPiKeysScan 容错 |
| 7.6 | orchestrator markCrashed kill 日志 | ✅ | `255c0da0` | 3 处 catch 加 log.warn |
| 7.V | pnpm verify | ✅ | — | |
| 7.C | git commit | ✅ | `255c0da0` | |

---

## 四、批次对账汇总

| 批次 | 计划步骤数 | 完成 | 未完成 | 部分 | 完成率 |
|------|-----------|------|--------|------|--------|
| 1 (P0) | 5 | 5 | 0 | 0 | **100%** |
| 2 (P1 安全) | 6 | 6 | 0 | 0 | **100%** |
| 3 (P1 资源) | 5 | 5 | 0 | 0 | **100%** |
| 4 (P1-P2 质量) | 8 | 6 | 1 | 0 | 75% |
| 5 (架构治理) | 5 主项 + 2 子项 | 5 主项 + 0 子项 | 2 子项 | 1 子项 | 86% |
| 6 (仓库卫生) | 7 | 2 | 5 | 0 | 29% |
| 7 (收尾 P3) | 7 | 6 | 0 | 1 | 86% |
| **合计** | **40+** | **35** | **8** | **2** | **~88%** |

---

## 五、未完成项明细（10 项）

### 来自批次 4（1 项）

| 步骤 | 问题 | 位置 | 说明 |
|------|------|------|------|
| 4.4 | 空 catch 补日志（12 处） | page-snapshot.ts(7) + snapshot-export.ts(1) + drag-injection.ts(4) | 注入脚本模板字符串内的 `catch (e) {}`，需改为 `console.warn` |

### 来自批次 5（2 项子项）

| 步骤 | 问题 | 说明 |
|------|------|------|
| 5.1 子项 | Provider HTTPS 请求加 AbortController 超时 | openai-compatible.ts 的 request() 函数无超时控制 |
| 5.2 子项 | 冷启动性能测试 P95 ≤ 1011ms 基线验证 | 拆分后未跑性能测试验证未退化 |

### 来自批次 6（5 项）

| 步骤 | 问题 | 说明 |
|------|------|------|
| 6.2 | 删除 build-and-run.cmd/.bat | 已 gitignore 但文件仍在工作区 |
| 6.3 | workspace-sessions.ts → workspace-session-manager.ts | 同步更新 import 路径 |
| 6.4 | IPC 通道命名 piWebHost→pihost、deepseekHarness→dsh | 破坏性变更，需同步改 schema+handler+renderer |
| 6.5 | docs/事实登记表.md 记录 LRU max=50 | 事实漂移记录 |
| 6.6 | AGENTS.md §九.2 更新 CI 状态 | P0-1 修复后 CI 状态已变 |

### 来自批次 7（1 项）

| 步骤 | 问题 | 位置 | 说明 |
|------|------|------|------|
| 7.2 | translate-manager pollTimer 未 unref | translate/translate-manager.ts:742 | 加 .unref?.() |

### 计划外剩余（审查发现但不在原计划中，4 项）

| 问题 | 位置 | 说明 |
|------|------|------|
| P1-11 渲染层 logger | App.tsx(17) + status-bar(6) + omnibox(1) + FileViewer(1) + settings-form(1) | 26 处 console.error → @urchin/logger |
| P2-7 类型逃逸 as unknown as（35 处） | index.ts(12) + handlers.ts(3) + theme-apply.ts(2) + 其余散布 | BrowserViewLike 用 Pick 消除 |
| P2-13 vendor/deepseek-harness 整树入库 | vendor/deepseek-harness/ | 16324 tracked 文件 |
| P2-16 CSP img-src 放行 127.0.0.1 | renderer/index.html:8 | 改走 urchin://pi-icon/ 后移除 |

---

## 六、提交历史（审查修复相关，共 31 个提交）

| 提交 | 批次 | 说明 |
|------|------|------|
| `ab8df294` | 前置 | dev.145 前置提交 |
| `77428dbd` | 1 | P0: token-bucket + CHANGELOG 编码 |
| `3d1403b5` | 2 | P1: URL 白名单 + IPC 超时 + IpcError + GenOffice zod |
| `5119a27c` | 3 | P1: StorageLayer + Orchestrator + view-integration |
| `c9853088` | 4 | P1-P2: AOCI + dev:full + perf.ps1 + dead code + lockfile |
| `255c0da0` | 7 | P2-P3: timer unref + JSON.parse + kill logs + npmrc |
| `aeaaf6bc` | 5.1 | Provider 源码外迁 |
| `01badec1` | 文档 | P2 拆分蓝图 |
| `5622eaa1` | 5.2-1 | index.ts step 1: AppContext |
| `2b5c18b9` | 5.3-1 | App.tsx extract TabBar |
| `2f20b241` | 5.2-2 | index.ts step 2: performCleanup |
| `f93af437` | 5.3-2 | App.tsx extract LeftSidebar |
| `37f49c2b` | 5.2-3 | index.ts step 3: registerIpcHandlers |
| `66cbe9f3` | 5.3-3 | App.tsx extract RightSidebar |
| `2486457f` | 5.2-4 | index.ts step 4: watchdog |
| `8800ae62` | 5.2-5 | index.ts step 5: applyTheme |
| `bc89f970` | 5.2-6 | index.ts step 6: signals |
| `acfcec18` | 5.3-4 | App.tsx extract ContentArea |
| `f588cb1c` | 5.3-5 | App.tsx extract useDevtoolsColumn |
| `e42e96e1` | 5.3-6 | App.tsx extract useWorkspaces |
| `8fb6ec3d` | 5.3-7 | App.tsx extract hooks |
| `c97fa3af` | 测试 | isolate settings data dir |
| `ed033173` | 文档 | 划词结果卡待办 |
| `5e6b2c25` | 5.4-1 | SettingsPage step 1: useSettings |
| `ce2be568` | 5.4-2 | SettingsPage step 2: form controls |
| `a1fa9f82` | 5.4-3 | SettingsPage steps 3-6: sections |
| `5d68e613` | 5.4-4 | SettingsPage step 7: promote tabs |
| `f0a7606f` | 测试 | settings-page smoke spec |
| `838626a6` | 5.5 | bookmark panel React migration |
| `29143aa6` | 文档 | 进度跟踪文档 |

---

## 七、新会话接续指南

### 需要的上下文

| 资料 | 位置 | 说明 |
|------|------|------|
| 本进度文档 | `docs/code-review-progress.md` | 你正在读的这份 |
| P2 拆分蓝图 | `docs/refactor-plan-p2.md` | 已完成，可作参考 |
| 当前代码状态 | git HEAD `29143aa6` | 直接读文件 |
| 工作流规则 | `AGENTS.md` | verify + E2E + 构建启动 |

### 未完成项按优先级排序

1. **批次 6.4**：IPC 通道命名统一（v1.0 前必须做）
2. **批次 6.6**：AGENTS.md CI 状态更新
3. **批次 6.5**：事实登记表 LRU 值
4. **P1-11**：渲染层 logger（26 处 console.error）
5. **批次 6.3**：workspace-sessions.ts 重命名
6. **批次 7.2**：translate-manager unref
7. **批次 4.4**：空 catch 补日志（12 处）
8. **批次 6.2**：删除过时辅助脚本
9. **P2-7**：类型逃逸治理（35 处）
10. **批次 5.1 子项**：Provider HTTPS 超时
11. **批次 5.2 子项**：冷启动性能测试
12. **P2-16**：CSP img-src 收紧
13. 其余 P3 极低优先级项
