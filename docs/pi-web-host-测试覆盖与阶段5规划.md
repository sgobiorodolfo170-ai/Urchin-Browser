# pi-web-host 测试覆盖与阶段 5 规划

> 创建：2026-10-31 · 基于 glm-5.2 Loop 1-34 的完整审计
> 关联：[pi-web-host-对接实施清单](./pi-web-host-对接实施清单.md) · [AI助手与pi切割整改报告](./AI助手与pi切割整改报告.md)

## 一、测试覆盖现状

### 已覆盖模块（10/15 文件，115 测试）

| 文件 | 测试数 | 状态 |
| --- | --- | --- |
| auth.ts | ~8 | ✅ 完整 |
| http-static.ts | ~6 | ✅ 完整 |
| server.ts | ~10 | ⚠ 覆盖 HTTP+WS 基础，缺 15+ WS case |
| ws-handler.ts | ~8 | ✅ 完整 |
| file-ops.ts | 17 | ✅ 完整 |
| git-ops.ts | 11 | ✅ 完整 |
| session-store.ts | 12 | ✅ 完整 |
| plugin-permissions.ts | 16 | ✅ 完整 |
| plugin-manager.ts | 16 | ✅ 完整 |
| plugin-host.ts | 13 | ✅ 完整 |

### 未覆盖模块（5 文件）

| 文件 | 行数 | 可测试性 | 难点 |
| --- | --- | --- | --- |
| **agent-bridge.ts** | ~300 | 中 | pi SDK 是 ambient shim（any 类型），createAgentBridge 需要 mock streamFn；**createLlmProvider / resolveModel / normalizeProviderId / extractAgentEndMeta 是纯函数可测** |
| **ssh-client.ts** | ~250 | 低 | 需要真实 SSH 服务器或 ssh2 mock；**readProfiles/writeProfiles/listProfiles/deleteProfile 是纯文件操作可测** |
| **terminal.ts** | ~100 | 低 | node-pty 真实 spawn 在 CI 中 flaky；**listTerminals/disposeAllTerminals 可测（空状态）** |
| **entry.ts** | ~30 | 低 | 薄包装，server.test.ts 已覆盖集成 |
| **types.ts** | ~100 | — | 纯类型定义，无运行时逻辑 |

### server.test.ts 覆盖缺口（~15 WS case 未测）

