# 契约 D · M2 Tab Manager 状态与生命周期

> 状态：Draft  · 日期：2026-07-27  · 关联决策：TP1-TP6
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

多标签的核心数据结构、webContents 生命周期事件映射、跨进程状态同步策略。

关键约束：
- 主进程是 **Single Source of Truth**——所有 tab 状态权威值在主进程。
- 渲染进程 store 是 **镜像**，从不本地直接 mutate。
- AI 流式 token **不走这个 store**——走 MessagePort + Zustand transient updates（[contracts/B-ipc-protocol](./B-进程间通信协议.md) §6.4）。

## 2. 主进程 TabManager

```typescript
// apps/desktop/src/main/tabs/tab-manager.ts
import { EventEmitter } from 'events';
import { BrowserView, BrowserWindow, WebContents } from 'electron';

export type TabId = string;
export type WindowId = string;

export interface Tab {
  id: TabId;
  windowId: WindowId;
  url: string;
  title: string;
  favicon: string | null;
  loadingState: 'idle' | 'loading' | 'crashed';
  canGoBack: boolean;
  canGoForward: boolean;
  webContents: WebContents;        // 唯一持有者，永远不离开主进程
  view?: BrowserView;              // TP1 决策：BrowserView 形态
}

export interface TabSnapshot {
  // 给渲染进程的快照，不含 webContents（不可序列化）
  id: TabId;
  windowId: WindowId;
  url: string;
  title: string;
  favicon: string | null;
  loadingState: 'idle' | 'loading' | 'crashed';
  canGoBack: boolean;
  canGoForward: boolean;
}

export class TabManager extends EventEmitter {
  private tabs = new Map<TabId, Tab>();
  private windows = new Map<WindowId, Set<TabId>>();
  private activeTabPerWindow = new Map<WindowId, TabId>();

  create(props: TabCreateProps): Tab {
    const win = BrowserWindow.fromId(parseInt(props.windowId, 10));
    if (!win) throw new Error(`Window ${props.windowId} not found`);

    // TP1 决策：BrowserView 而非 WebContentsView
    const view = new BrowserView({
      webPreferences: {
        sandbox: true,               // M18
        contextIsolation: true,
        preload: require.resolve('./tab-preload.js'),
      },
    });
    win.addBrowserView(view);
    const webContents = view.webContents;

    const tab: Tab = {
      id: genId(),
      windowId: props.windowId,
      url: props.url ?? 'urchin://newtab',
      title: 'New Tab',
      favicon: null,
      loadingState: 'idle',
      canGoBack: false,
      canGoForward: false,
      webContents,
      view,
    };

    this.bindWebContentsEvents(tab);   // §3
    this.tabs.set(tab.id, tab);
    const set = this.windows.get(props.windowId) ?? new Set();
    set.add(tab.id);
    this.windows.set(props.windowId, set);

    if (props.url) {
      webContents.loadURL(props.url);
    }

    this.emit('created', tab);
    return tab;
  }

  query(info: TabQueryInfo): TabSnapshot[] {
    let result: Tab[] = Array.from(this.tabs.values());
    if (info.windowId) result = result.filter(t => t.windowId === info.windowId);
    return result.map(toSnapshot);
  }

  update(tabId: TabId, patch: Partial<Tab>): void {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    Object.assign(tab, patch);
    this.emit('updated', tab, patch);
  }

  remove(tabId: TabId): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const win = BrowserWindow.fromId(parseInt(tab.windowId, 10));
    if (win && tab.view) win.removeBrowserView(tab.view);
    tab.webContents.destroy();
    this.tabs.delete(tabId);
    this.windows.get(tab.windowId)?.delete(tabId);
    this.emit('removed', tabId);
  }

  setActive(windowId: WindowId, tabId: TabId): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.windowId !== windowId) throw new Error('Invalid');
    this.activeTabPerWindow.set(windowId, tabId);
    // 把 BrowserView 设为可见并调整 bounds
    const win = BrowserWindow.fromId(parseInt(windowId, 10));
    if (win && tab.view) {
      // 隐藏其他 tab 的 view，显示当前
      for (const otherId of this.windows.get(windowId) ?? []) {
        const other = this.tabs.get(otherId);
        if (other?.view) win.removeBrowserView(other.view);
      }
      win.addBrowserView(tab.view);
      tab.view.setBounds({ x: 0, y: 80, width: 800, height: 600 });  // TODO dynamic
    }
    this.emit('activated', tabId, windowId);
  }
}

function toSnapshot(tab: Tab): TabSnapshot {
  const { webContents: _wc, view: _v, ...snap } = tab;
  return snap;
}
```

**关键设计理由**：
- `webContents` 永远不离开主进程。渲染进程操作 tab 时引用的是 `tabId`，通过 IPC 让主进程执行实际操作。这是 Single Source of Truth 的硬约束。
- `TabSnapshot` 类型用于跨进程传输——剔除不可序列化的 `webContents` / `view` 字段。
- `setActive` 通过 add/remove BrowserView 实现 tab 切换可见性——Electron BrowserView 的标准模式。

