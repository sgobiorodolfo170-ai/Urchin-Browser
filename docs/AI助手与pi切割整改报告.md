# AI 助手与 pi 切割整改报告

> 状态：已执行 · 日期：2026-10-30 · 执行人：glm-5.2（用户指令）
> 关联：[ADR-013](./decisions/ADR-013-pi阶段2自研前端与托管服务.md) · [pi-web-评估](./pi-web-评估.md) · [pi-web-host-对接实施清单](./pi-web-host-对接实施清单.md) · [AGENTS.md](../AGENTS.md) §〇.3 修改红线

## 一、整改背景与目标

### 1.1 问题

Urchin Browser 中「AI 助手」与「pi 对话模块」**命名纠缠、代码纠缠、设置纠缠**：

- **命名纠缠**：`ai.*` 设置键命名空间同时服务 pi 对话模块（`ai.providerId/apiKey/model/baseUrl`）和旧 AI 助手（`summary.*`、`ai.providerProfiles`），但两者功能完全独立。
- **设置纠缠**：`isPiSettingKey = ai.* || summary.*`（`settings-manager.ts:51`）把两者一起路由到 `pi/ai.db` + `pi/secrets`。
- **UI 纠缠**：桌面设置页「AI 助手」tab 编辑 `summary.*`（摘要助手配置），而非 pi 对话配置；PiSettingsDialog 编辑 `ai.*`（pi 配置）但已是死 UI（`setShowPiSettings(true)` 从未被调用）。
- **旧 AI 助手功能停滞**：summary（网页摘要提取）的 `summary.*` 配置（model/apiKey/baseUrl/providerId）在 `summary.run` 执行链中**零消费**（`summary.run` 是纯本地提取+保存，不调 LLM）——配置写而不读。
- **死代码**：PiSettingsDialog（永不打开）、AiChatView（packages/ai-extension，退役不在渲染树）、legacy settings-page.ts（protocol 返回空白 HTML）、piWeb.* 孤儿 IPC schema。

### 1.2 用户决策

> 用户指令：重新定义 AI 助手（区别于 pi），入口位于地址栏按钮，模型设置在设置页。重新开发 AI 助手，先做切割，摒弃网页摘要相关开发，把 AI 助手变成仅占位待开发状态。

四项关键决定：

| # | 决策点 | 选择 |
|---|---|---|
| 1 | pi 设置键命名空间 | **重命名 `ai.*` → `pi.*`**（彻底切割，释放 `ai.*` 给未来 AI 助手） |
| 2 | AI 助手占位形态 | 地址栏按钮 + 设置页 tab 都保留为占位 |
| 3 | pi 配置入口 | 复用 pi-web 前端 SettingsModal → 写回 `pi.*` 设置键 |
| 4 | 死代码清理 | 一并清理 |

---

## 二、变更清单

### 2.1 删除（摒弃旧 AI 助手 + 死代码清理）

| 目标 | 路径 | 原因 |
|---|---|---|
| summary 主进程模块 | `apps/desktop/src/main/summary/`（3 文件） | 旧 AI 助手（网页摘要提取），摒弃 |
| summary-agent 包 | `packages/summary-agent/`（整个 workspace 包） | summary 的提取/格式化逻辑，无其他引用 |
| AiChatView 包 | `packages/ai-extension/`（整个 workspace 包） | 阶段 2 启动器切换后退役，不在渲染树 |
| PiSettingsDialog | `apps/desktop/src/renderer/omnibox/pi-settings-dialog.tsx` | 死 UI（`setShowPiSettings(true)` 从未调用） |
| legacy 设置页 HTML | `apps/desktop/src/main/protocol/settings-page.ts` | 生产路径不调用（protocol 返回空白 HTML），仅测试引用 |
| summary 测试 | `tests/unit/summary-manager.test.ts`、`summary-register-handlers.test.ts` | 被测模块已删 |
| legacy 设置页测试 | `tests/unit/settings-page.test.ts` | 被测模块已删 |
| PiSettingsDialog 测试 | `tests/unit/pi-settings-dialog.test.tsx` | 被测组件已删 |
| AiChatView stores 测试 | `tests/unit/ai-conversation.test.ts`、`provider-status.test.ts` | 被测包已删 |
| workspace 依赖 | `apps/desktop/package.json`：删 `@urchin/summary-agent` + `@urchin/ai-extension` | 包已删 |
| tsconfig 路径别名 | `apps/desktop/tsconfig.json`：删 `@urchin/ai-extension` | 包已删 |

