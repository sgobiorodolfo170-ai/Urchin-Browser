# pi-web 生态依赖引入审查与效果评估(阶段 0 留痕)

> 日期:2026-08-22 · 关联决策:用户指令「pi 模块 = 定制前端网页版 UI + pi 官方源码(可更新),前端优先直接调用 pi 原有接口;与浏览器主体隔离;现有前端入口退化为启动器」
> 依据:AGENTS.md §九 依赖引入审查(包名验证 / 版本可达性 / 许可证兼容性 / 维护度评估)

## 一、官方架构事实(vendored 0.84.2 核验)

| 包 | 浏览器安全 | 角色 |
| --- | --- | --- |
| `@earendil-works/pi-client` | ✅(上游 `check:browser-smoke` CI 保证) | 官方客户端 SDK,自备 ByteTransport(WebSocket 等) |
| `@earendil-works/pi-protocol` | ✅(仅依赖 typebox,零 node: 导入) | CBOR 帧 + 消息 schema(hello / request / event / snapshot) |
| `@earendil-works/pi-ai`(根入口) | ✅ | 统一 LLM API、模型目录(`models.generated.ts` + `providers/data/*.json`) |
| `@earendil-works/pi-agent-core` | ✅ | Agent 运行时、AgentEvent 流 |
| `@earendil-works/pi-server` | ❌ Node | 传输无关 CBOR 服务(PiServer + 自实现 PiServerService) |
| `@earendil-works/pi-coding-agent` | ❌ Node | AgentSession SDK、SessionManager(JSONL 会话)、RPC 模式 |

官方「自定义前端」路径:Node 侧 `PiServer` ↔ 浏览器侧 `PiClient`(WebSocket/Unix ByteTransport),快照权威 + `session_progress` 流式增量;配套 `RemoteSession`/transcript 视图模型。**上游标记 experimental、无兼容性承诺**——本项目 vendored 锁定版本,更新节奏由本项目控制,风险可控。

## 二、候选社区包审查

| 项 | pi-web-ui | pi-web-chat |
| --- | --- | --- |
| npm 包名 | `pi-web-ui`(已验证存在于 registry) | `pi-web-chat`(已验证) |
| 版本 / 发布 | v0.28.2,2026-08-21(活跃) | v0.1.19,2026-08-11(~3.5k 下载/月) |
| 作者 / 性质 | xingshuyin,社区(非 earendil 官方) | preinpost,社区(非官方) |
| 许可证 | MIT(与本项目兼容) | MIT |
| 架构 | pi SDK 进程内 + WebSocket 快照推流(60ms 节流),默认仅绑 127.0.0.1,凭据留服务端 | Node + ws 服务,React 19 前端,默认 127.0.0.1,复用 pi CLI auth |
| 启动 | `npx pi-web-ui`(默认 :8787) | `pi install npm:pi-web-chat` + `pi --web`(:3141) |
| 环境要求 | Node ≥22.19 + node-pty 原生模块 | pi CLI 已配置 |
| 功能面 | 模型/API Key 网页内管理、思考块、工具卡片、终端(xterm.js+node-pty)、Git 面板、主题、goal 模式 | OpenWebUI 风格:流式、markdown、工具展示、会话 fork、模型切换、图片附件、移动端适配 |
| 本机可行性 | ✅ 系统 Node v24.19.0 / npm 11.17.0 | 需预装 pi CLI(未装) |

**共同风险(已向用户披露,计划批准视为知情确认)**:两者均为第三方 Node 代码,在本机以用户权限执行(pi-web-ui 含 node-pty 终端能力,等价于可执行任意命令);两者自身**无 token 鉴权**,本机其他进程理论上可访问其端口。缓解:仅绑回环 + 随机端口 + 不长期常驻;自研阶段(阶段 2)服务端内置随机 token 鉴权。

**选型结论**:demo 与阶段 1 启动器首选 **pi-web-ui**(无需预装 pi CLI、网页内即可配 Key,效果最完整);pi-web-chat 作为对照参考。

## 三、效果验证记录(阶段 0)

- 环境:Node v24.19.0、npm 11.17.0(满足 ≥22.19)
- 启动:`PORT=8917 PI_WEB_DATA_DIR=<临时目录> npx -y pi-web-ui`(独立临时数据目录,不污染用户级配置)
- 验证:HTTP 探活 + 页面加载(记录于 CHANGELOG dev.37 与提交信息)
- 评估结论(阶段 2 需求输入):
  - 保留:流式 markdown、思考折叠块、工具调用卡片、模型目录选择、API Key 网页内管理、会话持久化与恢复
  - 扬弃:内嵌终端与 Git 面板(浏览器主项目定位外的重能力,阶段 2 不做)
  - 对齐官方:`pi-client` + WebSocket 直连、快照权威状态、pi 原生事件形状透传(不手抄类型)

## 四、阶段 2 方向(已获计划批准,另立迭代实施)

自研 `apps/pi-web`(Vite+React,消费 pi 原生类型)+ `packages/pi-web-host`(Electron utilityProcess 内 vendored pi SDK `AgentSession` + WebSocket + 随机 token,数据落 `userData/pi`);同时满足 ADR-004 进程隔离与工具恢复条件。CBOR 官方栈 vs 轻量 JSON-over-WS 于开工时决策留痕。
