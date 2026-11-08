# pi-web 重建台账

> 建立：2026-11-08 · 性质：执行台账（裁剪清单 / 进度 / 决策）· 关联：[pi-web-评估](./pi-web-评估.md) · [pi-web-host-对接实施清单](./pi-web-host-对接实施清单.md) · [ADR-013](./decisions/ADR-013-pi阶段2自研前端与托管服务.md) · [ADR-015](./decisions/ADR-015-pi服务常驻与入口收口.md)
> 上游对照库：`G:\pj\github\pi-web-ui`，基线版本 **0.118.0**（路径与版本登记见 [事实登记表 F9](./事实登记表.md)）

## 一、目标

1. 删除当前 `apps/pi-web` 的失败继承（旧版快照 + `server/` 参考快照 + strict 关闭 + stub）。
2. 从上游本地库重新复制前端，再按引擎裁剪。
3. 后端 `packages/pi-web-host` 保留 utilityProcess/token 壳，业务层按上游 `server/` 的 pi 引擎子集并入。
4. 前后端协议单一真源（`protocol.ts`），补齐单测 + 关键 E2E。
5. 目录收口，与主项目融合。

## 二、已确认决策（2026-11-08）

| 编号 | 决策 | 选择 |
| --- | --- | --- |
| R1 | 后端吸收方式 | **混合式**：保留 `pi-web-host` 的 utilityProcess/token/静态壳，业务层从上游 `server/` 裁剪并入 |
| R2 | 功能面保留范围 | **除其他引擎外全保留**（device-center / mobile / canvas / browser / subagents / MCP / TTS 均保留，仅引擎收窄为 pi） |
| R3 | 测试范围 | **单测 + 关键 E2E** |

## 三、引擎剥离清单（其他引擎 = dsh / claude / codex / agy / durable）

> 原则：删「引擎实现」，不删「功能面」。引擎概念渗透在 Canvas、DeviceCenter、Settings、NativeCLI 中，需按分支收窄。

### 3.1 后端 `server/`

| 动作 | 对象 | 备注 |
| --- | --- | --- |
| 删除 | `server/dsh-*.ts`、`server/dsh/` | DSH 引擎实现 |
| 删除 | `server/durable/` | durable 引擎 |
| 删除 | `server/native-cli.ts` 及其路由/前端面板 | 非 pi 原生 CLI 接管 |
| 收窄 | `server/engine-catalog.ts` | 仅 `pi` |
| 收窄 | `server/engine-cli.ts` / `engine-probe.ts` / `engine-capabilities.ts` | 仅 pi |
| 收窄 | `server/protocol.ts` | `EngineId = 'pi'`；`CanvasEngineId = 'pi'` |
| 收窄 | `server/canvas/*` | 引擎分支仅 pi |
| 收窄 | `server/device-center/*` | 功能保留，引擎固定 pi |
| 收窄 | `server/agent-service*.ts` | 仅 pi SDK 分支 |
| 移除依赖 | `@deepseek-ai/dsh-sdk-jsonrpc-server` / `@deepseek-ai/dsh-sdk-protocol` | 构建删 `build:dsh-runtime` |

### 3.2 前端 `web/src`

| 动作 | 对象 |
| --- | --- |
| 删除 | `components/DshPresetBar.tsx` / `DshPermissionBar.tsx` / `DshQuestionDialog.tsx` |
| 删除/固定 | `components/EnginePicker.tsx` |
| 删除 | `components/NativeCliPanel.tsx` / `NativeCliCreateModal.tsx` |
| 收窄 | `components/SettingsModal.tsx`：`dsh-presets` tab、DSH 插件市场、DSH 专属 questionnaire/extensions |
| 收窄 | `components/ChatInput.tsx`：`composer-dsh-perm` / `composer-dsh-preset` 槽位 |
| 收窄 | `components/LeftPanel.tsx`：DSH 预设徽标 |
| 收窄 | `present-settings.ts`：DSH 镜像 |
| 收窄 | `types.ts`（shim）对齐 `protocol.ts` |
| 保留 | DeviceCenter / Group / Mobile / BrowserControl / Plugin / MCP / Canvas / TTS（仅引擎收窄） |