### 2.2 重命名（`ai.*` → `pi.*` 设置键 + 数据迁移）

| 文件 | 变更 |
|---|---|
| `settings-manager.ts:36-42` | `SECRET_KEYS`：`{ai.apiKey, summary.apiKey, ai.providerProfiles}` → `{pi.apiKey}` |
| `settings-manager.ts:51-53` | `isPiSettingKey`：`ai.* \|\| summary.*` → `pi.*` only |
| `settings-manager.ts:66-125` | DEFAULT_SETTINGS：`ai.model/apiKey/providerId/baseUrl` → `pi.*`；删 `summary.*`（4 键）+ `ai.providerProfiles` |
| `settings-manager.ts:204-215` | `parseSecretValue`：删 `ai.providerProfiles` JSON 分支（当前所有 SECRET_KEYS 均字符串） |
| `settings-manager.ts:165-185` | 迁移逻辑：`ai.*` → `pi.*` 重命名写 pi 库；`summary.*` / `ai.providerProfiles` 仅从主库删除 |
| `index.ts:874-892` | `agentConfigProvider`：`ai.apiKey/baseUrl` → `pi.apiKey/baseUrl` |
| `index.ts:989-990` | `agentCredsProvider`：`ai.providerId/model` → `pi.providerId/model` |
| `index.ts:1762-1776` | `mergedConfigProvider`：`ai.apiKey/baseUrl/model` → `pi.*` |
| `index.ts:1875-1884` | settings changed 监听：`ai.*` → `pi.*` |
| `pi-agent-factory.ts:206-207` | JSDoc 示例：`ai.apiKey/baseUrl` → `pi.*` |
| `register-handlers.ts:70` | 注释：`ai.*` → `pi.*` |
| `storage-layer.ts:123` | 注释：`ai.apiKey / summary.apiKey` → `pi.apiKey` |

### 2.3 AI 助手占位化

| 文件 | 变更 |
|---|---|
| `omnibox.tsx:263-273` | Sparkles 按钮 → 占位（aria-label "AI 助手（开发中）"，onClick 无操作） |
| `omnibox.tsx:54-57,100-101` | 删 `onSummarize` / `summarizeDisabled` props |
| `status-bar.tsx:98-99` | 删 `onSummarize` / `summarizeDisabled` 传递 |
| `status-bar-app.tsx:26` | 删 `summarizeDisabled: true` 默认值 |
| `status-bar-overlay.ts:49` | 删 `summarizeDisabled: true` 默认值 |
| `ipc-schema.ts:661` | 删 `summarizeDisabled` 字段 |
| `ipc-schema.ts:689` | 删 `{type: 'summarize'}` action |
| `SettingsPage.tsx:234` | `AI_FIELDS` → 空数组（后删除） |
| `SettingsPage.tsx:282-289` | 删 `parseProfiles` 函数 |
| `SettingsPage.tsx:313` | 删 `profileNameDraft` state |
| `SettingsPage.tsx:404-469` | 删 profile 全套逻辑（`profilesRaw`/`handleSaveProfile`/`handleDeleteProfile`/`handleSelectProfile`/`profileApi`） |
| `SettingsPage.tsx:532-540` | AI tab 渲染：SettingsSection → 占位 `<section>`（"AI 助手功能正在开发中，敬请期待"） |
| `SettingsPage.tsx:248-262` | DEFAULTS 删 `summary.*` + `ai.providerProfiles` |
| `SettingsPage.tsx:223` | data.directory desc 去掉"摘要" |
| `App.tsx` | 删 `SummaryTreeNode`/`SummaryTreeView`/`SummaryTreeItem` 组件（~110 行）、`summaryTree`/`loadSummaryTree`/`handleOpenSummaryDoc`、`handleSummarize`、`summaryRunning`、`summaryToast`→`actionToast` 重命名（保留截图/翻译/dsh 用途）、`showPiSettings`/`<PiSettingsDialog>`、piWeb.status 死调用→piWebHost.status |
| `App.tsx:22-35` | 删未使用 lucide 图标 import（Folder/FolderOpen/ChevronRight/ChevronDown） |

