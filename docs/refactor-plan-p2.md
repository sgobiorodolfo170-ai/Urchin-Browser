# P2 文件拆分规划

> 本文档是 4 个"上帝文件"拆分的执行蓝图。每个 Session 的 AI 读本文档即可开始工作，不需要对话历史。
>
> **前置状态**（git HEAD: aeaaf6bc）：
> - index.ts: 2585 行（Provider 已外迁到 `orchestrator/providers/openai-compatible.ts`）
> - App.tsx: 3039 行
> - SettingsPage.tsx: 2087 行
> - bookmark-panel.ts: 1187 行（含 ~700 行内联 JS 字符串）
>
> **验证协议**（每步必须执行）：
> 1. `pnpm verify`（typecheck + lint + format:check + test:coverage + check:docs）
> 2. `pnpm e2e`（至少跑 `launch.spec.ts` + `tab-order-repro.spec.ts`）
> 3. 两项都通过才能 `git commit`
> 4. 提交格式：`refactor(<scope>): step N - <提取内容>`

---

## Session 1: index.ts 拆分（主进程入口）

**文件**：`apps/desktop/src/main/index.ts`（2585 行 → 目标 ~500 行）
**并行性**：可与 Session 2/3/4 并行（主进程，改的文件不与渲染进程重叠）

### 1.1 闭包变量清单（37 个 let）

`performCleanup`（205 行）和 `registerIpcHandlers`（660 行）闭包了以下变量，必须先打包到 AppContext：

| 变量 | 行号 | 类型 | 用于 |
|------|------|------|------|
| `currentDataDir` | 212 | `string` | 数据目录路径 |
| `historyManager` | 432 | `HistoryManager` | cleanup persist |
| `bookmarkManager` | 439 | `BookmarkManager` | handlers |
| `faviconService` | 445 | `FaviconService \| undefined` | handlers |
| `settingsManager` | 451 | `SettingsManager` | cleanup persist + handlers |
| `workspaceRegistry` | 458 | `WorkspaceRegistry` | handlers |
| `workspaceSessions` | 459 | `WorkspaceSessionManager` | handlers |
| `providerRegistry` | 471 | `ProviderRegistry` | handlers |
| `orchestrator` | 472 | `Orchestrator` | cleanup disposeAll |
| `providerConfigStore` | 473 | `ProviderConfigStore` | handlers |
| `tabViewIntegration` | 474 | `TabViewIntegrationHandle \| null` | cleanup dispose |
| `disposeContextMenu` | 476 | `(() => void) \| null` | cleanup |
| `disposeZoomControl` | 478 | `(() => void) \| null` | cleanup |
| `disposeDragInjection` | 480 | `(() => void) \| null` | cleanup |
| `disposeTranslateManager` | 482 | `(() => void) \| null` | cleanup |
| `translateManagerRef` | 484 | `TranslateManager \| null` | handlers |
| `disposeDevtoolsManager` | 486 | `(() => void) \| null` | cleanup |
| `disposeDevtoolsShortcuts` | 487 | `(() => void) \| null` | cleanup |
| `genofficeIntegration` | 489 | `GenOfficeIntegration \| null` | cleanup + handlers |
| `allowClose` | 506 | `boolean` | 退出流程 |
| `bookmarkPanel` | 679 | `BookmarkPanel \| null` | handlers |
| `bookmarkPickerContext` | 684 | `{ url; title } \| null` | handlers |
| `statusBarOverlay` | 686 | `StatusBarOverlay \| null` | cleanup |
| `statusBarBall` | 688 | `StatusBarBall \| null` | cleanup |
| `aiHandlersDispose` | 695 | `(() => void) \| null` | cleanup |
| `dshLauncher` | 701 | `DshLauncher \| null` | cleanup |
| `unbindDshTabClose` | 703 | `(() => void) \| null` | cleanup |
| `piWebHostLauncher` | 709 | `PiWebHostLauncher \| null` | cleanup |
| `storageLayer` | 715 | `StorageLayer \| null` | cleanup close |
| `mailContentStore` | 723 | `MailContentStore \| null` | handlers |
| `isCleaningUp` | 729 | `boolean` | cleanup guard |
| `cleanupDone` | 735 | `boolean` | exit guard |
| `mainWindowOpts` | 1996 | `CreateWindowOptions` | 窗口创建 |
| `restored` | 2241 | `boolean` | session restore |
| `activeTabId` | 2243 | `number \| undefined` | startup |

