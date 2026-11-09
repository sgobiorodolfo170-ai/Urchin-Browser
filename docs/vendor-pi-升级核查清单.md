# vendor/pi 升级核查清单（P3-2 / 风险 R1 流程化）

> 建立：2026-11-09 · 性质：**升级 `vendor/pi` 时的强制核对流程**（人工门禁，暂无自动脚本）
> 起因：`packages/pi-web-host/src/pi-shims-*.d.ts` 是**手写** ambient 声明，形状抄自 vendor 源码。
> 升级 `vendor/pi` 后它们不会自动跟随，可能出现「**编译通过但字段已改名 / 变必填**」——
> 类型检查给出虚假安全感，运行期才炸（[pi-server 后续与风险](./pi-server-后续与风险-2026-11-09.md) R1/R2 与 P3-2）。
> 关联：[pi-web 上游跟进流程](./pi-web-上游跟进流程.md)（管的是 **pi-web-ui**，另一个上游，勿混）·
> [打包核查清单](./打包核查清单.md) §3 依赖表 · AGENTS §九.4 **G17**（`pnpm check:dsh`，**只覆盖 DeepSeek Harness，不覆盖 pi**）
> 上一版真实升级记录：[CHANGELOG](../CHANGELOG.md) `v0.2.0-dev.117`（vendor/pi 1.0.0 → 1.4.0，含踩坑）

---

## 0. 事实底座（2026-11-09 实测，升级前先确认这些没变）

| 事实 | 当前值 | 为什么重要 |
| --- | --- | --- |
| 上游包版本 | `@earendil-works/pi-coding-agent` **1.4.0**（`vendor/pi/packages/*/package.json`） | 升级即改这一族版本；`pi-tui` 也是 1.4.0 |
| 入库形态 | `vendor/pi` **在版本控制内**（`git ls-files vendor/pi` = 2028 个文件），**没有 fetch/sync 脚本** | `pnpm sync:dsh` 只服务 DSH（ADR-016）；pi 走「整树替换 + 提交」，可用 `git checkout -- vendor/pi` 精确回滚 |
| workspace 成员 | 根 [pnpm-workspace.yaml](../pnpm-workspace.yaml) 含 `vendor/pi/packages/*`，**排除 `!vendor/pi/packages/tui`** | 被排除原因见 dev.117：pnpm 严格布局下 `pi-tui` 解析到未构建的 dist 导致启动 crash |
| lockfile | 根 [pnpm-lock.yaml](../pnpm-lock.yaml) 有**每个 vendor 包的 importer 段**，并含 9 条版本钉 overrides（见 §1 第 4 步） | 只换 src 不改版本时 lockfile 不该变；改版本必须同步 overrides，否则 `pnpm install` 解析回浮动版本 |
| 别名面（3 处，必须同步） | `scripts/build-pi-web.mjs`（esbuild）· `apps/desktop/vite.config.ts`（dev）· `apps/desktop/vitest.config.ts`（单测） | 别名都指向 `vendor/pi/packages/<pkg>/src`；新增/改名包时三处要一起改 |
| vendor 无 dist | `vendor/pi/packages/*` **没有 `dist/`**，`package.json` 的 `types` 指向不存在的路径 | 所以 `tsc` 只能靠 shim；能拿来交叉核对的 `dist/*.d.ts` 只有 coding-agent 的**依赖包**（`vendor/pi/packages/coding-agent/node_modules/@earendil-works/*/dist/*.d.ts`） |
| 声明面（5+1 个文件） | `pi-shims-coding-agent.d.ts`(944 行) · `pi-shims-tui.d.ts`(63) · `pi-shims-mcp.d.ts`(96) · `pi-shims.d.ts`(82, legacy) · `apps/desktop/src/types/pi-modules.d.ts`（桌面侧 5 个 `declare module`）· `src/plugin-sdk/index.d.ts`(727, 上游逐字副本) | 任务书说的「4 个 shim」指 `packages/pi-web-host/src` 侧（3 个按包拆分 + 1 个 legacy）；**桌面侧还有一个**，同样会漂移 |

---

## 1. 升级步骤（照顺序做，每步留痕）

1. **取上游并记录版本**：`git clone --depth 1 --branch <tag>`（或同版本 npm 包）。记下目标版本号 ——
   后面每一步的「预期信号」都以它为准。
2. **整树替换** `vendor/pi`（保持上游文件逐字，不要顺手格式化/裁剪）。
   ⚠ dev.117 教训：**GitHub 源码缺 `pi-ai` 的 `data/` 文件**（43 个），必须从 npm
   `pi-ai@<版本>` 的 dist 复制补齐，否则运行期缺数据表。