### 2.4 pi-web-host SettingsModal → `pi.*` 打通（Phase 4）

| 文件 | 变更 |
|---|---|
| `launcher.ts:33-45` | `UtilityProcessLike` 接口增加 `on('message')` + `postMessage()` |
| `launcher.ts:82` | 新增 `onChildMessage?: (msg: unknown) => void` 选项 |
| `launcher.ts:280-292` | fork 后 `child.on('message')` → `onChildMessage` 回调 |
| `launcher.ts:323-330` | 新增 `postMessage(msg)` 方法（主→子方向，预留 credsUpdate） |
| `server.ts:161-163` | 新增 `currentProviderId`/`currentModelId` 运行时可变变量 |
| `server.ts:175-177` | `ensureBridge` 使用 `currentProviderId`/`currentModelId`（支持 set_model 后重建） |
| `server.ts:340-365` | 新增 `set_model` WS handler：更新 model/provider + `disposeBridge()` + `process.parentPort.postMessage({type:'piSettingsChanged'})` 写回主进程 |
| `index.ts:1004-1012` | `onChildMessage` 回调：`piSettingsChanged` → `settingsManager.set('pi.providerId'/'pi.model')` |

### 2.5 IPC 契约清理

| 文件 | 变更 |
|---|---|
| `ipc-schema.ts:1347-1397` | 删 `piWeb.*` 孤儿 schema（launch/status/stop 3 通道 + 类型定义） |
| `ipc-schema.ts:2546-2548` | 删 piWeb.* 通道注册表条目 |

### 2.6 main/index.ts 拆线

| 行号 | 变更 |
|---|---|
| `:73` | 删 `import { SummaryManager, registerSummaryHandlers }` |
| `:104,211-212` | 删 `migrateLegacySummaries` import + 调用 |
| `:424-428` | 删 `summaryManager` 变量声明 |
| `:1031-1037` | 删 `registerSummaryHandlers` 调用 |
| `:1740-1742` | 删 `new SummaryManager(dataDir)` 实例化 |

### 2.7 测试更新

| 文件 | 变更 |
|---|---|
| `settings-manager.test.ts` | `ai.*`→`pi.*`；删 `ai.providerProfiles` 测试（3 个）；secret name `ai_apiKey`→`pi_apiKey`；entries 长度 27→22 |
| `settings-manager-pi.test.ts` | `isPiSettingKey` 测 `pi.*`→true、`ai.*`→false；`ai.*`→`pi.*` 路由测试；迁移测试断言 ai.*→pi.* 重命名 |
| `settings-page-component.test.tsx` | AI tab 占位断言；删 profile 测试（3 个）；删 `summary.model` mock |
| `omnibox.test.tsx` | 删 `onSummarize`/`summarizeDisabled` props + summarize 测试（2 个） |
| `App.test.tsx` | 删 summary tree 测试 + summary.run 测试 |

---

## 三、数据迁移

### 3.1 迁移逻辑（`settings-manager.ts:165-185`）

构造 SettingsManager 时，`legacyPiKeysScan` 扫描旧主库残留：

| 旧键 | 迁移动作 |
|---|---|
| `settings:ai.model` | → 写 `settings:pi.model` 到 pi 库 + 删主库 |
| `settings:ai.apiKey` | → 写 `settings:pi.apiKey` 到 pi 库 + 删主库 |
| `settings:ai.providerId` | → 写 `settings:pi.providerId` 到 pi 库 + 删主库 |
| `settings:ai.baseUrl` | → 写 `settings:pi.baseUrl` 到 pi 库 + 删主库 |
| `settings:summary.*` | → 仅删主库（废弃，不迁移） |
| `settings:ai.providerProfiles` | → 仅删主库（废弃，不迁移） |