## 3. webContents 生命周期 → Tab 状态映射

```typescript
function bindWebContentsEvents(tab: Tab): void {
  const wc = tab.webContents;

  wc.on('did-start-loading', () => {
    tab.loadingState = 'loading';
    this.emit('updated', tab, { loadingState: 'loading' });
  });

  wc.on('did-navigate', (_e, url, httpResponseCode, httpStatusText) => {
    tab.url = url;
    tab.canGoBack = wc.navigationHistory.canGoBack();
    tab.canGoForward = wc.navigationHistory.canGoForward();
    this.emit('updated', tab, { url, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward });

    // 同时通知 M6 History 记录
    history.record(url, tab.title).catch(/* log */);
  });

  wc.on('page-title-updated', (_e, title, explicitSet) => {
    tab.title = title;
    this.emit('updated', tab, { title });
  });

  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] ?? null;
    this.emit('updated', tab, { favicon: tab.favicon });
  });

  wc.on('did-finish-load', () => {
    tab.loadingState = 'idle';
    this.emit('updated', tab, { loadingState: 'idle' });
  });

  wc.on('render-process-gone', (_e, details) => {
    // TP3 决策：仅展示错误页，不自动 reload
    tab.loadingState = 'crashed';
    this.emit('crashed', tab, details);
  });

  wc.on('close', () => {
    this.remove(tab.id);
  });
}
```

**TP3 决策理由**：自动 reload 在循环崩溃场景下会死循环耗电耗 CPU，且用户体验糟糕。展示错误页让用户判断是否手动重载更稳健。

## 4. 渲染进程 Zustand store（镜像 + 订阅）

```typescript
// apps/desktop/src/renderer/stores/tabs.ts
import { create } from 'zustand';
import { invoke } from '../ipc/client';
import type { TabSnapshot, TabId, WindowId } from '@urchin/ipc-contract';

interface TabState {
  tabs: Record<TabId, TabSnapshot>;
  activeTabId: TabId | null;
  order: TabId[];

  create:  (props?: { url?: string }) => Promise<TabId>;
  close:   (tabId: TabId) => Promise<void>;
  setActive: (tabId: TabId) => Promise<void>;
  reload:  (tabId: TabId) => Promise<void>;
  goBack:  (tabId: TabId) => Promise<void>;
  goForward: (tabId: TabId) => Promise<void>;
}

export const useTabs = create<TabState>((set, get) => ({
  tabs: {},
  activeTabId: null,
  order: [],

  create: async (props) => {
    const windowId = getWindowId();   // 从 BrowserWindow 全局拿
    const { tabId } = await invoke('tab.create', { url: props?.url, windowId });
    // 不立即更新本地 store——等 Main 推 'tab.created' 事件回来再同步
    return tabId;
  },

  close: async (tabId) => {
    await invoke('tab.close', { tabId });
    // 同上，等事件
  },

  setActive: async (tabId) => {
    const windowId = getWindowId();
    await invoke('tab.setActive', { tabId });
  },

  reload:  async (tabId) => invoke('tab.reload', { tabId }),
  goBack:  async (tabId) => invoke('tab.goBack', { tabId }),
  goForward: async (tabId) => invoke('tab.goForward', { tabId }),
}));

// 订阅 Main 进程单向事件推送（TP2 决策）
import { ipcRenderer } from 'electron';

ipcRenderer.on('tab.created', (_e, tab: TabSnapshot) =>
  useTabs.setState(s => ({
    tabs: { ...s.tabs, [tab.id]: tab },
    order: [...s.order, tab.id],
  })),
);

ipcRenderer.on('tab.updated', (_e, { tabId, patch }: { tabId: TabId; patch: Partial<TabSnapshot> }) =>
  useTabs.setState(s => ({
    tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], ...patch } },
  })),
);

ipcRenderer.on('tab.removed', (_e, { tabId }: { tabId: TabId }) =>
  useTabs.setState(s => {
    const { [tabId]: _removed, ...rest } = s.tabs;
    return {
      tabs: rest,
      order: s.order.filter(id => id !== tabId),
      activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
    };
  }),
);

ipcRenderer.on('tab.activated', (_e, { tabId, windowId }: { tabId: TabId; windowId: WindowId }) => {
  if (windowId === getWindowId()) {
    useTabs.setState({ activeTabId: tabId });
  }
});

ipcRenderer.on('tab.crashed', (_e, { tabId }: { tabId: TabId }) =>
  useTabs.setState(s => ({
    tabs: { ...s.tabs, [tabId]: { ...s.tabs[tabId], loadingState: 'crashed' } },
  })),
);
```

