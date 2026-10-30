# pi 阶段 2 后端对接实施清单（跨会话交接文档）

> 创建：2026-10-29 · 本会话（glm-5.2 Loop 1-11）的完整上下文压缩 + 后续批次实施清单
> 关联：ADR-013、docs/pi-web-评估.md 阶段 2、host-bridge.ts、packages/pi-web-host/
>
> **状态更新（2026-10-30）**：
> - 第二批（工具审批/路径补全/上下文压缩/Goal-Plan/更新检查）：✅ 已完成（`f16dca5b` + `63223cac`）
> - 第三批首批（Git 面板/write_file/search_files/set_cwd/技能市场）：✅ 已完成（`3c5e818a` + `3d28a927`）
> - P0 修复（字段名/epoch/settings 持久化/主题跟随）：✅ 已完成（`7dde686c`）
> - P1 修复（scm_data 补全/unknown_type 消除/E2E 断言）：✅ 已完成（`ecd64c0d`）
> - 第四批 D2-D3（fork/delete/edit 会话操作）：✅ 已完成（`ee50c6eb`）
> - ai.*→pi.* 切割整改：✅ 已完成（`05c1b51c`，见 [AI助手与pi切割整改报告](./AI助手与pi切割整改报告.md)）
> - 第三批剩余（终端/SSH/插件/DSH/MCP/子代理/Canvas）：❌ 仍未做

## 本会话已完成的工作（Loop 1-11）

### 提交历史（origin/main 同步）

| 提交 | 内容 |
| --- | --- |
| `1b5b9f82` | M2A 骨架：pi-web-host（HTTP+WS+token）+ apps/pi-web 空壳 + ADR-013 |
| `a727c88e` | M2B-1：Agent 桥（pi-agent-core + streamSimple）+ prompt/abort/stream |
| `e15bb2d9` | M2B-2：前端对话 UI（流式渲染） |
| `3a462b25` | M2B-3a：模型目录展示（list_models + hello_ok 携带 provider/model） |
| `58568c2f` | M2B-3b：会话持久化（JSONL）+ 列表/新建/切换 |
| `90b493ce` | M2B-4：工具能力恢复（bash/read/edit/write）+ 工具卡片 |
| `9aa8f8af` | M2C：退役 pi-web-ui + 注入层（后回滚，改为全量继承） |
| `033722b9` | 全量继承 pi-web-ui 前端（87 组件 + 125 逻辑文件 + server/） |
| `2470114e` | E2E 适配 + __BUILD_ID__ define |
| `c8d614e8` | 修复黑屏：html-to-image/mermaid/vis-timeline/@xterm 从 external 移除 |
| `ded6cea1` | 第一批后端对接：心跳/主题/设置/文件浏览/模型管理 |

### 架构现状

