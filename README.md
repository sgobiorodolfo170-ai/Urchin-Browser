# Urchin Browser

> AI 原生 + 开发者友好的桌面浏览器，基于 Electron / 完整 Chromium 内核。

**当前阶段**：v0.0.3（设计文档 W0 收敛 + agents.md 适配完成，无代码）。代码 v0.1.0 待立项后启动。

## 项目定位

- **内核**：Electron 内置完整 Chromium（Blink + V8）
- **首版平台**：Windows
- **差异化双定位**：
  - AI 原生——Side Panel 始终在侧，理解当前页面上下文，无需复制粘贴到外部 LLM
  - 开发者友好——内置 DevTools 增强 + Chrome 扩展兼容 + 可脚本化 hooks
- **Provider 中立**：用户自带 API key 或本地 LLM，浏览器不绑定任何提供方

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

## License

详见 [LICENSE](./LICENSE)。