另有两个非 let 但被闭包的顶层常量：`windowManager`（296行）、`tabManager`（310行）。

### 1.2 AppContext 接口设计

```typescript
// bootstrap/app-context.ts
export interface AppContext {
  // 顶层常量（从 index.ts 传入）
  readonly windowManager: WindowManager;
  readonly tabManager: TabManager;

  // 可变状态（let 变量打包）
  currentDataDir: string;
  historyManager: HistoryManager;
  bookmarkManager: BookmarkManager;
  faviconService: FaviconService | undefined;
  settingsManager: SettingsManager;
  workspaceRegistry: WorkspaceRegistry;
  workspaceSessions: WorkspaceSessionManager;
  providerRegistry: ProviderRegistry;
  orchestrator: Orchestrator;
  providerConfigStore: ProviderConfigStore;
  tabViewIntegration: TabViewIntegrationHandle | null;
  disposeContextMenu: (() => void) | null;
  disposeZoomControl: (() => void) | null;
  disposeDragInjection: (() => void) | null;
  disposeTranslateManager: (() => void) | null;
  translateManagerRef: TranslateManager | null;
  disposeDevtoolsManager: (() => void) | null;
  disposeDevtoolsShortcuts: (() => void) | null;
  genofficeIntegration: GenOfficeIntegration | null;
  allowClose: boolean;
  bookmarkPanel: BookmarkPanel | null;
  bookmarkPickerContext: { url: string; title: string } | null;
  statusBarOverlay: StatusBarOverlay | null;
  statusBarBall: StatusBarBall | null;
  aiHandlersDispose: (() => void) | null;
  dshLauncher: DshLauncher | null;
  unbindDshTabClose: (() => void) | null;
  piWebHostLauncher: PiWebHostLauncher | null;
  storageLayer: StorageLayer | null;
  mailContentStore: MailContentStore | null;
  isCleaningUp: boolean;
  cleanupDone: boolean;
  mainWindowOpts: CreateWindowOptions;
  restored: boolean;
  activeTabId: number | undefined;
}
```

### 1.3 拆分步骤（6 步）

| 步骤 | 目标文件 | 提取内容 | 行数 | 风险 |
|------|----------|----------|------|------|
| 1 | `bootstrap/app-context.ts` | AppContext 接口定义 | ~60 行新增 | 低 |
| 2 | `lifecycle/cleanup.ts` | `performCleanup(ctx)` | ~205 行移动 | 中（改 37 处 `var` → `ctx.var`） |
| 3 | `bootstrap/handlers.ts` | `registerIpcHandlers(ctx)` | ~660 行移动 | 中（同上） |
| 4 | `bootstrap/watchdog.ts` | `installEventLoopWatchdog()` | ~12 行移动 | 低 |
| 5 | `bootstrap/theme-apply.ts` | `applyTheme()` | ~32 行移动 | 低 |
| 6 | `lifecycle/signals.ts` | SIGINT/SIGTERM 处理 | ~20 行移动 | 低 |

**步骤 1 详情**：
- 创建 `src/main/bootstrap/app-context.ts`，定义 `AppContext` 接口
- 在 `index.ts` 中创建 `const ctx: AppContext = { ... }` 对象
- 将所有 37 个 `let` 变量的赋值改为 `ctx.xxx = ...`
- 将 `performCleanup` 和 `registerIpcHandlers` 中所有裸变量引用改为 `ctx.xxx`
- index.ts 本身行数暂时不减少（只是加了 ctx 对象），但为后续提取铺路

**步骤 2 详情**：
- 将 `performCleanup` 函数体移到 `lifecycle/cleanup.ts`
- 签名改为 `export async function performCleanup(ctx: AppContext): Promise<void>`
- index.ts 中改为 `import { performCleanup } from './lifecycle/cleanup'`
- 所有 `orchestrator` → `ctx.orchestrator`，`tabManager` → `ctx.tabManager` 等

**步骤 3 详情**：
- 将 `registerIpcHandlers` 函数体移到 `bootstrap/handlers.ts`
- 签名改为 `export function registerIpcHandlers(ctx: AppContext): void`
- 这是最大的一步（660 行），建议在步骤 2 验证通过后再做

