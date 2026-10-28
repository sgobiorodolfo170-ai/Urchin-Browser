# ADR-013 · pi 阶段 2 自研前端与托管服务（M2A 骨架落地）

> 状态：Accepted · 决策日：2026-10-28 · 关联：PH1-PH7
> 影响范围：pi 模块的用户界面承载、服务运行时、进程隔离、安全边界、阶段 1 退役路径
> 依据：[docs/pi-web-评估.md](../pi-web-评估.md) 阶段 2 规划 + [ADR-004](./ADR-004-AI进程隔离策略.md)（AI 进程隔离基线）

## 决策

pi 模块阶段 2 用**自研前端 + 自研托管服务**取代第三方社区包 `pi-web-ui`：

1. **PH1 托管形态**：托管服务 `packages/pi-web-host` 运行于 Electron `utilityProcess`（内嵌随包 Node），fork 目标 `apps/desktop/dist/main/pi-web-host.js`（CJS 单文件 bundle，dev/打包同构）。M2A 仅骨架；M2B 在此进程内接入 vendored pi SDK（`createAgentSession` / `AgentSessionRuntime` / `SessionManager`）。
2. **PH2 前端承载**：自研 `apps/pi-web`（Vite + React）构建产物由 pi-web-host 内建 HTTP 静态服务托管，以**普通网页标签**打开（`tab.create`），与浏览器主体隔离。
3. **PH3 协议**：JSON-over-WebSocket（`/ws`）。
4. **PH4 鉴权**：服务端每次启动生成 32 字节随机 token（base64url，43 字符），入口 URL 携带 `?token=`；首个有效请求回写 `HttpOnly; SameSite=Strict` Cookie；HTTP 与 WS upgrade 均校验，未授权返回 401。
5. **PH5 数据**：数据目录固定 `userData/pi/self-host`（DD1 对齐；M2B 会话 JSONL 落此）。
6. **PH6 阶段 1 去留**：M2A/M2B 期间与阶段 1（`pi-web-ui` + 注入定制层）**双轨并存**，`urchin://ai` 入口保留阶段 1 视图并提供「自研版（阶段 2）」入口；M2C 一次性整体退役阶段 1（删除依赖与注入层）。关闭标签即停服务（对齐 dsh 语义）。
7. **PH7 工具能力**：M2B 在 utility 进程内恢复 `enableTools`（官方 coding tools）——这是阶段 2 相对「M13 Agent 模式在主进程强制禁用工具」的能力解锁点，安全前提是 agent 只跑在独立 utility 进程。

## 事实更正（重要）

[docs/pi-web-评估.md §一](../pi-web-评估.md) 描述的官方「自定义前端」栈（`@earendil-works/pi-server` / `pi-client` / `pi-protocol`、`PiServer ↔ PiClient`、WebSocket/Unix ByteTransport、CBOR 帧、`session_progress`）在 **vendored pi 1.4.0 中均不存在**（全树 grep 0 命中）。1.4.0 的真实接口面是：

- **进程内 SDK**：`createAgentSession` / `AgentSessionRuntime` / `SessionManager`（Node-only，`@earendil-works/pi-coding-agent`）；
- **子进程 RPC**：`pi --mode rpc` + JSONL over stdio + `RpcClient`（Node 侧）；
- 浏览器安全面仅 `pi-ai`（含 `compat`/`models`）、`pi-agent-core`、`chord` 子集。

因此阶段 2「CBOR 官方栈 vs 轻量 JSON-over-WS」的决策**实质闭合为 JSON**（官方无 CBOR 面）。本 ADR 一并承担该事实更正的留痕。

## 候选方案与否决理由

| 方案 | 否决/采纳理由 |
| --- | --- |
| 继续沿用阶段 1（pi-web-ui） | 第三方包无 token 鉴权、含 node-pty、需大量 executeJavaScript 注入定制、每版升级需锚点比对——不满足收敛目标 |
| 官方 rpc 子进程 + 桥接（`--mode rpc`） | 多一跳进程、失进程内会话快捷控制（list/fork/switch 需走命令），桥接面更大；作为 M2B 备选，非首选 |
| 主窗口内嵌 `urchin://pi` React 协议页 | 需扩主窗口 CSP `connect-src`、接入 view-integration，主窗口风险面更大；普通标签更贴合既有隔离 |
| **采纳：utilityProcess 内嵌 + 普通网页标签** | 与 ADR-004 隔离基线一致、CSP 不侵入主窗口、退出即杀进程（零孤儿）、前端与宿主解耦 |

## 后果

### 正面
- 安全面收敛：token 鉴权内置、服务仅绑 127.0.0.1、生命周期随应用/标签。
- 定制从「注入补丁」转为「原生实现」（M2C 生效）。
- 为 M2B 解锁工具能力提供合规进程边界（ADR-004）。

### 负面 / 待办
- M2A 仅为骨架：对话/会话/模型目录/Key 管理在 M2B；阶段 1 与阶段 2 双轨期需两套维护。
- `apps/pi-web` 增加一个前端构建步骤（`scripts/build-pi-web.mjs`），打包需带 `dist/pi-web` 与 `dist/main/pi-web-host.js`。
- 打包态 pi-web-host 从 asar 内读取静态资源（utilityProcess 可读 asar）；若实测受限，M2C 切 extraResources。

## 落地清单（M2A）

- `packages/pi-web-host`：HTTP 静态 + WS（hello/ping）+ token/Cookie 鉴权 + 状态无关纯逻辑（auth/static/ws-handler/server/entry）
- `apps/pi-web`：Vite+React 骨架页（连接状态 + hello_ok 展示）
- `apps/desktop`：`pi-web-host/launcher.ts`（utilityProcess.fork + stdout 就绪 URL 解析 + 状态机 + 数据目录确保）、`register-handlers.ts`、`main/index.ts` 接线（favicon 钉定 / tab 关闭停服务 / performCleanup 0.52 dispose）、launcher-view 阶段 2 入口
- `ipc-contract`：`piWebHost.launch/status/stop`
- 测试：pi-web-host 32 单测 + desktop launcher/handlers 单测 + `tests/e2e/pi-web-host.spec.ts`

## 参考

- [docs/pi-web-评估.md](../pi-web-评估.md)（阶段 2 方向、功能取舍、升级管控）
- [ADR-004](./ADR-004-AI进程隔离策略.md)（utility process 隔离基线）
