# Urchin Browser

> AI 原生 + 开发者友好的桌面浏览器，基于 Electron / 完整 Chromium 内核。

**当前阶段**：v0.1.0 开发完成（MVP 最小闭环 + per-provider 强隔离架构），W6-W7 验收通过。

## 项目定位

- **内核**：Electron 内置完整 Chromium（Blink + V8）
- **首版平台**：Windows
- **差异化双定位**：
  - AI 原生——Side Panel 始终在侧，理解当前页面上下文，无需复制粘贴到外部 LLM
  - 开发者友好——内置 DevTools 增强 + Chrome 扩展兼容 + 可脚本化 hooks
- **Provider 中立**：用户自带 API key 或本地 LLM，浏览器不绑定任何提供方

## v0.1 功能概览

| 模块                       | 范围                                                        |
| -------------------------- | ----------------------------------------------------------- |
| M1 Window Lifecycle        | 完整（多窗口管理 + 单实例锁）                               |
| M2 Tab Manager             | 完整（BrowserView + 事件同步 + 持久化）                     |
| M3 Navigation Stack        | 完整（loadUrl/stop/back/forward/reload）                    |
| M4 Omnibox                 | 基础（URL 解析 + 历史匹配补全 + 安全协议拦截）              |
| M5 Bookmarks               | 基础 CRUD                                                   |
| M6 History                 | 基础查询                                                    |
| M7 Settings                | 基础（分层默认值 + 跨进程同步）                             |
| M8 Storage Layer           | SQLite WAL + safeStorage 加密 + LRU 连接池                  |
| M10-lite Extension Loader  | 基础（MV3 manifest 校验 + 目录加载 + 生命周期）             |
| M11 AI Orchestrator        | 完整（per-provider 子进程隔离 + 心跳 + 限流 + 重试 + 流式） |
| M12 Provider Plugin API    | 完整契约 v1                                                 |
| M13 AI Side Panel          | demo（流式对话 + 页面上下文注入）                           |
| M14 Page Context Extractor | demo（Readability 正文抽取）                                |
| M17 IPC Protocol           | 完整（类型化 RPC + MessagePort 流式 + 事件推送）            |
| M18 Permission/Sandbox     | 完整（sandbox + contextIsolation + preload）                |
| M19 Theme/UI System        | 基础（暗色/亮色 + Radix + Tailwind）                        |
| M23 Download Manager       | 基础（will-download 接管 + 进度 + 暂停/取消）               |

## 快速开始

### 环境要求

- Node.js ≥ 22
- pnpm ≥ 9
- Windows 10/11（macOS/Linux 待 v0.4+）

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

### 构建

```bash
pnpm build
```

### 打包 Windows 安装包

```bash
pnpm package:win
```

产出位于 `apps/desktop/release/`（NSIS 安装包 + win-unpacked 目录）。

## 开发命令

| 命令                 | 说明                            |
| -------------------- | ------------------------------- |
| `pnpm typecheck`     | 全工作区 TypeScript 类型检查    |
| `pnpm lint`          | ESLint 检查                     |
| `pnpm test`          | 全工作区单元测试                |
| `pnpm test:coverage` | 单元测试 + 覆盖率报告           |
| `pnpm e2e`           | Playwright E2E 测试（关键路径） |
| `pnpm format`        | Prettier 格式化                 |

## 性能指标（v0.1 验收）

| 指标              | 阈值     | 实测         |
| ----------------- | -------- | ------------ |
| 冷启动时间（P95） | ≤ 3000ms | 1011ms ✓     |
| 10 标签内存       | ≤ 500MB  | 358.3MB ✓    |
| 单元测试          | 全过     | 457 passed ✓ |
| 覆盖率（Stmts）   | ≥ 60%    | 68.05% ✓     |
| E2E 关键路径      | 全过     | 4 passed ✓   |

## 文档

完整设计文档体系位于 [`docs/`](./docs/文档索引.md)，覆盖：

- 产品定位与决策记录（[01](./docs/01-愿景与定位.md)）
- 架构与进程模型（[02](./docs/02-架构设计.md)）
- 技术栈与覆盖率门槛（[03](./docs/03-技术栈.md)）
- 23 个模块全景与 v0.1 范围（[04](./docs/04-模块全景.md)）
- 11 份接口契约（[Provider API / IPC / Chrome 兼容 / Tab Manager 等 A-K](./docs/contracts/)）
- 决策留痕：3 份关键 ADR + 决策索引（核心 36 项 + 契约内 68 项 = 104 项）（[decisions/](./docs/decisions/决策索引.md)）

## 开发规范

项目根目录的 `agents.md` 是 AI Agent 全流程开发规范，**项目级适配已于 2026-07-29 完成并生效**（量化门槛/工具名/流程裁剪，适配留痕见其「项目适配说明区」）。测试覆盖率门槛的单一真源为 [docs/03-技术栈 §4](./docs/03-技术栈.md)。

## 架构亮点

- **per-provider 强隔离**：每个 AI Provider 运行在独立子进程（utility process），crash 不影响浏览器主进程
- **Provider 中立**：支持本地路径/npm 包加载第三方 Provider，版本协商 + 安全 warning 流程
- **类型化 IPC**：zod schema 双向验证 + MessagePort 流式传输
- **SQLite 加密存储**：WAL 模式 + safeStorage 加密 + per-provider/per-extension 命名空间隔离

## License

详见 [LICENSE](./LICENSE)。