### 1.4 预期结果

- index.ts: 2585 → ~500 行（仅保留 import + ctx 创建 + app.whenReady 编排）
- 新增 6 个文件，每个 12-660 行
- 所有功能不变，只是代码换了文件

---

## Session 2: App.tsx 拆分（前端根组件）

**文件**：`apps/desktop/src/renderer/App.tsx`（3039 行 → 目标 ~300 行）
**并行性**：可与 Session 1/4 并行（渲染进程，不与主进程文件重叠）

### 2.1 状态清单（33 个 useState）

按归属域分组：

**标签/内容区（提取到 ContentArea）**：
- `tabs`（333）、`activeTabId`（334）、`contentZoom`（377）

**地址栏（提取到 Omnibox 组件，已存在 omnibox/ 目录）**：
- `suggestions`（335）、`bookmarkSaved`（349）、`bookmarkToast`（350）、`actionToast`（352）

**左侧栏（提取到 LeftSidebar）**：
- `leftExpanded`（337）、`leftHovered`（343）、`leftRetracting`（344）、`leftSidebarAutoExpand`（559）

**右侧栏（提取到 RightSidebar）**：
- `rightExpanded`（338）、`rightHovered`（340）、`rightRetracting`（342）、`rightExpandedWidth`（346）、`resizingRight`（348）、`rightSidebarAutoExpand`（557）

**工作区（提取到 WorkspaceBar，已存在 workspaces/ 目录）**：
- `workspaces`（366）、`currentWorkspaceId`（367）、`workspaceSnapshots`（369）、`workspaceManagerTarget`（429）、`tabCardMenu`（418）

**DevTools（提取到 DevToolsPanel，已存在 devtools/ 目录）**：
- `devtoolsOpen`（381）、`devtoolsWidth`（383）

**功能模块（提取到各功能组件）**：
- `dshStarting`（355）、`piServiceState`（358）、`translateActive`（954）、`selectionCard`（957）、`editorGuardAsk`（826）、`currentBookmarkId`（1763）

**全局设置（提取到 useSettings hook 或保留在 App）**：
- `sidebarHoverDelay`（555）、`searchEngine`（562）

**向导（保留在 App 或提取到 Onboarding）**：
- `step`（204）

### 2.2 useEffect 清单（28 个）

| 行号 | 归属 | 作用 | 提取到 |
|------|------|------|--------|
| 205 | 向导 | step 推进 | App/Onboarding |
| 274 | 全局 | tab 事件订阅 `tab:event` | ContentArea |
| 392 | 全局 | 拖拽文件处理 | ContentArea |
| 498 | 右侧栏 | 展开/收起动画 | RightSidebar |
| 511 | 右侧栏 | hover 展开 | RightSidebar |
| 523 | 右侧栏 | 收起过渡 | RightSidebar |
| 569 | 左侧栏 | hover 展开 | LeftSidebar |
| 574 | 左侧栏 | 收起过渡 | LeftSidebar |
| 643 | 工作区 | 加载工作区列表 | WorkspaceBar |
| 674 | 工作区 | 切换工作区 | WorkspaceBar |
| 696 | 工作区 | 快照轮询 | WorkspaceBar |
| 727 | 标签 | 激活标签导航 | ContentArea |
| 733 | 标签 | 加载时恢复标签 | ContentArea |
| 756 | 全局 | theme 应用 | App |
| 766 | 全局 | workspace:event 订阅 | App |
| 775 | 全局 | DEVTOOLS_TOGGLE 订阅 | DevToolsPanel |
| 839 | 编辑守卫 | closeNeedsGuard 检查 | ContentArea |
| 854 | 编辑守卫 | switchNeedsGuard 检查 | ContentArea |
| 994 | 翻译 | translateActive 管理 | ContentArea |
| 1012 | 翻译 | selectionCard 管理 | ContentArea |
| 1814 | 收藏夹 | picker 模式 | ContentArea |
| 1820 | 收藏夹 | picker 导航 | ContentArea |
| 1836 | 收藏夹 | picker 取消 | ContentArea |
| 1849 | 收藏夹 | picker 保存 | ContentArea |
| 1992 | DevTools | devtoolsWidth 持久化 | DevToolsPanel |
| 2219 | 全局 | piServiceState 轮询 | App |
| 2326 | 全局 | dsh 状态订阅 | App |
| 2333 | 全局 | transit drag 订阅 | ContentArea |