```
Urchin Browser (Electron)
├─ main/index.ts
│  ├─ piWebHostLauncher (utilityProcess.fork)
│  │   └─ forkTarget: dist/main/pi-web-host.js (esbuild CJS bundle)
│  ├─ piWebHost.launch/status/stop IPC (ipc-contract zod)
│  ├─ favicon 钉定 (urchin://pi-icon)
│  └─ performCleanup 0.52 dispose
│
├─ packages/pi-web-host/ (utility 进程内运行)
│  ├─ server.ts — HTTP 静态 + WS + token 鉴权 + 主题路由 (/themes/*.css, /api/themes)
│  ├─ agent-bridge.ts — Agent 构造（pi-agent-core + pi-ai/compat + pi-coding-agent tools）
│  │   └─ 事件映射：stream.chunk / stream.end / tool_call / error
│  ├─ session-store.ts — JSONL 会话持久化（persistExchange / listSessions / loadSessionMessages）
│  ├─ file-ops.ts — list_files / read_file / get_settings / set_settings
│  ├─ entry.ts — utility 入口（argv/env 解析 → startPiWebHostServer）
│  ├─ types.ts — WS 协议 v0 消息类型
│  ├─ auth.ts — 32B token + Cookie 鉴权
│  ├─ http-static.ts — 静态文件服务（路径遍历防护）
│  ├─ ws-handler.ts — hello/ping 无状态处理
│  └─ pi-shims.d.ts — vendored pi ambient 类型 shim（typecheck 用，esbuild 打真实源码）
│
├─ apps/pi-web/ (Vite + React 19 前端，全量继承 pi-web-ui)
│  ├─ src/host-bridge.ts — ★协议适配层★
│  │   └─ 维护合成 UiState，双向翻译：
│  │       pi-web-host WS ↔ pi-web-ui ServerMessage/ClientMessage
│  │       hello_ok → ready + snapshot
│  │       stream.chunk → streamingMessage 更新 → snapshot
│  │       stream.end → 定稿 → snapshot
│  │       tool_call → toolCallBlock → snapshot
│  │       models → models ServerMessage
│  │       session_list → conversations ServerMessage
│  │       files/file_content/settings_state → 透传
│  │       心跳 30s 定时器
│  │       sendInitialEmpties()：commands/widgets/statuses/scm/goal/plugins 等
│  ├─ src/use-chat.ts — pi-web-ui 原版 useChat hook（3263 行，HostBridgeWebSocket 替换 WebSocket）
│  ├─ src/App.tsx — pi-web-ui 原版主应用（3000+ 行）
│  ├─ src/components/ — 87 个 pi-web-ui 组件
│  ├─ server/ — 168 个 pi-web-ui server 文件（protocol.ts 纯类型被 include）
│  ├─ src/server-stubs.d.ts — server 模块 ambient 类型 stub
│  ├─ themes/ — 34 个主题 CSS 文件
│  └─ vite.config.ts — base './', external 仅 @pi-web-ui/plugin-sdk/client
│
└─ scripts/build-pi-web.mjs — esbuild host bundle + vite build 前端 + 复制 themes
```

### 第一批已对接（host-bridge + pi-web-host）

