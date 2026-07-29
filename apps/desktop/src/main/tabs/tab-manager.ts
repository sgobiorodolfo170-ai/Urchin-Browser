/**
 * M2 Tab Manager · 核心类
 *
 * 依据：契约 D §2 / 02-架构设计 §1 进程模型 / 04-模块全景 M2
 * 职责：
 * 1. 管理 Tab 集合（Map<TabId, Tab>）
 * 2. 按窗口分组（Map<WindowId, Set<TabId>>）
 * 3. 每窗口激活态管理（Map<WindowId, TabId>）
 * 4. create / remove / setActive / query / getSnapshot 方法
 * 5. 事件分发（created / updated / removed / activated / crashed）
 * 6. webContents 生命周期事件绑定（§3）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是 tab 状态的唯一权威源，渲染进程 store 只是镜像
 * - webContents/view 永远不离开主进程，渲染层通过 tabId + IPC 操作
 * - 通过 BrowserViewFactory 依赖注入，使核心逻辑可在单测中用 mock 验证
 * - TabSnapshot 剔除不可序列化字段，保证跨进程传输安全
 */
import type {
  BrowserViewFactory,
  CreateTabOptions,
  Tab,
  TabEvent,
  TabEventListener,
  TabSnapshot,
} from './types';

/** 默认 URL */
const DEFAULT_URL = 'about:blank';

/** 默认标题 */
const DEFAULT_TITLE = '';

export class TabManager {
  /** Tab 集合：tabId → Tab */
  private readonly tabs = new Map<number, Tab>();

  /** 窗口分片：windowId → Set<tabId> */
  private readonly windowTabs = new Map<number, Set<number>>();

  /** 每窗口激活的 tabId */
  private readonly activeTabPerWindow = new Map<number, number>();

  /** 事件监听器：event → listeners[] */
  private readonly listeners = new Map<TabEvent, TabEventListener[]>();

  /** 下一个分配的 tabId（单调递增，从 1 开始） */
  private nextId = 1;

  constructor(private readonly factory: BrowserViewFactory) {}

  /**
   * 创建新 Tab。
   *
   * @param opts 创建选项
   * @returns 新建的 Tab 实例
   */
  create(opts: CreateTabOptions): Tab {
    const id = this.nextId++;
    const view = this.factory();
    const webContents = view.webContents;

    const url = opts.url ?? DEFAULT_URL;

    // 计算窗口内的位置索引
    const windowSet = this.windowTabs.get(opts.windowId);
    const indexInWindow = opts.index ?? windowSet?.size ?? 0;

    // 是否激活：默认 true（如果该窗口还没有 tab 则必须激活）
    const hasActive = this.activeTabPerWindow.has(opts.windowId);
    const active = opts.active ?? !hasActive;

    const tab: Tab = {
      id,
      windowId: opts.windowId,
      url,
      title: DEFAULT_TITLE,
      active,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      indexInWindow,
      webContents,
      view,
    };

    // 绑定 webContents 事件
    this.bindWebContentsEvents(tab);

    // 加入集合
    this.tabs.set(id, tab);
    const set = this.windowTabs.get(opts.windowId) ?? new Set();
    set.add(id);
    this.windowTabs.set(opts.windowId, set);

    // 激活逻辑
    if (active) {
      this.deactivateOthersInWindow(opts.windowId, id);
      this.activeTabPerWindow.set(opts.windowId, id);
    }

    // 加载 URL
    if (url !== DEFAULT_URL) {
      webContents.loadURL(url);
    }

    this.emit('created', this.toSnapshot(tab));

    return tab;
  }