3. **重放本地补丁**：`vendor/pi/tsconfig.base.json` 的 `target: es2022`（上游 ES2024，esbuild 0.21 不认）。
   补丁丢失的表现是 build 阶段报 target 相关错误。
4. **同步版本钉 + 装依赖**：把根 `pnpm-lock.yaml` 的 `overrides` 里 9 条一起改到新版本：
   `pi-web-ui>@earendil-works/pi-coding-agent`、`@earendil-works/{chord, pi-agent-core, pi-ai, pi-codemode, pi-coding-agent, pi-mcp, pi-telemetry, pi-tui}@^1.0.0`
   （另有 `@earendil-works/pi-durable: workspace:*`，保持不动）。然后 `pnpm install`。
   **预期信号**：lockfile diff 只落在 `overrides` 与 `vendor/pi/packages/*` 的 importer 段；
   若出现 `apps/*`、`packages/*` 的无关变化，说明版本钉没改全或上游依赖新增了包（停下来核对）。
5. **逐项 diff shim**：按 §2 表格对每个声明核对上游源码；按 §3 的必查导出清单逐条打勾。
6. **更新 shim 头注释版本戳**：见 §4。
7. **跑 §5 全套命令**；任一红点按 §6 回滚或就地修（修 shim 时先按 §3 定位）。

---

## 2. 必须 diff 的 shim → 上游文件

| shim 文件 | 声明的模块 | 上游真源（`vendor/pi/packages/...`） | 交叉核对（dist） |
| --- | --- | --- | --- |
| `packages/pi-web-host/src/pi-shims-coding-agent.d.ts` | `@earendil-works/pi-coding-agent`（39 个导出：工具工厂 / AgentSession / SessionManager / ModelRuntime / Extension* / SettingsManager / Theme / VERSION …） | `coding-agent/src/**`（该包**无 dist**）：`core/agent-session.ts`、`core/session-manager.ts`、`core/model-runtime.ts`、`core/settings-manager.ts`、`core/agent-session-services.ts`、`core/agent-session-runtime.ts`、`core/tools/*`、`core/extensions/types.ts`、`modes/interactive/theme/theme.ts`、`config.ts` | `coding-agent/node_modules/@earendil-works/pi-ai/dist/*.d.ts`（`AssistantMessage` / `Context` / `Model` / `StopReason` 等**类型**都在 `pi-ai`） |
| `packages/pi-web-host/src/pi-shims-tui.d.ts` | `@earendil-works/pi-tui`（`Component` / `OverlayOptions` / `OverlayHandle` / `Terminal` / `CURSOR_MARKER` / `visibleWidth` / `KeybindingsManager` / `TUI_KEYBINDINGS`） | `tui/src/{tui,keys,utils,keybindings}.ts` | `coding-agent/node_modules/@earendil-works/pi-tui/dist/*.d.ts` |
| `packages/pi-web-host/src/pi-shims-mcp.d.ts` | `@earendil-works/pi-mcp/oauth`（`MemoryOAuthStateStore` / `McpOAuthProvider` / `authorizeMcp` / `OAuthTokens`） | `mcp/src/oauth/{provider,flow,types}.ts` | `coding-agent/node_modules/@earendil-works/pi-mcp/dist/*.d.ts` |
| `packages/pi-web-host/src/pi-shims.d.ts`（legacy，**未经授权不要改**） | `@earendil-works/pi-agent-core`（`Agent` / `AgentEvent` / `AgentTool` / `StreamFn`）+ `ModelRuntime` 索引签名 | `agent/src/{agent,types,stream-fn,agent-loop}.ts` | `coding-agent/node_modules/@earendil-works/pi-agent-core/dist/*.d.ts` |
| `apps/desktop/src/types/pi-modules.d.ts`（桌面侧） | `pi-agent-core` / `pi-ai` / `pi-ai/compat` / `pi-coding-agent` / `pi-tui` | 同上 + `ai/src/{types,compat}.ts` | 同上 |
| `packages/pi-web-host/src/plugin-sdk/index.d.ts` | 上游 **pi-web-ui** 的 `plugin-sdk/index.d.ts` 逐字副本 | 与 pi 无关：升级接口看 [pi-web 上游跟进流程](./pi-web-上游跟进流程.md) | — |

**diff 手法**：不要凭记忆重写。逐条打开上游文件，对声明里的每个字段核对「名字 / 必填性 / 类型」；
`any` 是刻意留的宽松锚点（R2），**不要为了让某条错误消失把字段再改成 `any`**。

---

## 3. 重点导出核对清单（每次升级必查，打勾留痕）