| 功能 | 状态 | 实现位置 |
| --- | --- | --- |
| 对话流式渲染 | ✅ | host-bridge stream.chunk → snapshot |
| 工具调用卡片 | ✅ | host-bridge tool_call → toolCallBlock |
| 会话列表/新建/切换 | ✅ | session-store.ts + host-bridge |
| 模型 Provider 列表 | ✅ | agent-bridge getProviderList |
| 心跳 | ✅ | host-bridge 30s 定时器 |
| 主题文件 | ✅ | server.ts /themes/*.css + /api/themes |
| 设置持久化 | ✅ | file-ops.ts get/set_settings → JSON 落盘 |
| 文件浏览 | ✅ | file-ops.ts list_files/read_file |
| 模型切换 | ✅ | host-bridge set_model/set_thinking_level |
| 初始空响应 | ✅ | sendInitialEmpties()：commands/widgets/statuses/scm/goal/plugins/mcp/scheduler/bg_servers |

---

## 第二批：工具能力增强（待实施）

### 2-1. 工具审批（tool_approval）

**前端期望**：
- ServerMessage: `{type: "tool_approval_pending", toolCallId, toolName, args, conversationId}`
- ServerMessage: `{type: "tool_approval_resolved", toolCallId, approved}`
- ClientMessage: `{type: "approve_tool", toolCallId, approved}`

**后端缺失**：pi-web-host 的 Agent 直接执行工具，无审批拦截。

**实施方案**：
1. agent-bridge.ts：在 `tool_execution_start` 事件前插入审批门——发送 `tool_approval_pending`，暂停 agent 执行等待前端批准
2. pi-web-host WS：新增 `approve_tool` 消息处理，恢复 agent 执行
3. host-bridge.ts：透传 `tool_approval_pending`/`tool_approval_resolved`，转发 `approve_tool`
4. **难点**：pi Agent 的 `Agent.subscribe` 是事件驱动的，没有原生「暂停执行」API。可能需要在 tool execution 前用 Promise 阻塞——这需要研究 pi SDK 是否支持工具执行拦截器

**替代方案**（如果 pi SDK 不支持拦截）：在 host-bridge 层面模拟——收到 `tool_execution_start` 后发 `tool_approval_pending`，收到 `approve_tool` 后发 `tool_approval_resolved`（纯 UI 层面，不真正暂停 agent）。这样前端审批按钮可见但无实际拦截效果。

### 2-2. 上下文压缩（compacted_messages）

**前端期望**：
- ServerMessage: `{type: "compacted_messages_result", messages, tokensBefore}`
- ClientMessage: `{type: "compact", customInstructions?}`

**后端缺失**：pi Agent SDK 有 `agent.compact()` 方法。

**实施方案**：
1. pi-web-host WS：新增 `compact` 消息处理 → 调用 agent.compact() → 返回 `compacted_messages_result`
2. host-bridge.ts：转发 `compact` ClientMessage，透传 `compacted_messages_result`
3. agent-bridge.ts：暴露 `compact()` 方法

### 2-3. Goal/Plan 模式

**前端期望**：
- ServerMessage: `{type: "goal_status", goal}`
- ServerMessage: `{type: "plan_updated", conversationId, plan}`
- ClientMessage: `{type: "start_goal", ...}`, `{type: "update_plan", ...}`

**后端缺失**：pi SDK 有 goal mode 和 plan mode（见 pi-web-ui server/goal-evidence.ts, plan-manager.ts）。

**实施方案**：
1. 从 pi-web-ui server/ 复制 goal/plan 管理逻辑到 pi-web-host
2. 或简化：host-bridge 维护 goal/plan 状态（纯前端态），收到 start_goal 时设状态 + 发 goal_status
3. plan_updated：agent 执行 plan_update 工具时，在 tool_call 中识别并更新 plan 状态

### 2-4. 更新检查（update_status）

**前端期望**：
- ServerMessage: `{type: "update_status", update}`, `{type: "update_status_all", updates}`
- ClientMessage: `{type: "check_update"}`, `{type: "check_updates_all"}`

**后端缺失**：无更新检查后端。

**实施方案**：
1. host-bridge.ts：收到 check_update → 发 synthetic `{type: "update_status", update: null}`（无更新）
2. 同理 check_updates_all → `{type: "update_status_all", updates: []}`
3. 这是最简单的对接——纯 synthetic 空响应

### 2-5. 路径补全（path_completions）

**前端期望**：
- ServerMessage: `{type: "path_completions", completions}`
- ClientMessage: `{type: "complete_path", partial}`

**实施方案**：
1. file-ops.ts：新增 `complete_path` 处理——readdir 匹配前缀
2. host-bridge.ts：转发 + 透传

---

## 第三批：重功能（需 Node 原生模块或复杂后端）

### 3-1. 终端（node-pty + xterm.js）

**前端期望**：
- ServerMessage: `terminal_add` / `terminal_remove` / `terminal_output` / `terminal_exit` / `terminal_list` / `terminal_active`
- ClientMessage: `terminal_create` / `terminal_input` / `terminal_resize` / `terminal_restart`

**后端缺失**：需要 PTY 后端。

**实施方案**：
1. pi-web-host 安装 `node-pty` 依赖
2. 新建 `packages/pi-web-host/src/terminal.ts`：
   - `createTerminal(cwd)` → spawn pty → 返回 terminalId
   - 监听 pty data → WS `terminal_output`
   - pty exit → WS `terminal_exit`
   - `input(terminalId, data)` → pty.write(data)
   - `resize(terminalId, cols, rows)` → pty.resize()
3. server.ts WS：新增 terminal_* 消息处理
4. host-bridge.ts：转发 terminal_* ClientMessage，透传 terminal_* ServerMessage
5. **打包注意**：node-pty 是原生模块，需要 `electron-rebuild` 或保持 Node ABI。pi-web-host 跑在 utility 进程（Electron 内置 Node），node-pty 需要编译为 Electron ABI。
6. **esbuild**：node-pty 需要 external（不能 bundle 原生模块）

### 3-2. Git 面板（scm_*）

**前端期望**：
- ServerMessage: `scm_data`（changed/staged/branches/currentBranch）/ `scm_changed`
- ClientMessage: `scm_status` / `scm_stage` / `scm_unstage` / `scm_commit` / `scm_branch`

**后端缺失**：需要 git CLI 调用。

**实施方案**：
1. 新建 `packages/pi-web-host/src/git-ops.ts`：
   - `getStatus(cwd)` → 执行 `git status --porcelain` + `git branch` + `git diff --staged`
   - `stage(cwd, files)` → `git add`
   - `unstage(cwd, files)` → `git reset HEAD`
   - `commit(cwd, message)` → `git commit -m`
   - `branch(cwd, action, name)` → `git checkout -b` / `git checkout`
2. server.ts WS：新增 scm_* 消息处理
3. host-bridge.ts：转发 scm_* ClientMessage，透传 scm_* ServerMessage
4. **文件监听**：用 `chokidar` 或 `fs.watch` 监听 .git 目录变化 → 发 `scm_changed`

### 3-3. SSH 远程（ssh2）

**前端期望**：
- ServerMessage: `remote_ssh_probe_result` / `remote_ssh_list_dir_result` / `remote_ssh_install_result` / `remote_ssh_profiles_result`
- ClientMessage: `remote_ssh_probe` / `remote_ssh_list_dir` / `remote_ssh_install` / `remote_ssh_save_profile`

**后端缺失**：需要 SSH 客户端。

**实施方案**：
1. pi-web-host 安装 `ssh2` 依赖
2. 新建 `packages/pi-web-host/src/ssh-client.ts`：
   - `probe(host, port, user, auth)` → 连接 + 检测环境
   - `listDir(path)` → SFTP readdir
   - `installDeps()` → apt/yum install
3. server.ts WS：新增 remote_ssh_* 消息处理
4. **esbuild**：ssh2 需要 external（原生模块）

### 3-4. 插件系统

**前端期望**：
- ServerMessage: `plugins` / `plugin_catalog` / `plugin_grants` / `plugin_permissions` / `plugin_job` / `plugin_updates` / `plugin_install_inspect_result` 等
- ClientMessage: `plugin_install` / `plugin_uninstall` / `plugin_enable` / `plugin_disable` / `plugin_permission_request` 等

**后端缺失**：需要完整的插件宿主。

**实施方案**：
1. 从 pi-web-ui server/ 复制插件相关文件（plugins.ts, plugin-catalog.ts, plugin-dom.ts, plugin-facilities.ts, plugin-grants.ts, plugin-permissions.ts, plugin-schedule.ts 等）
2. 在 pi-web-host 中加载并管理插件
3. **复杂度高**：插件系统依赖文件系统、DOM 注入、权限管理——建议后续单独评估

### 3-5. DSH 引擎桥接

**前端期望**：
- ServerMessage: `dsh_patches` / `dsh_market_data` / `dsh_presets` / `dsh_permission`
- ClientMessage: DSH 相关操作

**后端缺失**：需要 DSH SDK 集成。

**实施方案**：
1. Urchin 已有 dsh launcher（apps/desktop/src/main/deepseek-harness/）
2. 可在 pi-web-host 中桥接 DSH：收到 DSH 相关消息 → 转发给 dsh web 服务
3. 或直接用 @deepseek-ai/dsh-sdk-jsonrpc-server

### 3-6. MCP 服务器

**前端期望**：
- ServerMessage: `mcp_servers` / `mcp_market_result`
- ClientMessage: `mcp_manage` 等

**实施方案**：
1. 从 pi-web-ui server/ 复制 MCP 相关逻辑
2. 或用 @earendil-works/pi-mcp 包直接管理

### 3-7. 技能市场（skills）

**前端期望**：
- ServerMessage: `skill_market_result` / `skill_content_result`

**实施方案**：
1. 从 pi-web-ui server/ 复制 skill-catalog.ts
2. 简化：返回空目录（后续逐步填充）

### 3-8. 子代理（subagents）

**前端期望**：
- ServerMessage: `subagent_handoff`

**实施方案**：
1. pi SDK 支持子代理（SUBAGENT_TOOL_NAME）
2. agent-bridge.ts：识别 subagent 工具调用 → 发 `subagent_handoff`

### 3-9. Canvas（画布）

**前端期望**：CanvasStudio.tsx 组件

**实施方案**：
1. 从 pi-web-ui server/ 复制 canvas-store.ts / canvas-cards.ts
2. 或简化：host-bridge 返回空 canvas 状态

### 3-10. 定时任务（scheduler）

**前端期望**：
- ServerMessage: `scheduler_tasks`

**实施方案**：
1. 从 pi-web-ui server/ 复制 scheduler-tasks.ts
2. 或简化：host-bridge 返回空任务列表（当前 sendInitialEmpties 已返回空）

---

## 跨会话交接钩子

### 关键文件（修改优先级排序）

1. **`apps/pi-web/src/host-bridge.ts`** — 协议适配层核心，所有新功能都在这里扩展翻译逻辑
2. **`packages/pi-web-host/src/server.ts`** — WS 消息处理入口，新增 case 分支
3. **`packages/pi-web-host/src/file-ops.ts`** — 文件操作，可扩展为通用后端操作模块
4. **`packages/pi-web-host/src/agent-bridge.ts`** — Agent 事件映射，工具审批/压缩等在此扩展
5. **`packages/pi-web-host/src/types.ts`** — WS 协议消息类型定义
6. **`packages/pi-web-host/src/session-store.ts`** — 会话持久化
7. **`apps/pi-web/src/use-chat.ts`** — pi-web-ui 前端 useChat hook（3263 行），参考其 case 分支了解前端期望的所有消息类型

### 关键技术约束

1. **esbuild bundle**：pi-web-host 用 esbuild 打 CJS bundle，pi 源码用 alias 指向 vendor/pi/packages/*/src，`import.meta.url` 用 banner+define 垫片
2. **pi-shims.d.ts**：typecheck 用 ambient shim（any），运行时 esbuild 打真实源码；新增 pi import 时需同步更新 shim
3. **server-stubs.d.ts**：前端引用 server 模块的类型 stub；新增 server import 时需同步更新
4. **vite.config.ts external**：仅 `@pi-web-ui/plugin-sdk/client` external；其他所有包必须安装为依赖（bare specifier 在浏览器中不可用）
5. **@ts-nocheck 文件**：8 个 pi-web-ui 文件因 strict 类型不兼容加了 @ts-nocheck（TermXterm/PresentedFiles/RightPanel/file-transfer/remark-backslash-math/ModelConfigModal/PresetShareModal/TuiOverlayModal）
6. **eslint 排除**：apps/pi-web/** 被排除出 eslint（pi-web-ui 自带 oxlint 工具链）
7. **native 模块**：node-pty/ssh2 等原生模块需要 external + electron-rebuild
8. **verify 流程**：`pnpm verify` = typecheck + lint + format:check + test:coverage + check:docs + mark-verify-ok；commit 后需重跑 verify 刷新指纹才能 push

### 前端消息类型完整清单（use-chat.ts case 分支）

**ClientMessage（前端 → 后端，共 ~50 种）**：
hello, prompt, abort, steer, follow_up, edit_message, get_state, set_model, cycle_model, set_thinking_level, compact, set_auto_compaction, list_models, fetch_models, test_model_connection, enrich_models, refresh_provider, refresh_builtin, append_builtin, clone_provider, install, uninstall, list_files, read_file, write_file, search_files, complete_path, list_sessions, new_chat, switch_conversation, fork_conversation, delete_conversation, set_cwd, set_workspace_roots, get_commands, list_commands, terminal_create, terminal_input, terminal_resize, terminal_restart, scm_status, scm_stage, scm_unstage, scm_commit, scm_branch, check_update, check_updates_all, plugin_install, plugin_uninstall, plugin_enable, plugin_disable, approve_tool, start_goal, update_plan, remote_ssh_probe, remote_ssh_list_dir, remote_ssh_install, remote_ssh_save_profile, set_settings, get_settings, mcp_manage, skill_market, skill_content, sandbox_create, sandbox_remove, worktree_create, worktree_remove, page_request, dismiss_conversation, present_files, ask_user_question_response

**ServerMessage（后端 → 前端，共 ~100 种）**：
ready, snapshot, snapshot_delta, earlier_messages, message_delta, tool_delta, tool_status, tool_approval_pending, tool_approval_resolved, question_pending, question_retracted, elsewhere_question, heartbeat, engines_status, sessions, conversations, projects, sandbox_diff, files, file_changed, file_content, file_search_result, session_search_results, models, models_config, providers_status, provider_keys, default_model, provider_oauth_started, provider_oauth_flows, provider_oauth_prompt, provider_oauth_event, provider_oauth_result, provider_oauth_logout_result, fetch_models_result, test_model_connection_result, enrich_models_progress, enrich_models_result, refresh_provider_result, refresh_builtin_result, append_builtin_result, clone_provider_result, install_result, scm_data, scm_changed, search_files_result, tool_info, tool_prompt, compacted_messages_result, path_completions, update_status, update_status_all, updates_check_started, widgets, statuses, dialog, dialog_closed, tui_overlay_open, tui_overlay_render, tui_overlay_close, question_pending, tool_approval_pending, tool_approval_resolved, question_retracted, elsewhere_question, page_request, terminal_output, terminal_exit, terminal_list, terminal_add, terminal_remove, terminal_restart, terminal_active, transition_start, transition_progress, transition_tick, transition_clear, commands, slash_commands, goal_status, plan_updated, settings_state, mcp_servers, mcp_market_result, skill_market_result, skill_content_result, bg_servers, scheduler_tasks, plugin_panel_items, plugins, plugin_updates, plugin_catalog, plugin_grants, plugin_permissions, plugin_permission_request, plugin_permission_resolved, plugin_path_request, plugin_dom_consent_request, plugin_job, plugin_install_inspect_result, plugin_catalog_sync_result, preset_export_result, preset_import_result, preset_catalog_result, preset_share_result, dsh_patches, dsh_market_data, dsh_presets, dsh_permission, plugin_data, remote_ssh_probe_result, remote_ssh_list_dir_result, remote_ssh_install_result, remote_ssh_profiles_result, subagent_handoff, notice, dismiss_notice, compacted_messages_result, page_request

### 实施顺序建议

1. **第二批**（工具能力增强）：2-4 更新检查 → 2-1 工具审批 → 2-2 上下文压缩 → 2-3 Goal/Plan → 2-5 路径补全
2. **第三批**（重功能）：3-1 终端 → 3-2 Git → 3-7 技能市场/3-10 定时任务（简单） → 3-6 MCP → 3-4 插件 → 3-3 SSH → 3-5 DSH → 3-8 子代理 → 3-9 Canvas
3. **每批完成后**：pnpm verify + pnpm e2e + 实机验收 + 提交推送

### 验证命令

```bash
pnpm verify          # typecheck + lint + format + test:coverage + check:docs
pnpm e2e             # Playwright E2E（pi-web-host.spec.ts 是核心）
pnpm --filter @urchin/desktop build  # 完整构建（含 build:pi-web）
pnpm --filter @urchin/desktop build:pi-web  # 仅构建 pi-web-host bundle + 前端
pnpm start           # 启动应用实机验收
```

### 已知问题

1. **pi-web-ui server/ 包含在 tsconfig include**：`server/protocol.ts` 被前端 typecheck include（纯类型，无运行时副作用）。但 `server/approval-rules.ts` 和 `server/atomic-file.ts` 有 `node:fs` import——type-only import 被正确擦除，但如果新增非 type-only import 会引入 Node 依赖
2. **8 个 @ts-nocheck 文件**：pi-web-ui 原有 strict 类型与本项目 tsconfig 不完全兼容
3. **E2E flaky**：bookmark-panel-visibility.spec.ts 和 pi-web-launcher.spec.ts（已删除）有 flaky 行为
4. **前端 bundle 大**：2622KB JS（gzip 826KB）——后续可做 code-splitting
5. **host-bridge.ts readyState**：用 `Object.defineProperty` + `declare` 实现，TypeScript 不完全识别
