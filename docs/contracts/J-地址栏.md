# 契约 J · M4 地址栏

> 状态：草案  · 日期：2026-07-27  · 关联决策：OM1-OM10
> 模块归属：渲染进程  · 关联模块：M2 / M3 / M5 / M6
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 核心职责

- 接收用户输入，自动识别输入类型（URL / 搜索词 / 本地资源）
- 导航触发：URL 直接导航，搜索词转发默认搜索引擎，本地资源（`about:` / `urchin:`）内部处理
- 输入补全建议：v0.1 数据源限定为历史记录（M6）+ 书签（M5）
- 命令面板（Ctrl+Shift+P）：全键盘命令入口（OM10，见 §6）
- 安全状态指示：显示当前页面的 SSL 状态、是否隐私模式
- 加载状态指示：页面加载中显示进度条

## 2. 输入识别规则（OM1 决策）

```
输入 → 判断链：
  1. 以 http:// / https:// / ftp:// 开头 → URL（直接导航）
  2. 以 about: / urchin: / file: 开头 → 内部资源（注：`data:` 按 OM5 一律封禁，不作为内部资源）
  3. 包含空格 → 搜索词
  4. 包含点（.）且无空格 → 尝试 URL（http 前缀自动补全）
  5. 非空且无点 → 搜索词
  6. 空 → 新标签页（默认页面）
```

**OM1 决策落地**：输入识别在渲染进程本地执行（纯字符串匹配），无需 IPC 调用，避免延迟。

## 3. 补全建议数据流（OM2-OM4 决策）

```
用户输入 → 150ms debounce（OM2）→ IPC 查询 M6 历史 + M5 书签
         → 主进程模糊匹配 → 返回 Top 10 条（OM4：5 条历史 + 5 条书签混合）
         → 渲染下拉建议面板
         → 用户选择 → 导航
         → 或继续输入 → 重新触发
```

补全建议条目结构：

```typescript
interface Suggestion {
  type: 'history' | 'bookmark' | 'search-engine' | 'ai-suggest' (v0.2+);
  title: string;
  url: string;
  favicon?: string;
  /** 匹配启发：输入在 URL 中匹配 / 在标题中匹配 / 完全匹配 */
  matchType: 'url' | 'title' | 'exact';
  /** 排名权重 */
  score: number;
}
```

**OM3 决策落地**：v0.1 数据源为历史 + 书签；v0.2+ 增加 AI 建议补全。

## 4. 安全校验（OM5 决策）

```typescript
function validateUrlBeforeNavigation(input: string): { valid: boolean; url: string; error?: string } {
  // 禁止危险协议直接执行
  const dangerous = ['javascript:', 'data:', 'vbscript:'];
  for (const prefix of dangerous) {
    if (input.toLowerCase().startsWith(prefix)) {
      return { valid: false, url: input, error: `禁止导航到 ${prefix} 协议` };
    }
  }
  // 禁止未经转义的 URL 中携带危险协议
  if (input.includes('javascript:') || input.includes('data:')) {
    return { valid: false, url: input, error: 'URL 中包含非法协议' };
  }
  // 正常 URL 或搜索词放行
  return { valid: true, url: input };
}
```

## 5. UI 交互（OM6-OM9 决策）

| 交互 | 行为 | 决策 |
|---|---|---|
| 获得焦点 | 全选当前 URL（OM7） | 方便用户立即替换 |
| 输入暂停 150ms | 触发补全建议查询（OM2） | 避免每字符查询 |
| 回车 | 解析输入 → 导航（OM6 搜索引擎可自定义） | URL 直接导航，搜索词转发 |
| Escape | 恢复原始 URL | 取消用户编辑 |
| Ctrl+L / Alt+D | 跳转到地址栏并全选 | 标准快捷键 |
| 页面加载中 | 地址栏底部细进度条（OM8） | 类似 Chrome |
| 安全状态 | 左侧图标：🔒 SSL / ⚠️ 混合 / 🚫 HTTP（OM9） | 直观指示 |

**OM6 决策落地**：v0.1 硬编码 Google/Bing 作为默认搜索引擎；v0.2+ 可在设置中自定义搜索引擎 URL 模板。

## 6. 命令面板（OM10 决策）

FR-BROWSE-12 / FR-SET-04 要求命令面板（Ctrl+Shift+P）。**OM10 决策：命令面板归属 M4**——与地址栏共享渲染层输入框组件与模糊匹配管线，仅把数据源从「历史 + 书签」替换为「命令注册表」。

- 触发：`Ctrl+Shift+P`；`Esc` 关闭；`Enter` 执行选中命令。
- 命令注册表：扁平列表 `{ id, title, shortcut?, run() }`。v0.1 内置命令：新建/关闭标签、刷新、切换主题、打开设置、Toggle DevTools Enhancement（G DT8）、摘要当前页（M13）等。
- 数据源去重：DevTools 增强、Side Panel 等模块向注册表注册各自命令，命令面板只做统一入口，不各自实现。
- v0.2+：支持自定义快捷键绑定（FR-SET-01）与最近使用排序。

## 7. 决策记录

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| OM1 | 输入识别执行位置 | 渲染进程本地执行 | 主进程延迟太慢 |
| OM2 | 补全查询触发时机 | 150ms debounce | 每字符查询太频繁；按回车才查无补全 |
| OM3 | 补全数据源 | v0.1 历史 + 书签；v0.2+ 加 AI 建议 | 仅历史信息不足；仅书签覆盖不全 |
| OM4 | 补全上限 | 10 条（5 历史 + 5 书签混合） | 5 条太少；20 条界面过载 |
| OM5 | URL 安全校验 | 导航前校验危险协议 | 不做校验有安全风险 |
| OM6 | 搜索引擎默认 | v0.1 硬编码；v0.2+ 可自定义 | 无默认用户体验差 |
| OM7 | 获得焦点行为 | 全选当前 URL | 光标在末尾不适合替换 |
| OM8 | 加载进度指示 | 地址栏底部细进度条 | 旋转图标不够精确；无指示体验差 |
| OM9 | 安全状态指示 | 左侧图标（🔒/⚠️/🚫） | 仅文字提示不够直观 |
| OM10 | 命令面板归属 | M4（复用地址栏输入组件与匹配管线，数据源换为命令注册表） | 独立模块增加进程内组件重复；挂在 M19 主题系统语义不符 |