### 2.3 拆分步骤（7 步）

| 步骤 | 目标组件 | 提取的 state | 提取的 effect | 行数 | 风险 |
|------|----------|-------------|--------------|------|------|
| 1 | `<TabBar />` | tabs, activeTabId | 274(部分) | ~300 | 中 |
| 2 | `<LeftSidebar />` | leftExpanded, leftHovered, leftRetracting, leftSidebarAutoExpand | 569, 574 | ~200 | 低 |
| 3 | `<RightSidebar />` | rightExpanded, rightHovered, rightRetracting, rightExpandedWidth, resizingRight, rightSidebarAutoExpand | 498, 511, 523 | ~250 | 中 |
| 4 | `<ContentArea />` | contentZoom, translateActive, selectionCard, editorGuardAsk, currentBookmarkId | 392, 727, 733, 839, 854, 994, 1012, 1814-1849, 2333 | ~500 | 高 |
| 5 | `<DevToolsPanel />` 增强 | devtoolsOpen, devtoolsWidth | 775, 1992 | ~100 | 低 |
| 6 | `<WorkspaceBar />` 增强 | workspaces, currentWorkspaceId, workspaceSnapshots, tabCardMenu, workspaceManagerTarget | 643, 674, 696 | ~200 | 中 |
| 7 | App 精简 | 保留 step, sidebarHoverDelay, searchEngine, dshStarting, piServiceState + 全局 effect | 205, 756, 766, 2219, 2326 | ~300 | — |

### 2.4 props 传递策略

App 通过 props 向子组件传递：
- `tabs` / `activeTabId` / `onSetActive` → TabBar + ContentArea
- `leftExpanded` / `onToggleLeft` → LeftSidebar
- `rightExpanded` / `onToggleRight` → RightSidebar
- `currentWorkspaceId` / `onSwitchWorkspace` → WorkspaceBar

**替代方案**（如果 props 钻孔太深）：用 React Context 提供 `tabs` / `activeTabId` / `workspaces`，避免 3 层以上传递。

---

## Session 3: SettingsPage.tsx 拆分（设置页）

**文件**：`apps/desktop/src/renderer/settings/SettingsPage.tsx`（2087 行 → 目标 ~200 行）
**并行性**：可与 Session 1/4 并行；建议在 Session 2 后做（App.tsx 拆分后 ContentArea 会 import SettingsPage）

### 3.1 设置域分组

当前 10 个选项卡，对应以下常量和渲染块：

| Tab key | 标签 | 字段常量 | 渲染位置(行) | 组件? | 行数估计 |
|---------|------|---------|-------------|-------|---------|
| `general` | 通用 | `GENERAL_FIELDS`（130-203） | 550-560 | 内联 | ~70 |
| `clipper` | 剪藏 | `CLIPPER_FIELDS`（243-320） | 561-571 | 内联 | ~80 |
| `ops` | 操作 | `OPS_FIELDS`（204-242） | 572 | `OpsTab`（1004） | ~200 |
| `ai` | AI 助手 | 内联 | 573-580 | 内联 | ~60 |
| `data` | 数据 | `DATA_FIELDS`（321-335） | 581-588 | 内联 | ~60 |
| `files` | 默认应用 | — | 597 | `FilesTab`（1913） | ~170 |
| `help` | 帮助手册 | — | 598 | `HelpTab`（1527） | ~45 |
| `privacy` | 隐私与安全 | `PRIVACY_FIELDS`（336-403） | 589-596 | 内联 | ~60 |
| `feedback` | 建议与反馈 | — | 599 | `FeedbackTab`（1668） | ~100 |
| `about` | 关于 | — | 600 | `AboutTab`（1572） | ~100 |

已有独立组件：`OpsTab`、`FilesTab`、`HelpTab`、`FeedbackTab`、`AboutTab`（5 个）
需要提取：`general`、`clipper`、`ai`、`data`、`privacy`（5 个内联块）

### 3.2 自动保存逻辑