> 判据：**字段名 + 必填/可选 + 返回类型**三项都要对。改名的典型表现是「编译通过，运行期为 undefined」。

| # | 导出 | shim 位置 | 上游真源（2026-11-09 基线） | 核对点 |
| --- | --- | --- | --- | --- |
| 1 | `ToolDefinition` | `pi-shims-coding-agent.d.ts:216` | `coding-agent/src/core/extensions/types.ts:579` | `name` / `description` / `parameters` / `execute` 签名；上游是 `TParams extends TSchema = TSchema`，shim 故意放宽成 `TParams = any`（R2 的刻意差异，**diff 时不要「修回」TSchema**，会把 40 多处工具工厂打回红） |
| 2 | `AgentSession` | `:490` | `core/agent-session.ts` | `messages` / `model` / `settingsManager` / `sessionManager` / `sendCustomMessage` 等；**字段增删最频繁** |
| 3 | `SessionManager` | `:577`（接口）、`:625`（静态类） | `core/session-manager.ts` | `getSessionDir` / `create` / `list` / `resume`；静态成员签名 |
| 4 | `ModelRuntime` | `:153` | `core/model-runtime.ts:759`（`completeSimple`） | `completeSimple` 返回 `Promise<AssistantMessage>`；`getModel` 可能返回 `undefined`；**D8 根因就在这**（返回形状漂移） |
| 5 | `ExtensionUIContext` | `:858` | `core/extensions/types.ts:149` | `theme` / `content` 回调形状；`ui_prompt_*` 事件载荷 |
| 6 | `createAgentSession*` | `:762` / `:773` / `:783` | `core/agent-session-runtime.ts`、`core/agent-session-services.ts:135` 与 `:214` | 三个工厂的参数对象与返回类型；上游若合并/拆分工厂，这里会「编译通过但参数被忽略」 |
| 7 | `SettingsManager` | `:794` | `core/settings-manager.ts:272` | `static create(cwd, agentDir?)` / `.get` / `.set` / `.on('changed')` |
| 8 | `Theme` | `:916` | `modes/interactive/theme/theme.ts` | 本项目只读 `.name`、其余当不透明值（保留索引签名） |
| 9 | `VERSION` | `:939` | `config.ts:582` | 常量存在性（升级后应自动等于新版本） |
| 10 | `AssistantMessage` / `StopReason` | `:70` / `:26` | `ai/src/types.ts:578` / `:482` | `content` 块联合类型与 `stopReason` 枚举 —— 视觉桥 / 会话流都吃这两个 |

**额外必查（不属 shim，但同一版本面）**：

- `apps/desktop/src/main/ai/pi-providers-info.ts`：内置 provider 清单 + 数量（dev.117 时 42 个）；
  上游改名（如 1.4.0 把 `azure-openai-responses` → `azure`）会让设置页写错 model id。
- `apps/desktop/src/main/ai/pi-agent-factory.ts` 的 `PROVIDER_ID_ALIASES`（版本相关别名的唯一落点）。
- `packages/pi-web-host/src/pi-server` 的上游同源文件：本地有裁剪（R4，约 240 行死分支），
  整树替换会覆盖它们 —— 用 `git log --oneline -- packages/pi-web-host/src/pi-server` 先看本地改动面。

---

## 4. shim 头注释版本戳

| 位置 | 现状 | 升级时要做什么 |
| --- | --- | --- |
| `pi-shims-tui.d.ts:14` | 正文写死 `（1.4.0，与 node_modules/@earendil-works/pi-tui/dist/*.d.ts 同版核对）` | 改成新版本号 |
| `pi-shims-mcp.d.ts:9` | 正文写死 `（1.4.0）` | 改成新版本号 |
| `pi-shims-coding-agent.d.ts:18-21` | 只列路径与行号（`core/model-runtime.ts:759` 等），**没有版本号** | **补一行**「形状基线：@earendil-works/pi-coding-agent <版本>」；行号漂移时同步改 |
| `pi-shims.d.ts`（legacy） | 头部说明里无版本 | 未授权不改；如需动，先按 AGENTS §〇.4 请求授权 |
| `src/plugin-sdk/index.d.ts` | 来源是 **pi-web-ui@0.118.0**，与 pi 版本无关 | 不随本流程改；跟 pi-web-ui 升级走 |

> 版本戳的作用不是证明类型正确（那要靠 §2/§3 的 diff），而是**让下一次升级的人知道这份 shim 从哪一版抄来**。
> 没有它，「字段什么时候改的」只能靠 git blame 猜。

---

## 5. 升级后必跑命令与预期信号

