# 契约 K · M19 主题/UI 系统

> 状态：草案  · 日期：2026-07-27  · 关联决策：TH1-TH8
> 模块归属：渲染进程  · 关联模块：M13 / M15 等所有 UI 组件
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

- 提供设计令牌系统（颜色/间距/字体/阴影/圆角/动画），单一真源
- 亮色/暗色模式切换，所有组件响应
- 基础组件库，统一浏览器 UI 风格

## 2. 组件库策略（TH1 决策）

**选用 Radix UI Primitives（无样式）+ Tailwind CSS**。

| 方案 | 优点 | 缺点 |
|---|---|---|
| **Radix UI + Tailwind（采纳）** | 可访问性内置、无样式可自由定制、Tailwind 生态成熟 | 需自己组装组件样式 |
| 自研轻量组件 | 完全可控、无外部依赖 | 开发周期长、可访问性需自己实现 |
| 全组件库（如 Ant Design） | 开箱即用 | 样式重、定制困难、包体大、与浏览器 UI 风格不匹配 |

## 3. 设计令牌（TH2 + TH6 决策）

```css
/* tokens.css — 单一真源，CSS 变量（TH2 决策） */
:root {
  /* 颜色 — 核心 12 色（TH6 决策） */
  --color-primary: #2563eb;          /* blue-600 */
  --color-primary-hover: #1d4ed8;    /* blue-700 */
  --color-accent: #8b5cf6;           /* violet-500 */
  --color-surface: #ffffff;
  --color-surface-secondary: #f8fafc;
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
  --color-border: #e2e8f0;
  --color-error: #ef4444;
  --color-success: #22c55e;
  --color-warning: #f59e0b;
  --color-info: #3b82f6;

  /* 间距 */
  --spacing-1: 4px;   --spacing-2: 8px;   --spacing-3: 12px;
  --spacing-4: 16px;  --spacing-6: 24px;  --spacing-8: 32px;

  /* 字体（TH7 决策：系统字体栈） */
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-size-xs: 12px;  --font-size-sm: 13px;  --font-size-base: 14px;
  --font-size-lg: 16px;  --font-size-xl: 20px;
  --font-weight-normal: 400;  --font-weight-medium: 500;  --font-weight-bold: 600;

  /* 圆角 */
  --radius-sm: 4px;  --radius-md: 8px;  --radius-lg: 12px;

  /* 阴影 */
  --shadow-dropdown: 0 4px 12px rgba(0,0,0,0.1);
  --shadow-modal: 0 8px 24px rgba(0,0,0,0.15);
  --shadow-tooltip: 0 2px 8px rgba(0,0,0,0.08);

  /* 动画 */
  --duration-fast: 150ms;  --duration-normal: 200ms;  --duration-slow: 300ms;
  --easing-default: ease;
}

/* 暗色模式 — data-theme 切换（TH3 决策） */
[data-theme="dark"] {
  --color-primary: #3b82f6;
  --color-primary-hover: #60a5fa;
  --color-surface: #0f172a;
  --color-surface-secondary: #1e293b;
  --color-text: #f8fafc;
  --color-text-secondary: #94a3b8;
  --color-border: #334155;
}
```

## 4. v0.1 组件清单（TH4 决策）

| 组件 | 类型 | 基础 API |
|---|---|---|
| Button | 基础 | primary/secondary/ghost/danger、大小、禁用、loading |
| Input | 基础 | 文本/密码/搜索、错误状态、前缀/后缀图标 |
| Select/Dropdown | 基础 | 下拉菜单、选项分组 |
| Modal | 基础 | 标题/内容/操作按钮、ESC 关闭、遮罩关闭 |
| Tabs | 基础 | 标签切换（标签栏 → 内容区） |
| Tooltip | 基础 | 鼠标悬停提示 |
| Toast | 基础 | 成功/错误/警告/信息、自动消失 |
| ProgressBar | 基础 | 线性进度条、确定/不确定模式 |
| Badge | 基础 | 徽标计数 |
| SidePanel | 扩展 | 侧边面板容器、可折叠、可拖拽宽度 |
| TabBar | 扩展 | 浏览器标签栏、标签项、右键菜单 |
| Omnibox | 扩展 | 地址栏 + 补全建议面板 |
| DevToolsPanel | 扩展 | 开发者工具面板容器 |

**TH5 决策落地**：浏览器特有组件（TabBar / Omnibox / SidePanel / DevToolsPanel）自研，不依赖 Radix UI——因为浏览器 UI 无现成组件库可用，Radix 的 Tabs 等组件限制太多。

## 5. 图标方案（TH8 决策）

选用 **Lucide Icons** 作为图标库。理由：
- 轻量（按需导入，Tree-shaking 友好）
- 一致性高（统一 24px 网格设计）
- 开源（ISC 许可证）
- 覆盖面满足浏览器 UI 需求（箭头、标签、书签、历史、设置、搜索、关闭、菜单等）

## 6. 决策记录

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| TH1 | 组件库策略 | Radix UI + Tailwind CSS | 自研开发周期长；Ant Design 包体大、风格不匹配 |
| TH2 | 设计令牌存放位置 | CSS 变量（`:root` + `[data-theme]`） | SCSS 变量不如 CSS 动态；JS 变量无法在 CSS 引用 |
| TH3 | 暗色模式切换方式 | `<html data-theme="dark">` 类切换 | 双 CSS 文件加载延迟；JS 手动覆盖不可维护 |
| TH4 | v0.1 组件覆盖度 | 基础 9 个 + 扩展 4 个 | 仅基础组件时 Side Panel 等用原生 HTML 临时替代，体验差 |
| TH5 | 浏览器特有组件实现 | 自研（TabBar/Omnibox/SidePanel/DevToolsPanel） | 基于 Radix Tabs 改造限制太多 |
| TH6 | 颜色令牌数量 | 核心 12 色 | 50+ 色维护成本高；5 色不够用 |
| TH7 | 字体选择 | 系统字体栈 | 自定义字体加载延迟、包体大 |
| TH8 | 图标方案 | Lucide Icons | Font Awesome 重；自研 SVG 开发周期长 |