# ADR-004 · AI 进程隔离策略：utility process 分阶段迁移

> 状态：Accepted  · 决策日：2026-07-27  · 关联：D4 / IP4 / IP8
> 影响范围：进程模型、IPC 拓扑、Provider 插件加载机制、首版工期

## 决策

Urchin Browser 的 AI 子系统（LLM 调用、Provider 插件加载与执行）跑在**独立的 utility process**，而非主进程。隔离策略为**分阶段迁移**：

- **v0.1 MVP**：LLM API 调用 + Provider 插件加载与执行迁入 utility process。上下文记忆、向量化等推迟到 v0.2+。
- **v0.1 即上 per-provider 子进程**（IP4 完整版）：每 Provider 独立 utility fork，第三方 Provider 代码 crash 不影响 Orchestrator 与其他 Provider。允许第三方加载（IP8），但 v0.1 不做签名校验，v0.4 引入签名 allowlist（与 NFR-SEC-07 对齐）。

## 背景

AI 原生是 Urchin 的核心差异化定位之一（D3）。AI 集成的实质是「主浏览器进程需要持续与外部 LLM 提供方通信、处理流式 token、加载第三方 Provider 插件代码」。

主进程是 Electron 的命脉——单线程事件循环、所有窗口/标签/UI 都依赖它。把 AI 工作放进主进程意味着把主进程暴露给：

1. LLM SDK 的 CPU 密集型流式 token 拼装——每秒几十次更新阻塞事件循环，肉眼可见卡 UI。
2. 第三方 Provider 插件代码——可信度天然不可控，未捕获异常带倒整个浏览器。

D5 决策选择了 Provider 插件机制（不绑单一提供方），这意味着「主进程加载陌生人代码」是必然场景。

## 候选方案

| 方案 | 隔离机制 | 工程量 | 崩溃面 | 流式延迟 |
|---|---|---|---|---|
| A. utility process 分阶段 | utilityProcess.fork | 中 | 第三方代码 crash 不影响主进程 | ~1-5ms |
| B. 主进程内同驻 | 主进程模块 | 小 | AI crash 带倒整个浏览器 | 0ms |
| C. 外部 Sidecar | 独立二进制 + stdio/HTTP | 大 | 进程级隔离（最强） | ~5-20ms |

## 决策理由

### 否决方案 B（主进程内同驻）

两个隐性致命伤：

1. **崩溃面**：Provider 插件机制（D5）必然加载第三方代码。第三方代码未捕获异常 = 整个浏览器挂。这是不可接受的用户体验。
2. **CPU 阻塞**：LLM 流式响应的 token-by-token 拼装是 CPU 密集型，跑在主进程会肉眼可见卡 UI。Electron 主进程单线程事件循环是公认的痛点。

### 否决方案 C（外部 Sidecar）

v0.1 MVP（4-6 周）不值得——sidecar 二进制打包 + 代码签名 + 版本对齐会吃掉 1-2 周。它真正有收益的场景：
- v1.0+ 接入本地 LLM（ollama 二进制打包）
- 用 Rust 写高性能向量化

### 采纳方案 A（utility process）

- Electron `utilityProcess` API 成熟（T1 最新稳定版跟进），原生 Node 子进程，跨平台一致。
- IPC 拓扑清晰：Main 为路由中枢，Orchestrator 为 AI 调度，Provider Child 为第三方代码运行容器。
- 工程量适中，与 6-8 周工期契合。

### 进一步决策：v0.1 即上 per-provider 子进程（IP4 完整版）

在 A 方案内部，又分两种迁移深度：

| 子方案 | v0.1 工程量 | 隔离层级 |
|---|---|---|
| A.分阶段（同进程 namespace） | 4-6 周 | 仅 Orchestrator 与 Main 隔离；Provider 互相在同进程内 |
| **A.分阶段 + per-provider 子进程**（已采纳） | **6-8 周** | Main ↔ Orchestrator ↔ Provider Child 三层隔离 |

**采纳 per-provider 子进程版**的理由：