### 3.2 密钥迁移

| 旧密钥文件 | 迁移动作 |
|---|---|
| `pi/secrets/settings/ai_apiKey.enc` | → 读出 → 写 `settings/pi_apiKey.enc` → 删旧（由 SECRET_KEYS preload 自动处理） |
| `pi/secrets/settings/summary_apiKey.enc` | → 不迁移（SECRET_KEYS 不再含 `summary.apiKey`，preload 不读取） |
| `pi/secrets/settings/ai_providerProfiles.enc` | → 不迁移（同上） |

### 3.3 迁移幂等性

- 已有 `pi.*` 键时跳过（不覆盖用户配置）
- 迁移失败仅记日志不阻塞启动（与既有 `legacyPiKeysScan` 语义一致）

---

## 四、对 pi 后续开发的影响

### 4.1 设置键命名空间（最重要变化）

**整改前**：
```
isPiSettingKey = ai.* || summary.*
SECRET_KEYS = {ai.apiKey, summary.apiKey, ai.providerProfiles}
```

**整改后**：
```
isPiSettingKey = pi.*
SECRET_KEYS = {pi.apiKey}
```

**影响**：
- pi 的所有设置键现在是 `pi.providerId` / `pi.apiKey` / `pi.model` / `pi.baseUrl`（不再是 `ai.*`）
- `ai.*` 命名空间已释放，预留给未来重新开发的 AI 助手
- 新增 pi 设置键时，只需以 `pi.` 前缀命名，`isPiSettingKey` 自动路由到 `pi/ai.db`
- **注意**：IPC 通道名（`ai.agent.start` / `ai.chat.start` / `ai.screenshot` 等）**未改名**——它们是 IPC 通道而非设置键，不影响切割语义。后续可选 rename。

### 4.2 pi 配置入口（SettingsModal 打通）

**整改前**：pi 配置编辑入口是 PiSettingsDialog（`ai.*` 键），但已死（永不打开）。pi 无可用配置 UI。

**整改后**：
- pi-web 前端 SettingsModal 的 `set_model` 操作 → pi-web-host server → `process.parentPort.postMessage` → 主进程 `settingsManager.set('pi.providerId'/'pi.model')`
- agent-bridge 在下次 prompt 时用新 model/provider 重建（`ensureBridge` 使用 `currentProviderId`/`currentModelId`）
- **已打通**：model/provider 的运行时切换 + 写回 `pi.*` 键
- **未打通**：API Key 的 SettingsModal → `pi.apiKey` 写回。pi-web-ui 的 API Key 管理机制（auth.json / provider_keys）与 `pi.apiKey` 单键模型的映射复杂，需后续专项设计。

**后续待做**：
1. **API Key 写回**：研究 pi-web-ui ModelConfigModal 的 API Key 设置流程，映射到 `pi.apiKey`
2. **parent→child credsUpdate**：主进程 `pi.*` 变更 → `launcher.postMessage({type:'credsUpdate'})` → pi-web-host 更新 agent-bridge 凭据（当前仅 child→parent 方向打通）
3. **pi-web-host E2E 修复**：`pi-web-host.spec.ts` 在原始 HEAD 即失败（URL 缺 token），非本次引入，需单独排查

### 4.3 pi-web-host 对接实施清单的更新

[docs/pi-web-host-对接实施清单.md](./pi-web-host-对接实施清单.md) 中的「第二批」「第三批」标注为「待实施」，但 git 历史显示已完成（commits `f16dca5b`/`63223cac`/`3c5e818a`/`3d28a927`）。该文档需更新：