  /**
   * 移除 Tab。
   *
   * @param tabId 要移除的 tab ID
   * @throws 若 tab 不存在
   */
  remove(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    const snapshot = this.toSnapshot(tab);

    // 销毁 webContents
    tab.webContents.destroy();

    // 从集合移除
    this.tabs.delete(tabId);
    this.windowTabs.get(tab.windowId)?.delete(tabId);

    // 清理空窗口集合
    if (this.windowTabs.get(tab.windowId)?.size === 0) {
      this.windowTabs.delete(tab.windowId);
      this.activeTabPerWindow.delete(tab.windowId);
    } else if (tab.active) {
      // 如果移除的是激活 tab，自动激活同窗口的下一个 tab
      const remaining = this.windowTabs.get(tab.windowId);
      if (remaining && remaining.size > 0) {
        const nextActive = remaining.values().next().value;
        if (nextActive !== undefined) {
          const nextTab = this.tabs.get(nextActive);
          if (nextTab) {
            nextTab.active = true;
            this.activeTabPerWindow.set(tab.windowId, nextActive);
            this.emit('activated', this.toSnapshot(nextTab));
          }
        }
      }
    }

    this.emit('removed', snapshot);
  }

  /**
   * 设置激活 Tab。
   *
   * @param tabId 要激活的 tab ID
   * @throws 若 tab 不存在
   */
  setActive(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    // 已经是激活状态，无需操作
    if (tab.active) return;

    // 取消同窗口其他 tab 的激活态
    this.deactivateOthersInWindow(tab.windowId, tabId);

    // 激活当前 tab
    tab.active = true;
    this.activeTabPerWindow.set(tab.windowId, tabId);

    this.emit('activated', this.toSnapshot(tab));
  }

  /** 按 id 获取 Tab。 */
  getTab(tabId: number): Tab | undefined {
    return this.tabs.get(tabId);
  }

  /** 获取 Tab 数量。 */
  getCount(): number {
    return this.tabs.size;
  }

  /**
   * 查询 Tab 快照列表。
   *
   * @param info 查询条件（windowId 可选）
   * @returns TabSnapshot 数组
   */
  query(info: { windowId?: number }): TabSnapshot[] {
    let result = Array.from(this.tabs.values());
    if (info.windowId !== undefined) {
      result = result.filter((t) => t.windowId === info.windowId);
    }
    return result.map((t) => this.toSnapshot(t));
  }

  /** 获取 Tab 快照。 */
  getSnapshot(tabId: number): TabSnapshot | undefined {
    const tab = this.tabs.get(tabId);
    return tab ? this.toSnapshot(tab) : undefined;
  }

  /** 注册事件监听。 */
  on(event: TabEvent, listener: TabEventListener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  /** 移除事件监听。 */
  off(event: TabEvent, listener: TabEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) {
      arr.splice(idx, 1);
    }
  }

  /**
   * 绑定 webContents 生命周期事件。
   * 依据：契约 D §3
   *
   * 设计理由（agents.md §七.2）：
   * webContents 事件映射到 Tab 状态变更，保证状态与实际加载同步。
   */
  private bindWebContentsEvents(tab: Tab): void {
    const wc = tab.webContents;

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('did-finish-load', () => {
      tab.loading = false;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('did-navigate', (...args: unknown[]) => {
      const url = args[1];
      if (typeof url === 'string') {
        tab.url = url;
      }
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('page-title-updated', (...args: unknown[]) => {
      const title = args[1];
      if (typeof title === 'string') {
        tab.title = title;
      }
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('page-favicon-updated', (...args: unknown[]) => {
      const favicons = args[1];
      if (Array.isArray(favicons) && typeof favicons[0] === 'string') {
        tab.favicon = favicons[0];
      }
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('render-process-gone', () => {
      tab.crashed = true;
      tab.loading = false;
      this.emit('crashed', this.toSnapshot(tab));
    });
  }

  /** 取消同窗口其他 tab 的激活态。 */
  private deactivateOthersInWindow(windowId: number, exceptTabId: number): void {
    const set = this.windowTabs.get(windowId);
    if (!set) return;
    for (const tabId of set) {
      if (tabId !== exceptTabId) {
        const tab = this.tabs.get(tabId);
        if (tab) {
          tab.active = false;
        }
      }
    }
  }

  /** Tab → TabSnapshot（剔除不可序列化字段）。 */
  private toSnapshot(tab: Tab): TabSnapshot {
    return {
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      active: tab.active,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      crashed: tab.crashed,
      indexInWindow: tab.indexInWindow,
    };
  }

  /** 分发事件。 */
  private emit(event: TabEvent, snapshot: TabSnapshot): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      listener(snapshot);
    }
  }
}
