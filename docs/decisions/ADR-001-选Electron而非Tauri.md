# ADR-001 · 内核路线选 Electron 而非 Tauri

> 状态：Accepted  · 决策日：2026-07-27  · 关联：D1
> 影响范围：全项目进程模型、AI 集成路径、扩展系统能力上限

## 决策

Urchin Browser 选用 **Electron** 作为应用框架，使用其内置完整 Chromium（Blink + V8）作为渲染与执行内核。

## 背景

项目定位是「AI 原生 + 开发者友好」桌面浏览器。两种定位都需深度介入页面层：

- **AI 原生**：要抽取当前页面正文喂给 LLM、在 Side Panel 注入对话 UI、维护跨标签的上下文记忆。这些都需要从应用层直接访问页面的 DOM、网络请求、执行环境。
- **开发者友好**：要内置 DevTools 增强、提供扩展 API（兼容 Chrome MV3）、做网络拦截。这些都需要对内核层的控制权。

首版目标平台：仅 Windows。

## 候选方案

| 方案 | 渲染引擎 | 引擎版本控制 | 多进程隔离 | 工程量 |
|---|---|---|---|---|
| Electron | 自带完整 Chromium | 完全控制 | 原生支持（每标签独立 webContents + sandbox） | 中 |
| Tauri | 系统 WebView2（Windows） | 微软说了算 | WebView2 单实例，难做进程级标签沙箱 | 小 |
| Servo/Gecko | Servo 或 GeckoView | 自带 | 支持 | 中-大 |
| 自研内核 | 自研 HTML/CSS/JS 引擎 | 自研 | 自研 | 人年级 |

## 决策理由

### 1. 浏览器产品对内核控制权的需求与「应用嵌入网页」根本不同

Tauri 使用系统 WebView2，本质是「带网页内容的桌面应用」框架。对 Urchin 这种**浏览器产品**，下列三点是地基性需求，Tauri 都不满足：

- **多进程标签沙箱**：每个标签独立进程、独立 sandbox、站点隔离——这是浏览器安全基线。WebView2 单实例为主，难做真正的进程级隔离。
- **引擎版本控制权**：浏览器要为渲染行为一致性负责。Electron 锁定自带 Chromium 版本，Tauri 依赖 Windows Update 推送的 WebView2 版本——不同用户机器上引擎可能不同，行为不可预测。
- **`webContents` 级 API**：Urchin 的 AI 原生定位需要 `webContents.executeJavaScript` / preload / CDP（Chrome DevTools Protocol）全套浏览器级 API。Tauri 偏「应用嵌入网页」而非「浏览器」，这些 API 受限或不存在。

### 2. Electron 在「AI 原生浏览器」流派有验证案例

Brave 早期 Electron 起家，Wave/SigmaOS 等 AI 浏览器流派也走 Electron 路线。社区对 Electron + 浏览器形态的踩坑经验与解决方案沉淀丰富。

### 3. 90MB 包体的代价是可接受的

Electron 基础包体 ~100MB+，Tauri ~10MB。对浏览器产品，包体换内核控制权这笔账划得来：用户对「浏览器」的包体期望本就比「桌面应用」高（Chrome 安装包 ~80MB，Edge ~90MB）。

### 4. utilityProcess API 已成熟

Electron 较新版本的 `utilityProcess` API 提供进程级 AI 隔离能力（详见 [ADR-004](./ADR-004-AI进程隔离策略.md)），解决了「Electron 主进程单线程」的 AI 集成痛点。这消除了选 Electron 的最后一个顾虑。

## 否决方案理由

- **Tauri**：上述四点均不满足，本质不适合浏览器产品。包小优势在浏览器品类不构成决策优势。
- **Servo/Gecko**：生态小、文档与社区资源不及 Chromium，扩展兼容性（D6 决策）难以落地。
- **自研内核**：人年级工程，5+ 专职团队 + 数年预算，与项目现实不匹配。

## 后果

### 正面

- 拥有完整 Chromium 渲染层，D3 双定位（AI 原生 + 开发者友好）的地基稳固。
- 工具链成熟（electron-builder / Vite / electron-forge）、社区案例丰富。
- utilityProcess + MessagePort 原生支持 AI 进程隔离拓扑（D4 决策）。
- Chrome 扩展兼容（D6 决策）天然可行，因为底层就是 Chromium。

### 负面

- 包体 ~100MB 起点；v1.0 目标 ≤180MB（含 1 个官方 Provider SDK）。
- 内存占用相对 Tauri 更高（基础 ~150MB + 每 tab ~50MB），需 v0.3+ 引入 process pooling 优化。
- Chromium 升级需跟随 Electron 主版本节奏，不及 Tauri「跟系统走」便利（但对浏览器反而是优点，引擎版本可控）。

## 后续受影响决策

- D4 AI 进程隔离（直接依赖 Electron utilityProcess API）
- D6 扩展系统（Chromium 原生支持 chrome.* 系列模拟）
- T4 构建链选 electron-builder（与 Electron 配套最成熟）
- TP1 Tab webContents 形态选 BrowserView（Electron 原生 API）

## 参考

- Electron utilityProcess 文档
- Brave 浏览器技术博客早期架构选择
- 比较 Tauri vs Electron 的公开技术文章（注意时效性）
