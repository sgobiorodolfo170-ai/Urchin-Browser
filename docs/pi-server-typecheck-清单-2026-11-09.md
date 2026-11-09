# pi-server typecheck 错误清单（2026-11-09）

> 任务：把 `packages/pi-web-host/src/pi-server`（347 个 `.ts`）纳入 `tsc` 覆盖。
> 本文档是「**第 1 步：出清单**」的产物——只记录现状与分类，**不含任何代码修复**。
> 修复分批与顺序见 [§6](#6-建议分批)，等确认后执行；执行进展回写 [交接文档 §9](./pi-web-测试交接-2026-11-08.md)。
>
> 背景（交接文档 §3 结构决策）：`src/pi-server` 长期被主 `tsconfig.json` 的 `exclude` 排除，
> 原因不是它写得不对，而是 `tests/pi-server` 直接 import 它，`tsc` 会把整条闭包拉进程序、
> 暴露上游类型缺口，让 `pnpm typecheck` 失败。结果是 **347 文件 / 1.4 万行从未被编译器检查过**。

---

## 1. 结论摘要

| 指标 | 值 |
| --- | --- |
| 独立程序 | `packages/pi-web-host/tsconfig.pi-server.json`（`extends ./tsconfig.json`，`include` 仅 `src/pi-server/**/*.ts` + `src/pi-shims.d.ts`） |
| 编译器设置 | 继承包内现状：`strict: true`、`noUncheckedIndexedAccess: false`、`skipLibCheck: true`（与 `tsconfig.base.json` 一致，**未新开任何宽化开关**） |
| 错误总数 | **412** |
| 命中文件 | **72** / 347（20.7%） |
| 唯一主因 | vendored `@earendil-works/*` 的 ambient shim 只声明了 5 个导出，`src/pi-server` 实际引用 **40** 个 |
| 真实缺陷 | **19 条**（另 3 条待 shim 精确后复判），其中 `D8` = 2 条、引擎剪枝残留死分支 = 10 条 |

**一句话**：412 条里约 **390 条**不是「代码写错了」，而是「vendored SDK 没有类型」的连锁反应；
真正需要动业务逻辑的只有 19 条，且高度集中（3 个文件的死分支占 10 条）。

---

## 2. 复现方式

```powershell
# 只看 pi-server 程序（非阻塞，不在 verify 链里）
pnpm --filter @urchin/pi-web-host typecheck:pi-server

# 或者直接调 tsc，便于重定向到文件聚合
cd packages/pi-web-host
npx tsc --noEmit -p tsconfig.pi-server.json
```

等价根命令（本次新增）：`pnpm typecheck:pi-server`。

**为什么 `include` 里带 `src/pi-shims.d.ts`**：不带上它，`@earendil-works/pi-coding-agent`
会被判成「模块不存在」（TS2307）而不是「缺少某个导出」（TS2305），90 多个文件全部糊成一条
无信息量的错误。带上它，剩下的缺口才能落到具体导出名上，可直接照着补 shim。

---

## 3. 按错误码聚合

| 错误码 | 数量 | 含义 | 归因 |
| --- | --- | --- | --- |
| TS7006 | 242 | 参数隐式 any | 级联（回调形参失去上下文类型） |
| TS2305 | 122 | 模块无此导出 | **直接缺口**（vendored shim 缺失） |
| TS2339 | 16 | 属性不存在于类型 | 级联（类型退化成 `unknown` / 空接口） |
| TS2367 | 8 | 比较两侧无重叠 | **真实缺陷**（引擎剪枝后死分支） |
| TS2345 | 6 | 实参类型不匹配 | 2 条三方库、4 条级联 |
| TS2307 | 6 | 找不到模块 | 3 条 vendored（pi-tui ×2、pi-mcp/oauth ×1）、3 条缺 `plugin-sdk` |
| TS7019 | 4 | rest 参数隐式 any[] | 级联 |
| TS18046 | 3 | 值为 `unknown` | 级联 |
| TS7031 | 2 | 解构绑定隐式 any | 级联 |
| TS2694 | 1 | 命名空间无此导出（`import("…").X` 写法） | 直接缺口（`SessionEntry`） |
| TS2322 | 1 | 返回类型不兼容 | 待复判（`GroupRouterModelRuntime`） |
| TS2353 | 1 | 对象字面量含未知属性 | 级联（`SessionInfo` 未解析） |

**级联规模**：`TS7006 + TS7031 + TS7019 + TS18046 = 252` 条是同一个源头的机械后果——
vendored 导出没有类型 → 回调失去上下文类型 → 每个形参各报一条。补好 shim 后它们应当**一次清零**，
不需要逐条处理。另有约 30 条（`TS2339 / TS2345 / TS2353 / TS2322`）依赖 shim 的**形状精度**，
要等 shim 落地后复跑才能确认是残留真缺陷还是自动消失。

---

## 4. 按文件聚合

### 4.1 Top 15（占 62.6% 的错误）

| # | 文件 | 错误 | 其中非 shim 级联 |
| --- | --- | --- | --- |
| 1 | `src/pi-server/agent-service.ts` | 87 | 0（全部源于 `SessionInfo` / `SessionManager` / `ModelRuntime` 未解析） |
| 2 | `src/pi-server/tool-guards.ts` | 28 | 0（5 处 `execute` 五参回调） |
| 3 | `src/pi-server/bash-tool.ts` | 16 | 0 |
| 4 | `src/pi-server/read-tool.ts` | 16 | 0 |
| 5 | `src/pi-server/goal-service.ts` | 13 | 0 |
| 6 | `src/pi-server/plugins.ts` | 13 | **3**（缺 `../plugin-sdk/index.js`） |
| 7 | `src/pi-server/subagents.ts` | 11 | 0 |
| 8 | `src/pi-server/terminals.ts` | 10 | **2**（`claude` / `codex` 死分支） |
| 9 | `src/pi-server/claim-files-tool.ts` | 9 | 0 |
| 10 | `src/pi-server/edit-soft-tool.ts` | 9 | 0 |
| 11 | `src/pi-server/request-context.ts` | 9 | 0（`AgentSession` / `ExtensionAPI` / `ExtensionUIContext` 未声明） |
| 12 | `src/pi-server/webui-context.ts` | 8 | 0（`pi-tui` 未声明） |
| 13 | `src/pi-server/canvas/canvas-agent-tool.ts` | 7 | 0 |
| 14 | `src/pi-server/conversation-read-tool.ts` | 7 | 0 |
| 15 | `src/pi-server/delegate-task.ts` | 7 | 0 |

### 4.2 全量 72 个文件

```
87 agent-service.ts                                      4 compact-context-tool.ts
28 tool-guards.ts                                        4 eval-tool.ts
16 bash-tool.ts                                          4 load-tools-tool.ts
16 read-tool.ts                                          4 mcp-agent-tool.ts
13 goal-service.ts                                       4 plugin-llm.ts
13 plugins.ts                                            4 quick-ask.ts
11 subagents.ts                                          4 serialize.ts
10 terminals.ts                                          4 skill-tool.ts
 9 claim-files-tool.ts                                   4 tool-host-factories.ts
 9 edit-soft-tool.ts                                     3 context-usage.ts
 9 request-context.ts                                    3 device-center/group-router-runtime.ts
 8 webui-context.ts                                      3 message-deletion.ts
 7 canvas/canvas-agent-tool.ts                           3 sandbox-tool.ts
 7 conversation-read-tool.ts                             3 worktree-tool.ts
 7 delegate-task.ts                                      2 device-center/device-lan.ts
 7 present-files-tool.ts                                 2 mcp-oauth-login.ts
 6 context-evidence.ts                                   2 model-admin.ts
 6 device-center/bot-catalog.ts                          2 provider-oauth-flow.ts
 6 device-center/collab-tool.ts                          2 sdk-builtin-extensions.ts
 6 index.ts                                              2 session-list-scan.ts
 6 native-cli-session.ts                                 2 session-parser.ts
 6 sandbox-service.ts                                    2 vision-bridge.ts  ← D8
 6 settings-service.ts                                   1 ×23 个文件（ask-user-question-tool /
 5 conversation-tool.ts                                     browser-page-tool / communicate-tool /
 5 lsp-tool.ts                                             context-budget / engine-probe /
 5 patch-tool.ts                                           message-entry-resolver / native-cli-state /
 5 schedule-agent-tool.ts                                  native-cli / plan-update-tool / plugin-assets /
 4 agent-service-daemon.ts                                 prompt-assembler / session-branch / session-open /
                                                           session-search / slash-commands / soft-cap /
                                                           subagent-security-gate / tool-overrides /
                                                           virtual-tui / agent-formatters）
```

**分布特征**：62 个文件是「纯 shim 级联」（278 条），10 个文件含真实缺陷（134 条，其中非级联 19 条）。
即**补好 shim 后，需要改业务代码的只剩 10 个文件**。

---

## 5. 分类

### A. vendored SDK 缺类型（需 shim）— 直接缺口 125 条 + 级联约 268 条

`src/pi-shims.d.ts` 现有声明只覆盖 5 个导出（`createBashTool` / `createReadTool` / `createEditTool` /
`createWriteTool` / `ModelRuntime`，且都是 `any` 宽松形态）。`src/pi-server` 实际引用 40 个：

| 导出 | 次数 | 形态 | 备注 |
| --- | --- | --- | --- |
| `ToolDefinition` | 28 | 类型 | 主因：`execute` 五参签名决定 140+ 条 TS7006 |
| `defineTool` | 19 | 值（泛型函数） | 同上 |
| `AgentSession` | 10 | 类型 | `messages` / `sendCustomMessage` / 索引访问 |
| `SessionManager` | 8 | 值（类） | `session-parser` / `session-open` / `native-cli*` |
| `SessionInfo` | 5 | 类型 | `session-list-scan` / `session-search` / `tool-host-factories` |
| `getAgentDir` | 4 | 值 | |
| `VERSION` | 4 | 值 | `engine-probe` / `index` / `agent-service-daemon` |
| `SessionEntry` | 3 | 类型 | `message-deletion` / `session-branch`（另有 `import("…").SessionEntry` 写法 1 处） |
| `AgentToolResult` | 3 | 类型 | `sandbox-tool` / `worktree-tool` |
| `createAgentSessionFromServices` / `createAgentSessionServices` | 3 + 3 | 值 | 会话服务工厂 |
| `estimateTokens` | 2 | 值 | `context-usage` / `prompt-assembler` |
| `createEditToolDefinition` / `createWriteToolDefinition` | 2 + 1 | 值 | **测试侧 shim 已存在同名声明，需保持一致** |
| `createBashToolDefinition` / `createReadToolDefinition` / `createLsToolDefinition` / `createFindToolDefinition` / `createGrepToolDefinition` | 1 each | 值 | 工具工厂族 |
| `createLocalBashOperations` | 1 | 值 | |
| `createCodemodeExtension` / `createToolSearchExtension` | 1 each | 值 | `sdk-builtin-extensions` |
| `DEFAULT_COMPACTION_SETTINGS` | 1 | 值 | `soft-cap` |
| `DefaultPackageManager` / `SettingsManager` / `loadSkills` | 1 each | 值 | `device-center/bot-catalog` |
| `ExtensionAPI` / `ExtensionError` / `ExtensionUIContext` / `ExtensionUIDialogOptions` | 1 each | 类型 | `request-context` / `webui-context` |
| `AgentSessionEvent` / `AgentSessionRuntime` / `CreateAgentSessionRuntimeFactory` / `createAgentSessionRuntime` | 1 each | 混合 | 会话运行时 |
| `generateDiffString` / `generateUnifiedPatch` / `withFileMutationQueue` | 1 each | 值 | 补丁链 |
| `initTheme` / `Theme` | 1 each | 值 / 类型 | 主题 |
| `resolveModelScopeWithDiagnostics` | 1 | 值 | |
| `@earendil-works/pi-tui`（整包） | 2 | 模块 | `virtual-tui.ts` / `webui-context.ts` |
| `@earendil-works/pi-mcp/oauth`（整包） | 1 | 模块 | `mcp-oauth-login.ts` |

> 真实形状可从 `vendor/pi/packages/{coding-agent,tui,mcp}/src` 读出（上游是同一份源码），
> 无需猜。注意：`vendor/pi/packages/*` 下**没有 `dist/`**，`package.json` 的 `types` 指向不存在的
> `dist/index.d.ts`，所以「用真实 d.ts」这条路走不通——必须写 ambient shim（或先构建 vendor，
> 属独立决策，不在本任务范围）。

### B. 三方库类型不匹配（需 shim 或局部断言）— 3 条

| 位置 | 错误 | 说明 | 建议 |
| --- | --- | --- | --- |
| `device-center/device-lan.ts:248,249` | TS2345 ×2 | `https` 的 `connection` 事件给的是 `Duplex`（`net.Socket`），而 `s.sockets` 是 `ws` 的 `Set<Socket>` | 在 shim 文件里导出一个 `asWsSocket()` 收窄函数、或就地 `as unknown as WebSocket` + 注释说明（二者都集中在 shim，不散落业务代码） |
| `plugin-assets.ts:187` | TS2345 | `new Promise((r) => …)` 推断成 `Promise<unknown>`，`r` 是 `(value: unknown) => void`，与 `once("drain", () => void)` 不兼容 | 本项目代码，直接改 `new Promise<void>((resolve) => fileStream.once("drain", () => resolve()))` |
| `device-center/group-router-runtime.ts:154,160` | TS2339 ×2 | `messages` / `reasoning` 在 `unknown` / `{}` 上不存在 | 待 `ModelRuntime` 精确化后复判 |

### C. 本项目真实缺陷 — 19 条（按修复优先级）

| # | 位置 | 条数 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| C1 | `vision-bridge.ts:176,177` | 2 | **D8**：`runtime.completeSimple()` 因 shim 的 `[key: string]: any` 索引签名返回 `any`，`msg.content.filter((b) => b.type === "text")` 的 `b` 无任何编译期保护（`content` 若是字符串就会在运行时炸） | ① shim 给出精确返回类型（`content: AssistantContentBlock[]` 判别联合）② 业务侧改成判别式收窄（`b.type === "text" && "text" in b`）或运行时形状校验，去掉 `as { text?: string }` 断言 ③ 补回归用例（content 为 string / 混入未知块） |
| C2 | `native-cli-session.ts:249,251,282,286,367,469` | 6 | 引擎剪枝后 `NativeCliPreset = "pi" \| "custom"`（`ENGINE_CATALOG` 只剩 `pi`），`claude` / `codex` / `agy` 分支全部不可达；`282:43` 的 `"agy"` 比较在 `"custom"` 收窄后也被判无重叠 | **需先定方向**：① 删除死分支（约 200 行 claude/codex 会话绑定逻辑）② 或把引擎恢复进 `ENGINE_CATALOG`。与 D5 同族，D5 选择的是「删除」 |
| C3 | `terminals.ts:865` | 2 | `opts.nativeCli.preset === "claude" \|\| … === "codex"` → `needsAuth` 恒为 `false`，`resolveNativeCliModel` 成为死路径 | 同 C2 方向 |
| C4 | `index.ts:2654,2655` | 2 | `targetEngine: EngineId \| null = msg.engine === "pi" ? "pi" : null` 之后 `targetEngine !== "pi"` 恒假，`targetEngine.toUpperCase()` 落在 `never`；同一段 2637-2644 的报错文案仍在宣传 `dsh / codex / claude / durable` | 删死分支 + 修文案；或按 C2 方向恢复引擎 |
| C5 | `plugins.ts:304,2017,3437` + `index.ts:2367` | 4 | `import("../plugin-sdk/index.js").PluginWorkItems` 指向**本仓库不存在**的模块（上游 `pi-web-ui/plugin-sdk/` 才有）；`keyof` 因此退化成 `string \| number \| symbol`，传给 `deviceCenter.workItems(method: string)` 报 TS2345。运行时无影响（纯类型位置，esbuild 会擦除），但类型事实是断的 | 新建 `src/plugin-sdk/` 只放类型（`PluginWorkItems` 等），从上游同名文件裁剪复制；或改成在 shim 里声明。**属新增源文件，需确认** |
| C6 | `plugin-assets.ts:187` | 1 | 见 §5-B（本项目代码，非三方） | 改 `Promise<void>` |
| C7 | `device-center/device-lan.ts:248,249` | 2 | 见 §5-B | 收窄到 shim |

> C2/C3/C4 合计 10 条，是**同一根因**（引擎裁剪未收尾）。建议合成一批、一次决策、一次提交。

---

## 6. 建议分批

原则：**先小步证伪，再大批量**。每批都能独立合入、`pnpm verify` 全绿，且批内先写失败用例（适用时）。
优先级按任务要求：D8 / 真实缺陷 > vendored shim > 三方断言。

| 批 | 内容 | 涉及文件 | 预期错误变化 | 风险 |
| --- | --- | --- | --- | --- |
| **B0**（本批，已完成） | `tsconfig.pi-server.json` + `typecheck:pi-server` 脚本 + 本清单；**不接入 verify** | 3 个新增/改动 | 不适用（脚本本身非阻塞） | 无 |
| **B1** | **最小精确 shim（只为 D8 服务）**：`ModelRuntime.completeSimple()` 返回 `AssistantMessage` 形状（`content: AssistantContentBlock[]` 判别联合 + `stopReason` / `errorMessage`） | 新增 `src/pi-shims-coding-agent.d.ts` | 412 → 410 | 低。只加类型，不改运行时 |
| **B2** | **D8 真修**：`vision-bridge.ts` 去掉 `as { text?: string }` 断言，改判别式收窄 / 运行时校验；补回归用例（红→绿） | `vision-bridge.ts` + `tests/pi-server/vision-bridge.test.ts` | 410 → 408 | 中。改业务逻辑，需回归用例锁行为 |
| **B3** | **全量 vendored shim**：coding-agent 剩余 38 个导出 + `pi-tui` + `pi-mcp/oauth`，形状照 `vendor/pi/packages/*/src` 抄 | 新增 2-3 个 `src/pi-shims-*.d.ts` | 408 → ≈20~40 | 中。**形状精度**决定残留量；不追求一次到位，够用即可 |
| **B4** | **引擎剪枝收尾**（C2+C3+C4）：删 `claude` / `codex` / `agy` 死分支、修 `switch_engine` 文案 | `native-cli-session.ts` / `terminals.ts` / `index.ts` | −10 | **高**。要动约 200 行；需用户先定「删」还是「恢复引擎」 |
| **B5** | **零散真实缺陷**（C5/C6/C7）+ 复跑残留 | `plugins.ts` / `index.ts` / `plugin-assets.ts` / `device-lan.ts` + 可能新增 `src/plugin-sdk/` | → 0 | 中。C5 的新增类型模块需确认 |
| **B6** | **接门禁 + 收口**：`typecheck:pi-server` 进 `verify` 链、AGENTS 工作流约定第 1 条与 §九.4（新 G19）、`docs/03 §4` 与交接 §9 口径；再单独评估 `tests/pi-server` 是否纳入 | 配置 + 4 处文档 | 保持 0 | 低。tests 纳入会引入新一批缺口，**单独开批** |

**每批验收**：

```powershell
pnpm --filter @urchin/pi-web-host exec vitest run tests/pi-server/<相关>
pnpm verify
git add <本批文件>
```

---

## 7. 补充实测：把 `tests/pi-server` 一并纳入会怎样（2026-11-09）

为回答「tests 纳入会不会引入新一批缺口」，用一次性探针 tsconfig（**未入库**，跑完即删）把
`tests/pi-server/**/*.ts` 与 4 个测试侧 shim 一并塞进同一个程序，实测结果：

| 指标 | 仅 src | src + tests |
| --- | --- | --- |
| 程序内文件 | 347 | 347 + **52**（测试文件全部进程序，`--listFiles` 核实） |
| 测试文件自身的错误 | — | **0** |
| `src/pi-server` 的错误 | 412 | **294** |

两个结论，直接影响分批计划：

1. **tests 纳入成本≈0**：52 个测试文件全部通过类型检查。它们本来就是按类型写的，
   只是被 `exclude` 挡在门外。
2. **测试侧 shim 已是一份半成品 shim**：`tests/pi-server-tool-shims.d.ts`、
   `tests/pi-server-vendored-shims.d.ts`、`tests/pi-server/session-pipeline-shims.d.ts`、
   `tests/pi-shims-augment.d.ts` 已经精确声明了 `ToolDefinition`（含五参 `execute`）、
   `AgentMessage`、`AgentSession`、`SessionEntry`、`estimateTokens`、
   `DEFAULT_COMPACTION_SETTINGS` 等导出，因此 src 侧错误一次少掉 118 条。
   → **B3 不必从零写 40 个导出**：把这批声明「提升」成 src 侧正式 shim，再补剩余约 33 个即可。
3. **遗留动作**：两份声明一旦进同一个程序就会相遇。当前 0 冲突是因为 src 侧尚未声明
   `ToolDefinition`；B3 落地时须把测试侧重复声明删掉、改为引用 src 侧 shim，
   否则同一接口声明两次会报 `Subsequent property declarations must have the same type`。

---

## 8. 需要确认的决策点

1. **C2/C3/C4 的方向**：引擎裁剪残留的 10 条死分支，是**删除**（约 200 行，与 D5 一致）还是**恢复引擎进
   `ENGINE_CATALOG`**？删除更彻底但会永久失去那部分适配代码；恢复则等于重启被裁剪的引擎。
2. **shim 落点**：交接文档 §3 的规则是「新增 vendored 导出时优先补 shim，不要改 `src/pi-shims.d.ts`（除非得到授权）」。
   本任务建议在 `src/pi-shims-coding-agent.d.ts` / `src/pi-shims-tui.d.ts` / `src/pi-shims-mcp.d.ts`
   新增**独立文件**（不改动 `src/pi-shims.d.ts`），由两个 tsconfig 同时收录。请确认这个落点。
3. **C5 的 `plugin-sdk`**：新建 `src/plugin-sdk/`（只含类型，从上游裁剪）还是用 ambient 声明？前者更接近上游结构。
4. **B6 的 `tests/pi-server`**：确认「先接 `src`、`tests` 单独开批」的节奏。

---

## 9. 执行进展（回写）

> 用户 2026-11-09「同意，全部按推荐方案推进」后开始执行。每批一次提交，`pnpm verify` 全绿才提交。

| 批 | 提交 | 实际结果 | 与计划的差异 |
| --- | --- | --- | --- |
| B0 | `bf7b5c24` | 新增 `tsconfig.pi-server.json` + `typecheck:pi-server`（包内 + 根）+ 本清单 + 文档索引行；不接入 verify | 无 |
| 文档补测 | `364cfc53` | §7 记录 tests 纳入探针：52 文件 / 0 错误；src 412 → 294 | 无 |
| B1 | `fbd531ab` | 新增 `src/pi-shims-coding-agent.d.ts`（精确 `completeSimple` / `AssistantMessage` / `Context` / `Message` / 工具与内容块 / `StopReason` / `Model`）；实际 **412 → 404（修 8、零新增）**：vision-bridge 2 条 TS7006（D8 的类型面）、`group-router-runtime` 3 条、`quick-ask` 3 条 | 计划预估 412 → 410。实际多修 6 条——`Context` / `Message` 一旦精确，`tools` 与 `toolResult` 的连带 `any` 也一并消除；`tsconfig.pi-server.json` 的 `include` 由点名 `src/pi-shims.d.ts` 改为 `src/pi-shims*.d.ts` |
| B2 | 本批 | **D8 运行时真修**：`vision-bridge.ts` 新增并导出 `extractAssistantText(content: unknown)`，逐层校验（非数组 → 空串；非对象 / 非 `text` / `text` 非字符串 → 跳过），替换 `filter` + `as { text?: string }`；错误数 **404 → 404（零新增）**；新增 `tests/pi-server/vision-bridge.test.ts` 13 例（红 → 绿），并把该文件加入覆盖率 include | 计划预估 410 → 408。B1 已把类型面清零，B2 只剩运行时加固，故计数不变——这正是 D8 的本质：**类型报错消失 ≠ 运行时缺口消失** |
| B3 | 本批 | **全量 vendored shim**：新增 `src/pi-shims-tui.d.ts`（`Component` / `OverlayOptions` / `OverlayHandle` / `Terminal` / `CURSOR_MARKER` / `visibleWidth` / `KeybindingsManager` / `TUI_KEYBINDINGS`）与 `src/pi-shims-mcp.d.ts`（`authorizeMcp` / `McpOAuthProvider` / `MemoryOAuthStateStore` / `McpOAuthState`）；`pi-shims-coding-agent.d.ts` 补齐 40 个缺失导出中的 39 个（工具定义与 6 个工具工厂、`AgentSession` / `AgentMessage` / `SessionManager` / `SessionInfo` / `SessionEntry`、`createAgentSession*` 三件套、`SettingsManager` / `DefaultPackageManager` / `loadSkills`、`ExtensionAPI` / `ExtensionUIContext`、`Theme` / `initTheme`、`VERSION` / `getAgentDir` 等），形状逐字核对 `vendor/pi/packages/*/src` 与 `node_modules/@earendil-works/*/dist/*.d.ts`（1.4.0 同版）。同时**把 tests 侧 4 个 shim 的声明提升去重**（删除 `tests/pi-server-tool-shims.d.ts`、`tests/pi-server-vendored-shims.d.ts`、`tests/pi-server/session-pipeline-shims.d.ts`、`tests/pi-shims-augment.d.ts`，并清掉 `tsconfig.json` 的两条 exclude 与 `eslint.config.js` 的一条 ignore）。错误数 **404 → 27（修 377、零新增）** | 计划预估 ≈20~40。剩余 27 条**全部是真实缺陷**、且都在后续批次范围内：B4 11 条（`native-cli-session` 6 + `terminals` 2 + `index.ts` 的 `switch_engine`/`workItems` 键 3）、B5 16 条（`plugin-sdk` 13 + `device-lan` 2 + `plugin-assets` 1）。另外两处 shim 无法覆盖的收窄（`provider-oauth-flow.ts` 的 select 选项 / links）用显式局部类型处理，`tests/provider-oauth-flow.test.ts` 的 fake runtime 用显式 `as unknown as ModelRuntime` 收口 |
| B4（1/2） | `a5acce25` | **引擎剪枝死分支收尾**：`terminals.ts` 删掉恒为 false 的 `needsAuth`（入口条件简化，`connection` 恒 undefined；彻底移除 remote launch 的 `nativeCliConnection` 形参留待后续）＋ `index.ts` 的 `switch_engine` 删除「未安装全局包」不可达分支、文案改为「仅支持 pi」、移走无用的 `probeEngine` 导入；错误数 **27 → 23** | 计划 −4，实际 −4 |
| B4（2/2） | 本批 | **`native-cli-session.ts` 删除 claude / codex / agy 会话绑定**：约 220 行（claude 的 `~/.claude/projects` 扫描与 hook `--settings` 注入、codex 的 `~/.codex/config.toml` 冲突检测与 `resume` 注入、agy 的 `--conversation`），连带删除只服务于它们的 `codexSubcommand()`、`EVENTS` 常量、`glob` / `nativeCliCodexHookConflicts` 导入；`explicit` 与 observeOnly 的 `resume` 判定按 `"pi" \| "custom"` 收窄。错误数 **23 → 17**（6 条 TS2367 全清） | 计划 −6，实际 −6。`nativeCliCodexHookConflicts` 仍以导出形式留在 `native-cli-session-hooks.ts`（无引用但不属死分支，删除会动 hooks 模块与测试，另议） |
| B5 | 本批 | **零散真实缺陷收尾**：<br>① 新增 `src/plugin-sdk/index.d.ts`（上游 `pi-web-ui@0.118.0/plugin-sdk/index.d.ts` 逐字副本，710 行、0 import），并把该目录加入 `.prettierignore` 与 eslint ignores；`plugins.ts` 的 3 处 `import("../plugin-sdk/index.js")` 立即解析（13 → 0），`index.ts` 的 `workItems` 键类型也随之恢复为字符串联合（1 → 0）；<br>② `plugin-assets.ts`：`new Promise` 补 `<void>` 泛型 + 零参 resolve，修 `(value: unknown) => void` 与 `() => void` 不兼容；<br>③ `device-lan.ts`：`sockets` 由 `Set<net.Socket>` 改为 `Set<Duplex>`（https 的 connection 回调给的是 Duplex，实际只用到 `destroy()`）；<br>④ `tsconfig.pi-server.json` 关掉 `declaration` / `declarationMap`——本程序只跑 `--noEmit`，关掉后跳过「声明可移植性」检查（TS2742：3 个 device-center 导出函数返回 express app，类型经 pnpm 的 `.pnpm` 路径引用 `@types/express-serve-static-core`，属 pnpm 布局固有现象），不影响任何 strict 开关。**错误数 17 → 0** | 计划 → 0，实际 → 0。TS2742 不是代码缺陷，是声明产物在 pnpm 布局下不可命名；若将来把 pi-server 并回主程序（declaration: true），需要给这 3 个函数补显式返回类型——已记入 B6 遗留项 |