当前实现（SettingsPage.tsx 行 410 附近）：
- `entries` state 存储所有设置键值对
- `updateField(key, value)` 更新单个字段
- `useEffect` debounce 800ms 后调用 `settings.set` 批量保存
- `useEffect` 初始化时调用 `settings.getAll` 加载

提取为 hook：
```typescript
// settings/use-settings.ts
function useSettings(): {
  entries: Record<string, unknown>;
  updateField: (key: string, value: unknown) => void;
  loaded: boolean;
}
```

### 3.3 拆分步骤（7 步）

| 步骤 | 目标文件 | 提取内容 | 行数 | 风险 |
|------|----------|----------|------|------|
| 1 | `use-settings.ts` | 自动保存 hook（entries + debounce + getAll） | ~60 | 低 |
| 2 | `GeneralSection.tsx` | GENERAL_FIELDS + 渲染 | ~80 | 低 |
| 3 | `ClipperSection.tsx` | CLIPPER_FIELDS + 渲染 | ~80 | 低 |
| 4 | `AiSection.tsx` | AI 设置内联块 | ~60 | 低 |
| 5 | `DataSection.tsx` | DATA_FIELDS + 渲染 | ~60 | 低 |
| 6 | `PrivacySection.tsx` | PRIVACY_FIELDS + 渲染 | ~60 | 低 |
| 7 | SettingsPage 精简 | 仅保留选项卡导航 + Section 路由 | ~200 | — |

每个 Section 用 `React.memo` 包裹，只在自己的字段变化时重渲染。

### 3.4 关键约束

- `updateField` 的 debounce 800ms 必须保持不变
- `settings.*` IPC 调用方式不变（`window.urchin.invoke('settings.get', ...)` 等）
- 已有的 5 个组件（OpsTab/FilesTab/HelpTab/FeedbackTab/AboutTab）不需要改，只是从 SettingsPage 内部函数提升为独立文件

---

## Session 4: bookmark-panel.ts 拆分（收藏夹面板）

**文件**：`apps/desktop/src/main/panel/bookmark-panel.ts`（1187 行 → 目标 ~100 行）
**并行性**：可与 Session 1/2/3 并行（改的文件不重叠）

### 4.1 当前结构

```
bookmark-panel.ts (1187 行)
├── class BookmarkPanel (主进程 Electron BrowserWindow 管理)
│   ├── 创建子窗口、定位、跟随主窗口移动
│   ├── blur 关闭、动画
│   └── 加载 urchin://panel 协议
├── getBookmarkPanelScript() (返回 JS 字符串，~700 行)
│   ├── escapeHtml / faviconSlot / bindFaviconFallbacks
│   ├── loadTab(tab) — 切换 bookmarks/history/downloads
│   ├── renderBookmarks() — 收藏夹列表 + 面包屑 + 文件夹下钻
│   ├── renderHistory() — 历史记录按日期分组
│   ├── renderDownloads() — 下载列表 + 进度轮询
│   ├── bindBookmarkRows() / bindHistoryItems() / bindDownloadActions()
│   ├── saveBookmarkTo(parentId) — picker 模式保存
│   ├── startInlineRename(id) — 行内重命名
│   ├── deleteBookmarkNode(id) — 级联删除
│   └── startDownloadPolling() / stopDownloadPolling()
└── getBookmarkPanelHtml() (返回 HTML 字符串)
```

### 4.2 内联脚本的交互逻辑清单（必须完整迁移）

| 逻辑 | 行号范围 | 说明 |
|------|---------|------|
| tab 切换 | 82-96 | bookmarks/history/downloads 三 tab |
| 收藏夹列表渲染 | 111-160 | 调 `bookmark.list` IPC，渲染面包屑+列表 |
| 面包屑导航 | 162-201 | 文件夹下钻+返回 |
| 文件夹/书签行渲染 | 203-234 | folderRow + bookmarkRow HTML 拼接 |
| 行操作绑定 | 236-289 | 点击行 → 打开 URL；点击操作按钮 → 重命名/删除 |
| picker 模式 | 290-312 | 选择保存目标文件夹 |
| 保存书签到文件夹 | 312-330 | `bookmark.create` IPC |
| 行内重命名 | 332-368 | 双击 → input → blur 提交 |
| 级联删除 | 370-390 | confirm → `bookmark.delete` IPC |
| 新建文件夹 | 393-422 | prompt → `bookmark.create` IPC |
| 历史按日期分组 | 476-495 | 今天/昨天/日期 分组 |
| 历史列表渲染 | 492-555 | `history.list` IPC |
| 历史折叠 | 567-594 | 组头点击折叠/展开 |
| 下载进度轮询 | 596-605 | setInterval 500ms → `download.list` IPC |
| 下载行渲染 | 609-695 | 进度条+速度+大小+操作按钮 |
| 下载列表更新 | 698-755 | 增量更新 DOM（避免闪烁） |
| 下载操作绑定 | 757-778 | 暂停/恢复/取消/打开文件夹/清空 |
| 速度计算 | 609-635 | EMA 平滑测速 |