## 四、目录归属

```
apps/pi-web/                    # 前端（对应上游 web/）
  src/  public/  themes/  index.html
  vite.config.ts  tsconfig.json  package.json
packages/pi-web-host/           # 后端（对应上游 server/，裁剪）
  src/
    index.ts                    # 上游入口 → utility 适配
    protocol.ts                 # ★ 协议单一真源
    agent-service.ts ...        # 上游 pi 引擎业务
    host/                       # 本项目壳：entry / auth / http-static / ws
  tests/
apps/desktop/src/main/pi-web-host/   # 集成层（launcher/IPC，保持）
docs/                                # 本台账 + 评估 + 对接清单
```

**明确**：仓库内不再保留上游源码副本（`apps/pi-web/server/` 已删除）；上游以 `G:\pj\github\pi-web-ui` 只读对照。

## 五、阶段进度

| 阶段 | 内容 | 状态 | 验证 |
| --- | --- | --- | --- |
| P0 | 文档留痕（对照库路径 / 决策 / 台账） | ✅ 完成 | 文档已更新 |
| P1 | 清空 `apps/pi-web` 旧前端并全量复制上游 `web/` | ✅ 完成 | 315 文件；前端 `typecheck` + `build` 通过 |
| P1.5 | 衔接 spike：utility 内跑通裁剪 server + token | ✅ 已完成（结论见 §七） | 确认 vendored 1.4.0 足够，无需升级 |
| P2 | 引擎剥离（前后端） | ✅ 主体完成（详见 §5.2） | 其他引擎实现已移除，仅 pi |
| P3 | 前端质量重建（strict / 死代码 / 冗余） | ✅ 完成（详见 §5.3） | `typecheck` + `build` 通过 |
| P4 | 后端接入 utility 入口 | ✅ 完成（接线骨架，详见 §5.4） | `typecheck` + 单测 + 构建 + 冒烟通过 |
| P5 | 单测 + 关键 E2E | ✅ 完成（详见 §5.5） | 前端 143 用例 + 后端 339 用例 + E2E 通过 |
| P6 | 目录收口 + 主项目回归 | ✅ 完成：launcher + handlers 已切 pi-server，E2E 通过；全量 build 启动验收待跑 | 构建 + E2E 通过 |

### 5.1 P1 完成记录（2026-11-08）

- 删除 `apps/pi-web/{src,server,dist,coverage,public,themes}` 与旧 `index.html / vite.config.ts / tsconfig.json`；备份见 `tmp/pre-rebuild-20261108-011350/`。
- 复制上游 `web/src`（315 文件）、`web/public`（10）、`web/{index.html,build-assets.ts,tsconfig.json,vite.config.ts}`、根 `themes/`（38）。
- 上游 `server/`（370 文件）并入 `packages/pi-web-host/src/pi-server/`；上游 `browser/` 仅保留 `contracts.ts`（前端实际依赖）。
- 前端对后端的共享引用统一为 `@urchin/pi-web-host/shared/*`（含 `import()` 类型位置），`browser/contracts` 为 `@urchin/pi-web-host/browser/contracts`。
- 验证：`@urchin/pi-web` typecheck 0 错误、build 成功（12.57s）；`@urchin/pi-web-host` typecheck 0 错误（`pi-server`/`browser` 暂排除，见 §七）。

### 5.2 P2 引擎剥离进度