1. **Provider 中立原则下的安全底线**：D5 决策决定了 Provider 必然有第三方实现，没有进程级隔离等于在主进程的近邻跑陌生人代码。
2. **架构一次到位无技术债**：v0.1 即把 fork 接口与心跳协议建好，v0.2+ 不需要重构主进程的 Provider 调度路径。
3. **强隔离是 Urchin 与商业 AI 浏览器的差异化点**：竞品（如 Arc、Wave）大多把 LLM SDK 跑在主进程或主 utility 内，Urchin 走 per-provider 隔离是开源生态对接的安全信号。

接受 6-8 周工期换架构纯净度，是经过用户明确授权的权衡（参见讨论中 IP4/IP8 最终路径问题的回答）。

## 进程拓扑

```
Main Process
  └ utilityProcess.fork
       → AI Orchestrator (官方代码，调度/限流/重试)
            └ utilityProcess.fork
                 → Provider Child A (第三方 Provider 实现)
                 → Provider Child B
                 → ...
```

详见 [02-architecture §1.2](../02-架构设计.md#12-进程拓扑的关键设计) 与 [03 后续受影响决策](#后续受影响决策)。

## 分阶段迁移计划

### v0.1 迁移范围

- ✓ LLM API 调用 + 流式响应处理（CPU 密集 + 高 crash 风险）
- ✓ Provider 插件加载与执行（第三方代码隔离）
- ✓ 第三方 Provider 加载 UI + warning 流程（用户输入「我确认」）
- ✗ 上下文记忆持久化（留 v0.2）
- ✗ 向量化（留 v0.2）

### v0.2+ 迁移范围

- 上下文记忆 + 跨轮对话状态（迁入 Orchestrator 或独立 context utility）
- 向量化（若有需要，独立 fork vector worker）
- Provider 签名 allowlist（**v0.4** 引入，替代 v0.1 的 warning 流程；与 NFR-SEC-07 对齐）

## 第三方加载流程

```
用户点「Add Provider」
  → 选本地路径或 npm 包名
  → UI 弹 warning：「第三方 Provider 代码将作为子进程运行，
                 crash 不影响浏览器，但请确认来源可信。
                 v0.1 未做签名校验。」
  → 用户输入「我确认」
  → Orchestrator.forkProvider(providerId, packagePath)
  → fork 后调 Provider.initialize(ctx) 进行版本协商
  → 协商失败（apiVersion 不匹配）→ 拒载并通知 UI
  → 成功 → 注册到 Provider 注册表，UI 显示可用
```

v0.1 不做签名校验，依赖用户判断 + 进程隔离兜底。v0.4 引入 Provider manifest 签名 + 公钥 allowlist（未签名拒载，与 NFR-SEC-07 对齐）。

## 否决方案理由汇总

- **B 主进程内同驻**：崩溃面 + CPU 阻塞风险，与 Provider 插件机制根本冲突。
- **C 外部 Sidecar**：v0.1 工程税过重（打包/签名/版本对齐吃掉 1-2 周），留给 v1.0+ 本地 LLM 集成。

## 后果

### 正面

- 第三方 Provider 代码 crash 零影响主进程或其他 Provider。
- LLM 流式 token CPU 密集任务不阻塞主进程事件循环。
- IPC 拓扑清晰，Main ↔ Orchestrator ↔ Provider Child 三层边界都可独立加 zod schema 校验。
- v0.2+ 演进路径明确（不重构主路径，仅扩展）。

### 负面

- v0.1 工期 +2 周（4-6 周 → 6-8 周）。
- 流式 token 链路多一跳，两跳合计延迟 ~2-4ms（可接受，与 02-架构设计 §1.2 口径一致）。
- IPC 协议层需设计两级 MessagePort chain（IP9 决策）。
- 子进程生命周期管理 / crash 恢复 / 资源回收都得自己写。

## 后续受影响决策

- IP9：MessagePort 路径选「经 Main 转交一次」（v0.1 简单方案）
- D7：v0.1 范围调整为 6-8 周（详见 ADR-008）
- M11：AI Orchestrator 模块职责定义（调度 + 限流 + 心跳协议）
- M12：Provider 契约 `AbortSignal` 强制监听要求（进程间取消信号传播）

## 参考

- Electron utilityProcess 文档
- [contracts/A-provider-api](../contracts/A-提供方接口.md) §6 Provider 加载与隔离
- [contracts/B-ipc-protocol](../contracts/B-进程间通信协议.md) §6 MessagePort 流式协议