**TP2 决策理由（事件推送 + invoke 改动）**：
- 渲染层 store 是镜像，从不本地直接 mutate——所有改动通过 IPC 让 Main 处理，Main 推送事件回来再更新 store。保证两端严格一致。
- 全双工闭环：UI 触发动作 → invoke → Main 处理 → emit 事件 → 渲染层 store 更新 → UI 自动 re-render。
- 不用「渲染层本地预占位」等优化——v0.1 优先一致性而非感知延迟。

## 5. 跨进程同步的事件协议

详见 [contracts/B-ipc-protocol](./B-进程间通信协议.md) §7，对应 schema：

```typescript
export const tabEventsSchema = {
  'tab.created':   z.object({ tab: TabSnapshotSchema }),
  'tab.updated':   z.object({ tabId: z.string(), patch: TabPatchSchema }),
  'tab.removed':   z.object({ tabId: z.string() }),
  'tab.activated': z.object({ tabId: z.string(), windowId: z.string() }),
  'tab.crashed':   z.object({ tabId: z.string(), details: z.object({ reason: z.string() }) }),
};
```

- Main 进程 `webContents.send(event, payload)`，render 进程 `ipcRenderer.on(event, cb)`。
- 推送前 Main 端 zod parse 一次，未通过的不推。
- WindowId 过滤：Main 推送 `tab.activated` 给所有窗口，渲染层按 `windowId === getWindowId()` 过滤，避免无关窗口污染本地 store。

## 6. 状态分片与多窗口

- `windowId` 是顶层分组——每个 BrowserWindow 独立一组 tabs，互不干扰。
- 单 store 内通过 `Record<TabId, TabSnapshot>` + `order: TabId[]` 表达顺序与所属（snapshot 里带 `windowId` 字段）。
- 渲染进程只关注自己 window 的 tabs——Main 推送时按 windowId 过滤，避免无关 window 的 tab 事件污染本地 store。
- **TP5 决策**：v0.1 禁用跨窗口拖拽（实现复杂、首版价值低）；v0.3+ 引入。

## 7. 持久化与会话恢复（TP4）

v0.1 仅持久化 url + title 列表，重启后恢复 tab 数量与基本状态，**不**恢复 scroll position / form state / session storage。

> 持久化的权威实现以 [contracts/H-storage §3](./H-存储层.md) 的 `windows` / `tabs` 关系表为准（有索引、可按 window 查询、支持级联删除）。下方代码为**逻辑示意**，实际读写走 M8 表结构而非 KV blob。

```typescript
// 退出时（逻辑示意——实际 upsert 到 M8 `windows` / `tabs` 表）
async function persistTabs(): Promise<void> {
  const snapshots = Array.from(tabManager.tabs.values()).map(toSnapshot);
  await storage.persistTabSession(snapshots);   // M8 facade，内部写 windows/tabs 表
}

// 启动时（逻辑示意——实际从 M8 表按 window_id 查询）
async function restoreTabs(): Promise<void> {
  const saved = await storage.loadTabSession();
  if (!saved) return;
  for (const snap of saved) {
    tabManager.create({ windowId: snap.windowId, url: snap.url });
  }
}
```

v0.5 引入完整 session restore（含 scroll position / form state，与 FR-PERSIST-02 对齐）——依赖 Electron `webContents.session.persistSessionStorage` 等高级 API。

## 8. 隐私模式 session 隔离（TP6）

FR-BROWSE-09 要求隐身窗口「不记录历史、不缓存表单输入、不持久化 Cookie」。落地方式：

- 隐身窗口的所有 tab 使用独立 session：`session.fromPartition('incognito-<windowId>')`，**不**带 `persist:` 前缀——partition 为纯内存态，Cookie / 缓存 / 表单数据随进程退出蒸发。
- M6 History：`did-navigate` 记录前检查 tab 所属 window 的 `isIncognito` 标记，隐身窗口跳过记录。
- M14 Page Context Extractor 对隐身 tab 同样可抽取（用户主动触发），但抽取结果不写入任何持久化存储。
- 隐身窗口的 tab 会话**不参与** §7 的持久化——关闭即销毁，重启不恢复。
- 窗口级标记：`Window.isIncognito` 由 M1 创建窗口时确定，不可中途切换；隐身窗口需有明确视觉标识（主题色 / 图标，M19 配合）。

## 9. 关键技术风险

| 风险 | 缓解 |
|---|---|
| BrowserView API 在 Electron 未来版本可能 deprecated | 监控 Electron release notes；v0.2+ 评估迁移到 WebContentsView |
| 多 tab 进程数线性增长 | v0.2+ 引入 process pooling（同源 tab 复用进程） |
| `webContents.navigationHistory` API 兼容性 | v0.1 锁定 Electron 稳定版（T1），监控 API 调用 |
| 重启后 session restore 不完整（仅 url） | v0.5 升级到完整 restore（FR-PERSIST-02），TP4 渐进计划 |