| 批次 | 文档状态 | 实际状态 |
|---|---|---|
| 第二批：工具审批/路径补全/上下文压缩/Goal-Plan/更新检查 | 标「待实施」 | ✅ 已完成（`f16dca5b` + `63223cac`） |
| 第三批：Git 面板/write_file/search_files/set_cwd/技能市场 | 标「待实施」 | ✅ 已完成（`3c5e818a` + `3d28a927`） |
| 第三批剩余：终端/SSH/插件/DSH/MCP/子代理/Canvas/定时任务 | 标「待实施」 | ❌ 仍未做 |

### 4.4 CHANGELOG 断档

CHANGELOG 最新条目为 `v0.3.0-dev.124`（2026-10-28，M2A 骨架）。此后 pi 阶段 2 的约 11 个提交（M2B-1..4、M2C 回滚→全量继承、三批次后端对接）**全无 CHANGELOG 条目**。本次整改也未入 CHANGELOG。需补录。

### 4.5 packages/ai-extension 删除的影响

`packages/ai-extension` 包含：
- `AiChatView`（旧对话视图，退役）
- `useAiConversationStore` / `useProviderStatusStore`（Zustand stores）
- `ConversationList`（对话列表组件）

这些组件在阶段 2 启动器切换后不在渲染树中，且 stores 仅被已删测试引用。删除后：
- `apps/desktop/src/renderer/host-impl.ts` 仍存在（为 AiChatView 桥接 window.urchin → BrowserHostApi），现无消费者但保留（有独立测试 `host-impl.test.ts`，不在本次清理范围）
- `@urchin/browser-host` 包仍被 host-impl.ts 引用，保留

### 4.6 summary 模块删除的影响

- `summary.run` / `summary.listTree` / `summary.open` / `summary.delete` IPC 通道的 schema 仍在 `ipc-schema.ts` 中定义（孤儿，无 handler 无 caller）。可后续清理。
- `data-location.ts` 的 `migrateLegacySummaries` 函数仍存在（调用已从 index.ts 移除）。函数本身无害（不被调用），可后续清理。
- `data-location.ts:39` 的 `'summaries'` 目录名仍在目录列表中。可后续清理。
- userData 下已有的 `summaries/` 目录（旧用户保存的摘要文档）不会被自动删除——用户可手动清理。

### 4.7 ipc-contract 中 summary.* schema 孤儿

`ipc-schema.ts` 仍定义了 `summary.listTree/run/open/delete` 的 schema + 通道注册表条目。这些是孤儿（无 handler、无 caller）。不阻碍运行，但后续清理时应一并删除。

### 4.8 host-impl.ts 残留

`apps/desktop/src/renderer/host-impl.ts` 是 AiChatView 的 host 桥接层。AiChatView 已删但 host-impl.ts 保留（有独立测试）。若确认未来不再恢复 AiChatView，可连同 `host-impl.test.ts` + `@urchin/browser-host` 包一并清理。

---

## 五、验证结果

| 检查项 | 结果 |
|---|---|
| `pnpm typecheck`（desktop + ipc-contract） | ✅ 通过 |
| `pnpm lint` | ✅ 0 error（5 pre-existing devtools warnings） |
| `pnpm format:check` | ✅ 全绿 |
| `pnpm test:coverage` | ✅ 1297 passed（107 文件），coverage 达标 |
| `pnpm check:docs` | ✅ 无漂移 |
| `pnpm verify` | ✅ 全绿（verify stamp 已写） |
| `pnpm e2e` | 22 passed / 2 failed（perf 内存 + pi-web-host **预存问题**）/ 2 skipped |
| `pnpm build` + `pnpm start` | ✅ 应用启动正常 |

### pi-web-host E2E 预存问题

`pi-web-host.spec.ts` 在**原始 HEAD（本次整改前）即失败**（URL 缺 token），非本次引入。已验证：`git stash` → 原始代码 → 同样失败。需单独排查（可能与 utilityProcess message 接口或 stdout 解析有关）。

---

## 六、对后续迭代开发的指导

### 6.1 新增 pi 设置键

```typescript
// settings-manager.ts DEFAULT_SETTINGS
['pi.newKey', defaultValue],  // 自动被 isPiSettingKey('pi.*') = true 路由到 pi/ai.db
```