| 对象 | 状态 | 说明 |
| --- | --- | --- |
| `components/EnginePicker.tsx` | ✅ 已收窄 | `SUPPORTED_ENGINES` 只留 `pi`，删除 dsh/claude/codex/durable 条目 |
| `components/DshPresetBar.tsx` / `DshPermissionBar.tsx` | ✅ 保留（非 DSH 专属） | 名为 dsh，实为 pi 也在用的「Agent 预设 / 权限」通用组件；**不删** |
| `components/SettingsModal.tsx` | ✅ 已收窄 | `isDsh` 固定 false，DSH 插件市场/预设/问卷分区不再启用（JSX 物理删除留待 P3 清理） |
| `components/NativeCliPanel.tsx` / `NativeCliCreateModal.tsx` | ✅ 已收窄 | 经共享 `ENGINE_CATALOG` 收窄，CLI 面板自动仅 pi（面板保留） |
| `components/canvas/*` | ✅ 已收窄 | `CanvasEngineId = "pi"`；`CanvasTypes`/`CanvasNodeCard`/`canvas-state` 移除其他引擎 |
| `use-chat.ts` / `app-globals.ts` | ✅ 已收窄（P3） | 删除 `ChatState.dsh/dshPatches/dshMarket`、DSH reducer/socket 分支；`engine` 恒为 pi |
| 后端 `pi-server` 引擎模块 | ✅ 已删除 | `dsh/`、`durable/`、`universal/`（外部 CLI 驱动）移除；`engine-probe`/`index.ts`/`client-state`/`model-resolver` 收窄为仅 pi |
| 构建依赖 | ✅ 已清理 | 全树已无 `@deepseek-ai/*` 引用（原 dsh/ 目录整体删除） |

> 验证（2026-11-08）：`pi-server/index.ts` ESM bundle 成功（无悬空 import）；`@urchin/pi-web-host` typecheck 0 错误；`@urchin/pi-web` build 成功（7.76s）。

### 5.3 P3 前端质量重建记录（2026-11-08）

- `SettingsModal.tsx`：删除 DSH 插件市场整块（约 424 行）、`dsh-presets` 分区（65 行）、DSH 自定义提示词分支（225 行）、`question` 问卷分区；清理 `isDsh` 守卫与相关状态/关键词映射。
- `use-chat.ts` / `app-globals.ts`：删除 `ChatState.dsh/dshPatches/dshMarket`、DSH reducer/socket 分支；`engine` 恒为 pi。
- 保留 `DshPresetBar` / `DshPermissionBar`（pi 共用的 Agent 预设/权限组件）。
- 验证：`@urchin/pi-web` typecheck 0 错误、build 7.48s。

### 5.4 P4 后端接线记录（2026-11-08）

- `pi-server/index.ts`：顶层脚本收敛为 `startPiServer(options)`（幂等、import 无副作用、`close()` 不退出进程）；上游业务逻辑逐行保留。
- 新增 `pi-server/urchin-entry.ts`（默认关闭，`PI_HOST_PI_SERVER=1` / `--pi-server=1` 启用）与 `src/pi-server-ready.ts`（就绪行契约，与轻量壳同构）。
- `scripts/build-pi-web.mjs`：新增 ESM 产物 `dist/main/pi-server.mjs`；CJS 壳产物不变。
- 验证：typecheck 0、单测 14 文件通过（307）、构建成功（host 13.96MB + pi-server 20.05MB）、`/api/health` 200、旧 CJS 壳回归正常。
- 后续联调（P6）：desktop launcher 以 `utilityProcess.fork('dist/main/pi-server.mjs')` 启动，用 `PI_SERVER_READY_LINE_RE` 解析端口/token；`PI_WEB_SKIP_PI_SERVER=1` 可跳过该构建步骤。

### 5.5 P5 测试补齐记录（2026-11-08）

- 前端 `apps/pi-web`：新增 `vitest.config.ts`（node 环境 + `@urchin/pi-web-host/shared` 别名）；从上游复制并适配 9 个纯模块测试，**143 用例通过**。
- 后端 `packages/pi-web-host`：新增 `engine-probe.test.ts`（仅 pi 的引擎目录/探测/拒绝卸载）与 `pi-server-ready.test.ts`（就绪行跨 chunk 正则 + URL 拼装），**累计 16 文件 / 339 用例通过**。
- E2E：`apps/desktop/tests/e2e/pi-web-host.spec.ts` 通过（启动 → 鉴权 URL → 前端加载 → WS 握手 → 退出杀进程，27.8s）。
- 已知待收口：`src/pi-shims.d.ts` 缺 `export const VERSION: string;`，测试侧用 `tests/pi-shims-augment.d.ts` 临时声明合并；建议后续补到 src 后删除该文件。