| 缺失 case | 原因 |
| --- | --- |
| scm_status/history/filediff/commit/commitmsg | 需要临时 git 仓库 |
| terminal_create/input/resize/kill | 需要 node-pty |
| remote_ssh_probe/list_dir | 需要 ssh2 |
| plugins_reload/enable/disable/install/uninstall | 需要 fs fixtures |
| fork_session/delete_session | 需要 session fixtures |
| plugin_grants/permissions/path_response | 需要 fs fixtures |
| /plugins/:id/client/* + DOM 门禁 | 需要 manifest fixtures |
| /api/themes 返回格式 | 需要 themes 目录 fixtures |

### 测试补全优先级

| 优先级 | 目标 | 估时 | 可行性 |
| --- | --- | --- | --- |
| **P1** | agent-bridge 纯函数（resolveModel/normalizeProviderId/extractAgentEndMeta/createLlmProvider） | 1h | ✅ 不需要 mock |
| **P1** | ssh-client 文件操作（listProfiles/deleteProfile/saveProfile） | 1h | ✅ 临时目录 |
| **P2** | terminal 空状态（listTerminals/disposeAllTerminals） | 0.5h | ✅ 不 spawn |
| **P2** | server.test.ts 扩展（fork_session/delete_session/plugin WS case） | 2h | ✅ 临时目录 fixtures |
| **P3** | agent-bridge createAgentBridge（mock streamFn） | 2h | ⚠ 需 mock pi SDK |
| **P3** | ssh-client probe/listDir（mock ssh2） | 2h | ⚠ 需 mock |
| **P4** | terminal createTerminal（mock node-pty） | 1h | ⚠ 需 mock |

**总计可补：~20 测试项，~10h 工作量**

---

## 二、阶段 5 host 对象补全规划

### 现状对比

| 维度 | pi-web-ui 原版 host | pi-web-host 当前 host | 缺口 |
| --- | --- | --- | --- |
| **顶层属性** | ~15 个（cwd/dataDir/pluginsDir/conversationId/agentDir...） | 1 个（pluginId） | ~14 |
| **方法** | ~20 个（registerAgentTool/registerCommand/registerBackgroundTask/registerMarker/registerProxy/requestPermission/openSession/steer/abortRun/broadcast/sendTo/route/watch/ensureDeps/armCron/armDelay/cancelTimer...） | 5 个（registerAgentTool/registerTool/registerCommand/registerSchedule/reloadCatalog） | ~15 |
| **子对象** | ~12 个（fs/net/llm/ui/mcp/scm/models/conversations/project/services/events/chat...） | 5 个（fs/net/llm/storage/notify） | ~7 |
| **回调注册** | ~10 个（onMessage/onRunEvent/onStreaming/onStats/onToolPre/onToolPost/onConversationChanged/onCwdChange/onSettingsChanged/onClientModelChanged...） | 0 | ~10 |
| **总计** | ~169 个属性/方法（含嵌套） | ~29 个（含内部变量） | **~140** |

### 方法分类与实施策略

#### A 类：可立即实现（纯 Node.js API，无外部依赖）— 估时 ~4h

| 方法 | 实现方式 | 权限 |
| --- | --- | --- |
| `cwd` | 返回 process.cwd() | — |
| `agentDir` / `dataDir` / `pluginsDir` | 传入路径 | — |
| `conversationId` | 从 server 传入当前会话 ID | — |
| `getActiveConversation()` | 返回当前会话信息 | — |
| `execCommand(cmd, opts)` | child_process.execFile | tools |
| `watch(path, callback)` | fs.watch | fs:read |
| `glob(pattern)` | 简化 readdir + pattern match | fs:read |
| `ensureDeps(deps)` | 检查 npm 包是否存在 | — |

#### B 类：需桥接已有后端 — 估时 ~3h

| 方法 | 实现方式 | 权限 |
| --- | --- | --- |
| `scm` | 桥接 git-ops.ts | fs:read |
| `models` | 桥接 agent-bridge getProviderList | — |
| `conversations` | 桥接 session-store listSessions | — |
| `openSession(id)` | 桥接 server switch_session | — |
| `steer(msg)` | 桥接 agent.steer | — |
| `abortRun()` | 桥接 agent.abort | — |
| `prompt(text)` | 桥接 agent.prompt | — |

#### C 类：回调注册（需 server 层注入）— 估时 ~3h

| 回调 | 用途 | 实现方式 |
| --- | --- | --- |
| `onMessage(cb)` | 对话消息 | server 注入 dispatch |
| `onRunEvent(cb)` | Agent 运行事件 | agent-bridge subscribe |
| `onStreaming(cb)` | 流式输出 | agent-bridge stream.chunk |
| `onStats(cb)` | 统计 | 占位 |
| `onToolPre/onToolPost(cb)` | 工具守卫 | agent-bridge tool_execution_* |
| `onConversationChanged(cb)` | 会话切换 | server session_switched |
| `onCwdChange(cb)` | 目录变更 | server set_cwd |
| `onSettingsChanged(cb)` | 设置变更 | file-ops set_settings |
| `onClientModelChanged(cb)` | 模型变更 | server set_model |

#### D 类：需要新模块或复杂实现 — 估时 ~6h+

| 方法 | 实现方式 | 复杂度 |
| --- | --- | --- |
| `ui` | UI 插槽注册（需前端配合） | 高 |
| `mcp` | MCP 服务器桥接 | 高 |
| `chat/chatWait` | 插件间消息传递 | 中 |
| `broadcast(msg)` | 广播到所有连接 | 中 |
| `sendTo(clientId, msg)` | 定向发送 | 中 |
| `route(path, handler)` | HTTP 路由注册 | 中 |
| `registerBackgroundTask(task)` | 后台任务管理 | 中 |
| `registerMarker(name)` | 内联标记 | 中 |
| `registerProxy(config)` | 代理注册 | 高 |
| `requestPermission(req)` | 动态权限请求弹窗 | 中 |
| `events` | 事件总线 | 低 |
| `services` | 服务注册 | 中 |
| `project` | 项目信息 | 低 |

### 分阶段实施建议

| 阶段 | 内容 | 估时 | 价值 |
| --- | --- | --- | --- |
| **5a** | A 类（纯 Node API）+ B 类（桥接已有） | ~7h | 覆盖 80% 常见插件需求 |
| **5b** | C 类（回调注册） | ~3h | 插件可监听对话/工具事件 |
| **5c** | D 类（broadcast/sendTo/events/project） | ~3h | 插件间通信 |
| **5d** | D 类（ui/mcp/registerProxy/registerBackgroundTask） | ~6h+ | 高级功能，按需实现 |

### 推荐执行顺序

```
1. 测试补全 P1（agent-bridge 纯函数 + ssh-client 文件操作）→ ~2h
2. 阶段 5a（A+B 类 host 方法）→ ~7h
3. 测试补全 P2（terminal 空状态 + server.test.ts 扩展）→ ~2.5h
4. 阶段 5b（C 类回调注册）→ ~3h
5. 阶段 5c（broadcast/sendTo/events）→ ~3h
6. 测试补全 P3-P4（mock 测试）→ ~5h
7. 阶段 5d（高级功能，按需）→ ~6h+
```

**总计：~28.5h**（A+B+C 类完整 + 测试补全），5d 高级功能按需追加。

---

## 三、pi-web-host 最终源文件清单

```
packages/pi-web-host/src/
├── agent-bridge.ts         — Agent + beforeToolCall + extraTools + createLlmProvider
├── auth.ts                 — token 鉴权
├── entry.ts                — utility 入口
├── file-ops.ts             — 文件操作 + 设置 + 路径补全 + write_file + search_files
├── git-ops.ts              — Git status/history/filediff/commit/commitmsg
├── http-static.ts          — 静态文件服务
├── plugin-host.ts          — host 对象 + PluginEffectStack + LLM + 存储持久化 + DOM 门禁
├── plugin-manager.ts       — 扫描/列表/catalog/安装/卸载/激活/反激活/工具收集
├── plugin-permissions.ts   — manifest 校验 + canUse + grants + permissions + DOM consent
├── server.ts               — HTTP+WS（31+ case）+ 插件静态文件 + DOM 门禁
├── session-store.ts        — JSONL 会话持久化 + fork/delete
├── ssh-client.ts           — SSH 远程连接 + SFTP + profiles
├── terminal.ts             — node-pty PTY
├── types.ts                — WS 协议消息类型
└── ws-handler.ts           — hello/ping
```

15 个源文件 + 10 个测试文件（115 测试），覆盖 pi-web-ui 168 个 server/ 模块的核心功能 + 插件系统阶段 1-4。

---

## 四、本会话完整提交历史（20 个提交）

| 提交 | 内容 |
| --- | --- |
| `05c1b51c` | 整改代码（ai.*→pi.* 切割） |
| `7dde686c` | P0：字段名/epoch/settings 持久化/主题跟随 |
| `ecd64c0d` | P1：scm 补全/unknown_type/E2E/file_search |
| `ee50c6eb` | D2-D3：fork/delete/edit 会话操作 |
| `f679fd5e` | C2+C3：CHANGELOG + 清单更新 |
| `8517005f` | D9：scm history/filediff/commit/commitmsg |
| `45b47b13` | C1：清理 summary 孤儿代码 |
| `38aabe32` | D10：终端 node-pty PTY |
| `d2e3cbb7` | D11：SSH ssh2 远程连接 |
| `fcd315b2` | 第六批：canvas/subagent/dsh 忽略 |
| `3262d8ec` | 插件阶段 1：基础框架 |
| `93daaffc` | 插件阶段 2：激活+工具注册 |
| `3344a72d` | 插件阶段 3：权限系统 |
| `738e5d2b` | 插件阶段 4：LLM+存储持久化 |
| `ddf483db` | 插件阶段 4 剩余：DOM 门禁+net/fs+定时任务 |
| `de3b576c` | 测试补全：plugin-permissions+session-store+plugin-manager（+43） |
| `3eef9ae8` | 测试补全：file-ops（+17） |
| `7785017c` | 测试补全：git-ops+plugin-host（+24）+ git log 格式修复 |