### 6.2 新增 AI 助手设置键

`ai.*` 命名空间已释放。未来 AI 助手开发时：

```typescript
// settings-manager.ts DEFAULT_SETTINGS
['ai.newFeature', defaultValue],  // ai.* 不再被 isPiSettingKey 捕获 → 走主库
```

若 AI 助手需要独立持久化（不进主库），新增 `isAiAssistantSettingKey` 函数 + 独立 Persistence/SecretStore（参考 DD1 pi 分离模式）。

### 6.3 pi-web SettingsModal 扩展配置写回

当前 `set_model` → `pi.providerId`/`pi.model` 已打通。扩展其他配置项写回 `pi.*` 键的模式：

1. **server.ts**：在对应 WS case 中 `process.parentPort.postMessage({type:'piSettingsChanged', ...})`
2. **index.ts**：`onChildMessage` 回调中提取字段 → `settingsManager.set('pi.*')`
3. **agent-bridge**：若需运行时生效，`disposeBridge()` 让 `ensureBridge` 用新值重建

### 6.4 不要恢复的代码

以下已删代码**不应恢复**：
- `packages/ai-extension/`（AiChatView 退役，pi-web-host 已取代）
- `packages/summary-agent/`（网页摘要功能摒弃）
- `PiSettingsDialog`（pi 配置入口改由 pi-web SettingsModal 承担）
- `summary.*` 设置键（无消费点，配置幻影）
- `ai.providerProfiles`（命名配置功能随 summary 一并摒弃）

### 6.5 待清理项（后续低优先级）

| 项 | 位置 | 说明 |
|---|---|---|
| summary.* IPC schema 孤儿 | `ipc-schema.ts` summaryListTree/Run/Open/Delete schema + 注册表 | 无 handler 无 caller |
| `migrateLegacySummaries` 函数 | `data-location.ts:206-220` | 调用已删，函数残留 |
| `'summaries'` 目录名 | `data-location.ts:39` | 目录列表残留 |
| `host-impl.ts` + `host-impl.test.ts` | `src/renderer/host-impl.ts` | AiChatView 桥接层，无消费者 |
| `@urchin/browser-host` 包 | `packages/browser-host/` | 仅被 host-impl.ts 引用 |
| `SettingsPage.tsx` ProfileSelect/ProfileApi/ProviderProfile | `src/renderer/settings/SettingsPage.tsx:51-85,775-852` | 死代码（AI_FIELDS 空，无字段用 provider-select/provider-name 类型） |
| `ai.agent.*`/`ai.screenshot`/`ai.uploadFile`/`ai.setWorkdir` IPC 通道名 | `ipc-schema.ts` | 通道名含 `ai.*` 但服务 pi，可选 rename 为 `pi.agent.*` 等 |

---

## 七、决策留痕

本次整改属架构性变更（设置键命名空间重命名 + 模块删除 + 新增 MessagePort 通信通道），按 AGENTS.md §〇.4 权限请求机制，已获用户明确授权（四项关键决定逐条确认）。

| 变更类型 | 是否架构性 | 授权记录 |
|---|---|---|
| 删除 summary 模块 + summary-agent 包 + ai-extension 包 | 是（模块删除） | 用户指令「摒弃ai助手之前有关网页摘要方面等相关开发」 |
| `ai.*` → `pi.*` 设置键重命名 + 数据迁移 | 是（命名空间变更） | 用户选择「重命名 ai.* → pi.*（彻底切割，推荐）」 |
| AI 助手占位化（地址栏按钮 + 设置页 tab） | 否（填充细化） | 用户选择「都保留为占位（推荐）」 |
| pi-web SettingsModal → pi.* 打通（MessagePort） | 是（新增通信通道） | 用户选择「复用 pi-web 前端 SettingsModal」 |
| 死代码清理（PiSettingsDialog/AiChatView/legacy/piWeb.*） | 否（清理） | 用户选择「一并清理（推荐）」 |