### 5.6 P6 desktop 接线记录（2026-11-08）

- `apps/desktop/src/main/pi-web-host/launcher.ts`：新增 `serverKind: 'legacy' | 'pi-server'`；pi-server 模式生成 32 字节 base64url token（43 字符）、传 `--port=0/--www-dir/--data-dir/--cwd/--token`、注入 `PI_HOST_PI_SERVER=1` 与 `PI_CODING_AGENT_DIR`，并解析 `pi-server ready:` 就绪行。
- `apps/desktop/src/main/bootstrap/handlers.ts`：默认切到 pi-server（`URCHIN_PI_SERVER=legacy` 可回退轻量壳）。⚠ 该文件同时含用户未提交的 Logs 改动，本次未提交。
- `packages/pi-web-host/src/pi-server/index.ts`：control socket 改用**实际绑定端口**，修复端口 0 时固定 `\\.\pipe\pi-web-ui-0` 撞名。
- `urchin-entry.ts`：就绪行改用 `console.log`（utilityProcess 下 `process.stdout.write` 实测不落盘）。
- 验证：desktop typecheck 0、launcher/register-handlers 单测通过、`pi-web-host.spec.ts` E2E 4.6s 通过（launch → 43 token URL → 200/401 → 页面 → WS → 退出）。
- 遗留：pi-server 的模型/凭据由前端设置页写入 `PI_CODING_AGENT_DIR`（auth/models），旧 `pi.*` 设置不自动迁移；打包清单需登记 `dist/main/pi-server.mjs`。

## 七、SDK 版本核查结论（2026-11-08，已澄清）

初判「上游 0.118 依赖更新版 SDK、与 vendored 1.4.0 不兼容」**不成立**，已实测澄清：

| 核查项 | 结论 |
| --- | --- |
| 上游 0.118 lockfile 锁定版本 | `@earendil-works/pi-{coding-agent,ai,agent-core,tui}` = **1.1.0**；`pi-mcp` = 1.4.0 |
| vendored pi 版本 | **1.4.0**（>= 上游所需 1.1.0） |
| 上游使用的 API | `AgentSession`、`createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime`、`resolveModelScopeWithDiagnostics`、`createEditToolDefinition` 等 |
| vendored 1.4.0 是否具备 | **全部具备**（`packages/coding-agent/src/index.ts` 已导出） |
| 2806 个 typecheck 错误的真实原因 | tsconfig `paths` 直接指向 vendor `.ts` 源码，TypeScript 无法处理其 `.ts` 扩展导入与自有 strict 设置 |
| esbuild spike | `agent-service.ts` **打包成功**；`index.ts` 仅因 CJS 不支持 top-level await 失败（改用 ESM 或拆分入口即可） |

**结论**：无需升级或降级 vendored pi。沿用项目既有策略——typecheck 用 `pi-shims.d.ts` ambient 声明，运行时用 esbuild 打包真实 vendor 源码（`build-pi-web.mjs` 的 `piAliases`）。`pi-server` 参与 bundle，不参与 tsconfig 全量检查（其类型由前端共享模块的窄面覆盖）。

若后续确需 pi 1.5.0（npm latest）的新特性，作为独立升级任务处理，不作为本次重建的前置条件。

## 六、回退与安全

- 删除前已备份到 `tmp/pre-rebuild-<时间戳>/`（含 `apps-pi-web/` 与 `packages-pi-web-host/`）。
- 回退方式：从备份目录恢复，或 `git checkout -- apps/pi-web packages/pi-web-host`（仅限已提交部分）。
- 每阶段独立提交，禁止跨阶段累积错误。