### 4.3 子窗口管理逻辑（保留在 BookmarkPanel 类中）

| 逻辑 | 行号 | 说明 |
|------|------|------|
| 窗口创建 | 构造函数 | BrowserWindow 280×430 |
| 定位 | show 方法 | 主窗口右下角吸附 |
| 跟随主窗口 | move/resize 监听 | 主窗口移动时重定位 |
| 点击外部关闭 | blur 事件 | 失焦时关闭面板 |
| 滑入动画 | CSS keyframes | translateY 滑入 |

### 4.4 拆分步骤（3 步）

| 步骤 | 目标 | 内容 | 风险 |
|------|------|------|------|
| 1 | `renderer/panel/BookmarkPanelApp.tsx` | React 版面板（3 tab + 所有交互逻辑） | 高（700 行 JS → React） |
| 2 | `vite.config.ts` 加 panel 入口 | 构建到 `dist/panel.js` + `dist/panel.html` | 低 |
| 3 | `panel/bookmark-panel.ts` 精简 | 改为 `loadFile('dist/panel.html')`，保留窗口管理 | 中 |

### 4.5 React 面板组件结构

```
renderer/panel/
├── BookmarkPanelApp.tsx    ← 主组件（tab 切换）
├── BookmarksTab.tsx        ← 收藏夹 tab（列表+面包屑+重命名+删除+新建）
├── HistoryTab.tsx          ← 历史 tab（按日期分组+折叠）
├── DownloadsTab.tsx        ← 下载 tab（进度轮询+速度+操作）
└── panel.css               ← 面板样式（从内联 HTML 提取）
```

### 4.6 关键约束

- 下载进度轮询的 500ms 间隔不变
- 速度计算的 EMA 平滑系数不变
- 面包屑导航的层级追踪逻辑不变
- picker 模式（从地址栏收藏按钮触发时显示"保存到"选项）不变
- 子窗口的定位/跟随/blur 关闭/滑入动画不变
- `bookmark.*` / `history.*` / `download.*` IPC 调用不变

---

## 验证 E2E spec 清单

每个 Session 完成后至少跑以下 spec：

| Session | 必须 spec | 推荐 spec |
|---------|----------|----------|
| 1 (index.ts) | launch, tab-order-repro | notebook |
| 2 (App.tsx) | launch, tab-order-repro, notebook | settings-page-component |
| 3 (SettingsPage) | settings-page-component | launch |
| 4 (panel) | launch | tab-order-repro |

命令：`pnpm e2e`（跑全部）或 `npx playwright test tests/e2e/<spec>.spec.ts`（单跑）

---

## 并行执行矩阵

| 组合 | 可并行？ | 冲突风险 |
|------|---------|---------|
| Session 1 + Session 2 | ✅ | 无（主进程 vs 渲染进程） |
| Session 1 + Session 3 | ✅ | 无（主进程 vs 渲染进程） |
| Session 1 + Session 4 | ✅ | 无（index.ts vs bookmark-panel.ts） |
| Session 2 + Session 3 | ⚠ 可以 | 不冲突（App.tsx vs SettingsPage.tsx），但 Session 2 拆完 App.tsx 后 ContentArea 的 import 路径更清晰 |
| Session 2 + Session 4 | ✅ | 无（App.tsx vs bookmark-panel.ts） |
| Session 3 + Session 4 | ✅ | 无（SettingsPage.tsx vs bookmark-panel.ts） |

**推荐**：Session 1 + Session 2 并行 → Session 3 → Session 4（或 Session 4 随时并行）
