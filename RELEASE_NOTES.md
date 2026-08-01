# Urchin Browser v0.1.0 Release Notes

**发布日期**：2026-07-29
**版本**：v0.1.0（MVP 最小闭环 + per-provider 强隔离架构）

## 概述

Urchin Browser v0.1.0 是首个可安装的里程碑版本，基于 Electron / 完整 Chromium 内核，实现 AI 原生 + 开发者友好的桌面浏览器 MVP。

核心架构亮点：**per-provider 强隔离**——每个 AI Provider 运行在独立子进程（utility process），crash 不影响浏览器主进程，配合安全 warning 流程支持第三方 Provider 加载。

## 功能清单

### 浏览器核心

- **多窗口管理**（M1）：单实例锁 + 窗口生命周期 + 事件分发
- **多标签页**（M2）：BrowserView 渲染 + 事件同步 + 状态持久化
- **导航栈**（M3）：loadUrl / stop / back / forward / reload
- **地址栏**（M4）：URL 解析 + 历史匹配补全 + 安全协议拦截（javascript:/data:/vbscript:）
- **书签**（M5）：CRUD + 模糊搜索 + 文件夹组织
- **历史记录**（M6）：查询 + 去重 + 访问计数
- **设置**（M7）：分层默认值 + 跨进程同步
- **下载管理**（M23）：will-download 接管 + 进度 + 暂停/取消

### AI 能力

- **AI Orchestrator**（M11）：per-provider 子进程隔离 + 心跳监控（30s）+ 空闲回收（5min）+ crash 自动重建 + 令牌桶限流 + 指数退避重试 + 流式传输
- **Provider Plugin API**（M12）：完整契约 v1 + 版本协商 + 能力声明
- **AI Side Panel**（M13）：流式对话渲染 + 页面上下文注入
- **Page Context Extractor**（M14）：Readability 正文抽取 + prompt builder
- **第三方 Provider 加载**：本地路径/npm包安装 + manifest 校验 + IP8 安全 warning 对话 + crash 事件推送 + OR7 自动恢复

### 基础设施

- **存储层**（M8）：SQLite WAL 模式 + safeStorage 加密 + 主库/AI库分离 + per-provider/per-extension 命名空间 + LRU 连接池
- **IPC 协议**（M17）：类型化 RPC（zod 双向验证）+ MessagePort 流式传输 + 事件推送
- **安全沙箱**（M18）：sandbox + contextIsolation + preload 暴露面最小化
- **主题系统**（M19）：暗色/亮色切换 + Radix UI + Tailwind CSS 3
- **扩展加载器**（M10-lite）：MV3 manifest 校验 + 目录加载 + 生命周期管理

## 性能指标

| 指标                    | 阈值     | 实测       |
| ----------------------- | -------- | ---------- |
| 冷启动时间（P95）       | ≤ 3000ms | 1011ms     |
| 10 标签内存             | ≤ 500MB  | 358.3MB    |
| 单元测试覆盖率（Stmts） | ≥ 60%    | 68.05%     |
| 单元测试                | 全过     | 457 passed |
| E2E 关键路径            | 全过     | 4 passed   |

## 质量指标

- **typecheck**：6 packages 全过
- **lint**：0 errors
- **单元测试**：457 passed（ipc-contract 34 + ai-provider-contract 42 + provider-sdk 11 + desktop 370）
- **覆盖率**：68.05% Stmts / 87.67% Branch / 87.03% Funcs
- **E2E**：4 passed（启动 / 新建标签 / 导航 / 关闭标签）

## 安装

### Windows

1. 下载 `Urchin Browser-0.1.0-x64.exe`（81MB NSIS 安装包）
2. 双击运行安装程序
3. 按提示完成安装

或使用 win-unpacked 目录直接运行 `Urchin Browser.exe`（免安装）

### 系统要求

- Windows 10/11（64-bit）
- macOS/Linux 待 v0.4+

## 已知限制

- AI 摘要功能需配置真实 Provider + API key（v0.1 不预置官方 Provider）
- 扩展系统为 lite 版（仅目录加载，不支持 .crx 安装/权限审批 UI/自动更新）
- DevTools 增强（M15）为 demo 级
- 无代码签名证书（安装时 Windows SmartScreen 可能警告）

## 开发团队

Urchin Browser Contributors

## License

详见 [LICENSE](./LICENSE)

## 下一版本规划（v0.2+）

- M10 Extension Loader 完整版（.crx 安装 + 权限审批 UI）
- M16 Network Interceptor
- M20 Update Service
- M21 Crash Reporter
- macOS/Linux 平台支持（v0.4+）