| 命令 | 预期信号（2026-11-09 基线） |
| --- | --- |
| `pnpm install` | 无 peer 冲突错误；lockfile diff 只在 §1 第 4 步允许的范围 |
| `pnpm typecheck` | **0 错误**。有错先按错误码分流：`TS2305`（导出没了）/ `TS2339`（字段改名）/ `TS2742`（类型不可移植）→ 都属 shim 漂移，改 shim 而不改业务代码 |
| `pnpm --filter @urchin/pi-web-host exec vitest run tests/pi-server` | 全绿（当前基线 **52 文件 / 1075 例**） |
| `pnpm verify` | **exit 0**（typecheck / check:src / lint / format / 覆盖率 / 文档漂移 / DSH 六项） |
| `pnpm run build` | **exit 0** —— 这条专门证明 esbuild 三个别名仍能打真实 vendor 源码（含 `pi-server.mjs` 产物） |
| `pnpm e2e`（先 `pnpm build`） | `pi-web-host.spec` 与 omnibox 相关 spec 全绿；本机跑之前先看[共存注意事项](./开发测试与安装版共存注意事项.md)（安装版占同一把单实例锁） |
| 手工冒烟（2 分钟） | ① pi 会话能起、能出流式回复；② 视觉桥（贴图 → 转写）可用；③ native CLI 会话（`keepAlive` 远程）能重连并显示事件 |

**失败分流**：`typecheck` 红 → 先修 shim（不是业务代码）；`build` 红但 typecheck 绿 → 多半是别名或 target 补丁（§1 第 3 步）；
`e2e` 红而单测绿 → 先按[共存注意事项](./开发测试与安装版共存注意事项.md)排除环境因素，再判定回归。

---

## 6. 失败回滚

1. **未提交**：`git checkout -- vendor/pi pnpm-lock.yaml packages/pi-web-host/src apps/desktop/src/types`，
   再 `pnpm install --frozen-lockfile`。
2. **已提交未推送**：`git reset --hard <升级前 commit>`（本地历史可直接丢）。
3. **已推送**：`git revert <升级 commit>`（不改历史），并补一条提交说明「vendor/pi 回滚到 <旧版本>，
   原因：<typecheck/build/e2e 哪条红>」。
4. **只回滚 shim**：shim 与 vendor 版本解耦，单回滚 shim 会让 typecheck 立刻报错 —— 不允许只回滚一侧，
   要么一起回，要么一起留。

---

## 7. 是否值得做成门禁（**仅方案，需用户授权后才加脚本**）

> AGENTS §〇.6：新增 MUST 必须先登记可机器判定的卡点。以下都还没接。

| 方案 | 做法 | 能防什么 | 成本 / 风险 |
| --- | --- | --- | --- |
| **A. 版本戳校验**（建议先做） | `scripts/check-pi-shims.mjs`：读 `vendor/pi/packages/coding-agent/package.json` 的 `version`，与 3 个 shim 头注释里的版本戳比对；vendor 不存在（CI/未同步环境）时跳过 —— 与 G17 同款「存在才检查」 | **忘了改版本戳**（= 忘了做本清单） | 低。缺点是只证明「人动过手」，不证明形状对 |
| **B. 导出形状快照** | 从 vendor 源码抽「必查导出清单」（§3 的 10 项）的字段名集合，与仓库内一份快照比对 | 字段改名 / 变必填（真漂移） | 中高。手写 shim 有刻意的 `any` 与裁剪，误报率高；需要先定义白名单，否则会变成「天天红」 |
| **C. 契约级冒烟** | 用 fake runtime 跑 §5 的手工冒烟三条（pi 会话 / 视觉桥 / native CLI）成自动化 | 运行期行为回归 | 高。等于把 E2E 面再扩一圈，性价比要先算 |

**建议**：先只做 A（能挡住「升级后根本没看 shim」这个最高频失误），B 等下一次真实字段漂移再评估。
**未获授权前不要新增 `check:pi-shims` 或把它接进 `verify`。**

---

## 8. 本次基线快照（下次升级时对本表，不要凭记忆）

| 项 | 值（2026-11-09） |
| --- | --- |
| vendor/pi 版本 | `@earendil-works/pi-*` **1.4.0**（2026-10-21 tag v1.4.0） |
| vendor/pi 入库文件数 | 2028（`git ls-files vendor/pi`） |
| shim 面 | 4 个（944 / 63 / 96 / 82 行）+ 桌面侧 `pi-modules.d.ts` + `plugin-sdk/index.d.ts`（727 行） |
| 必查导出 | §3 的 10 项 |
| 单测基线 | `tests/pi-server`：52 文件 / 1075 例 |
| 门禁现状 | `pnpm check:dsh` **不覆盖 pi**；本清单是唯一人工门禁（R1 缺口） |