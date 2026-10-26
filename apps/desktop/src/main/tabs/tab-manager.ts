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
 * 设计理由（AGENTS.md §七.2 + §六 项目特化审查点「Single Source of Truth」）：
 * - 主进程是 tab 状态的唯一权威源，渲染进程 store 只是镜像
 * - webContents/view 永远不离开主进程，渲染层通过 tabId + IPC 操作
 * - 通过 BrowserViewFactory 依赖注入，使核心逻辑可在单测中用 mock 验证
 * - TabSnapshot 剔除不可序列化字段，保证跨进程传输安全
 */
import type {
  BrowserViewFactory,
  CreateTabOptions,
  FaviconResolver,
  Tab,
  TabEvent,
  TabEventListener,
  TabSnapshot,
  WebContentsLike,
  WindowOpenHandlerDetails,
  WindowOpenHandlerResponse,
} from './types';
import { buildAdBlockCss } from './ad-block-css';
import { DEFAULT_WORKSPACE_ID } from '@urchin/ipc-contract';

/** 默认 URL */
// 默认占位页：主页（urchin://newtab）。
// 主页占位设计（2026-08-15）：新建标签默认打开主页占位，打开网站时就地转为网站标签；
// 替代 about:blank 空白页，避免出现无内容空标签。
const DEFAULT_URL = 'urchin://newtab';

/** 默认标题
 *
 * 主页占位（urchin://newtab）由主窗口 React 覆盖层渲染，BrowserView 不加载该 URL
 *（见 create() 的 `if (url !== DEFAULT_URL)`），因此不会有 page-title-updated——
 * 留空会让标签侧栏回退显示原始 URL「urchin://newtab」（用户可见缺陷）。
 * 这里直接给新标签一个用户可读标题；一旦导航到真实页面，page-title-updated 会覆盖。 */
const DEFAULT_TITLE = '新标签页';

/** 链接打开行为 */
export type LinkOpenBehavior = 'new-tab' | 'current';

/**
 * 判定导航错误是否为"导航被中断"（ERR_ABORTED）。
 *
 * Electron 在页面自身发起重定向/跳转时会以 ERR_ABORTED (-3) 拒绝上一次
 * loadURL 的 Promise，属预期行为，不应作为错误记录（与 did-fail-load 分支一致）。
 */
function isAbortedError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: unknown }).code === 'ERR_ABORTED';
  }
  return false;
}

/**
 * 读取 webContents 的导航状态（canGoBack / canGoForward）。
 *
 * 优先使用 navigationHistory（Electron 27+ 本地同步查询）；无则回退到
 * 弃用的 webContents.canGoBack/canGoForward。
 *
 * 性能根因（2026-08-14 修复）：Electron 32 中弃用的 webContents.canGoBack
 * 在导航高峰期需跨进程查询渲染进程导航历史，会阻塞主进程事件循环——
 * 表现为"打开网页时明显卡顿"。navigationHistory 为本地同步查询，无跨进程开销。
 */
function readNavigationState(wc: WebContentsLike): { canGoBack: boolean; canGoForward: boolean } {
  if (wc.navigationHistory) {
    return {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }
  // 回退：测试 mock 或旧 Electron 未提供 navigationHistory
  return { canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
}

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

  /**
   * 链接打开行为解析器（由外部注入，读取设置决定新标签/当前标签打开）。
   * 未注入时默认 'current'（当前标签页打开）。
   */
  private linkBehaviorResolver?: (url: string) => LinkOpenBehavior;

  /**
   * 图标钉定解析器（dev.48，由外部注入）：window.open 新开标签时以来源 tab
   * 的 URL 调用，返回图标 URL 则钉定该标签图标（如 pi 页来源 → π 品牌图标）。
   */
  private piIconPinner?: (sourceUrl: string) => string | undefined;

  /**
   * favicon 解析器（由外部注入）：使用标签所属工作区 session 下载并缓存，
   * 返回 urchin://favicon/<hash>。未注入时退化为直接使用页面首个图标地址。
   */
  private faviconResolver?: FaviconResolver;

  /**
   * 每个 tab 的图标解析序号：导航或新 favicon 事件递增，
   * 异步下载完成后丢弃过期结果，防止旧页面图标覆盖新页面。
   */
  private readonly faviconSequences = new Map<number, number>();

  /** 广告浮窗屏蔽开关（DB1 决策：默认开启，由设置 blockAds 控制） */
  private adBlockEnabled = true;

  constructor(private readonly factory: BrowserViewFactory) {}

  /**
   * 注入链接打开行为解析器。
   *
   * 当用户点击网页内链接（window.open / target=_blank）时调用，
   * 返回 'new-tab' 在新标签页打开，返回 'current' 在当前标签页打开。
   *
   * @param resolver 解析器函数
   */
  setLinkBehaviorResolver(resolver: (url: string) => LinkOpenBehavior): void {
    this.linkBehaviorResolver = resolver;
  }

  /**
   * 注入图标钉定解析器（dev.48）。
   *
   * @param resolver 以来源 tab URL 调用，返回图标 URL 则钉定，undefined 不钉定
   */
  setPiIconPinner(resolver: (sourceUrl: string) => string | undefined): void {
    this.piIconPinner = resolver;
  }

  /**
   * 注入 favicon 解析器（主进程缓存）。
   *
   * @param resolver 按页面候选地址下载/缓存，返回协议 URL；失败返回 undefined
   */
  setFaviconResolver(resolver: FaviconResolver): void {
    this.faviconResolver = resolver;
  }

  /**
   * 设置广告浮窗屏蔽开关（DB1 决策）。
   *
   * 开启后新加载完成的页面自动注入屏蔽 CSS；对已加载的 tab 补注入（
   * reapplyAdBlock 由调用方遍历 query 触发）。
   */
  setAdBlockEnabled(enabled: boolean): void {
    this.adBlockEnabled = enabled;
  }

  /**
   * 对指定 tab 重新注入广告屏蔽 CSS（设置变更后由 index.ts 遍历现有 tab 调用）。
   * 忽略不可注入的页面（urchin:// 内部页无网页广告）。
   */
  applyAdBlock(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.adBlockEnabled) return;
    if (tab.url.startsWith('urchin://')) return;
    try {
      // WebContentsLike 是结构化接口（不含 insertCSS），运行时即 Electron WebContents
      const wc = tab.webContents as unknown as Electron.WebContents;
      void wc.insertCSS(buildAdBlockCss()).catch(() => {
        /* 忽略：页面可能已销毁 */
      });
    } catch {
      /* 忽略：注入失败不影响浏览 */
    }
  }

  /**
   * 创建新 Tab。
   *
   * @param opts 创建选项
   * @returns 新建的 Tab 实例
   */
  create(opts: CreateTabOptions): Tab {
    const id = this.nextId++;
    // 阶段 2：GenOffice 编辑器标签携带预构建 WebContentsView（调用方创建），
    // 其余走 BrowserView 工厂（保持原路径与单测注入语义）。
    const viewKind = opts.viewKind ?? 'browser';
    // TP7：解析工作区（未传则继承窗口活动标签的工作区，无活动标签 → 默认工作区）
    const workspaceId = opts.workspaceId ?? this.resolveWorkspaceForWindow(opts.windowId);
    const view = opts.view ?? this.factory(workspaceId);
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
      workspaceId,
      htmlFullscreen: false,
      viewKind,
      genofficeKind: opts.genofficeKind,
      dirty: false,
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

    // 加载 URL：genoffice 标签的视图已在工厂内加载编辑器页面，伪地址不可导航
    if (url !== DEFAULT_URL && viewKind === 'browser') {
      webContents.loadURL(url).catch((err: unknown) => {
        console.error(`[tab ${id}] initial loadURL failed:`, err);
      });
    }

    this.emit('created', this.toSnapshot(tab));

    return tab;
  }

  /**
   * 更新编辑器脏状态（阶段 2 GenOffice）：由编辑器 dirty 通道旁路监听调用，
   * 更新后广播 updated，透出到渲染层侧栏脏点。
   */
  setDirty(tabId: number, dirty: boolean): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.viewKind !== 'genoffice') return;
    if (tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.emit('updated', this.toSnapshot(tab));
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
    this.faviconSequences.delete(tabId);
    this.windowTabs.get(tab.windowId)?.delete(tabId);

    // 先发 removed 再发 activated（2026-08-14 修复）：
    // 此前先 activated（view-integration 挂载下一个 tab 的 BrowserView + 设 bounds），
    // 后 removed（view-integration 的 onRemoved 会 setBrowserView(null) 卸载当前 view）——
    // 导致关闭标签后激活回来的网页 BrowserView 被卸载，网页不显示（白屏/被覆盖）。
    // 先 removed（卸载旧 view）→ 再 activated（挂载下一个）顺序正确。
    this.emit('removed', snapshot);

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

  /**
   * 按 webContents 查找所属 Tab（右键菜单等 webContents 事件回调场景用）。
   *
   * context-menu 等 Electron 事件携带的是 webContents 实例而非 tabId，
   * 经此方法反查 tab 归属，获取 url / title 等用于菜单动作（如保存网页默认文件名）。
   * 遍历 Map（tab 数量级小，无需额外索引）。
   */
  getTabByWebContents(wc: unknown): Tab | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.webContents === wc) return tab;
    }
    return undefined;
  }

  /** 获取 Tab 数量。 */
  getCount(): number {
    return this.tabs.size;
  }

  /**
   * 导航到指定 URL（M3 Navigation Stack）。
   *
   * 包装 webContents.loadURL，更新 tab 状态。
   * 实际的 navigation history 由 Electron webContents 内部管理。
   *
   * 固化教训：loadURL 失败时必须重置 loading 状态，否则 tab 永久卡在 loading。
   * did-fail-load 事件会处理大部分情况，但 Promise 拒绝也需要兜底。
   *
   * @param tabId 目标 tab ID
   * @param url 要加载的 URL
   * @throws 若 tab 不存在
   */
  loadUrl(tabId: number, url: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    // 立即更新 URL（did-navigate 事件会确认最终 URL，含重定向）
    tab.url = url;
    tab.loading = true;
    this.emit('updated', this.toSnapshot(tab));

    // 处理 loadURL 的 Promise 拒绝（防止 unhandled rejection）
    // 固化：失败时重置 loading 状态，避免 tab 永久卡在 loading
    tab.webContents.loadURL(url).catch((err: unknown) => {
      console.error(`[tab ${tabId}] loadURL failed:`, err);
      tab.loading = false;
      this.emit('updated', this.toSnapshot(tab));
    });
  }

  /**
   * 停止加载当前页面（M3 Navigation Stack）。
   *
   * @param tabId 目标 tab ID
   * @throws 若 tab 不存在
   */
  stopLoading(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    tab.webContents.stop();
    tab.loading = false;
    this.emit('updated', this.toSnapshot(tab));
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
    // 右侧边栏倒推排序：新建的标签页始终在最上面。
    // id 单调递增 = 创建顺序，降序即最新在前（LIFO 栈式列表）。
    return result.sort((a, b) => b.id - a.id).map((t) => this.toSnapshot(t));
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
   * 设计理由（AGENTS.md §七.2）：
   * webContents 事件映射到 Tab 状态变更，保证状态与实际加载同步。
   */
  private bindWebContentsEvents(tab: Tab): void {
    const wc = tab.webContents;

    // 拦截 window.open / target=_blank 链接点击
    // 根据设置决定在当前标签页打开还是新标签页打开（默认当前标签页）
    // 阶段 2：GenOffice 编辑器内链接一律交浏览器新标签承载，绝不让编辑器
    // webContents 自身导航（编辑器页面一旦被外部站点替换即状态丢失）
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }: WindowOpenHandlerDetails): WindowOpenHandlerResponse => {
        // 忽略空 URL 和 about:blank
        if (!url || url === 'about:blank') {
          return { action: 'deny' };
        }

        if (tab.viewKind === 'genoffice') {
          this.create({ windowId: tab.windowId, url, active: true, workspaceId: tab.workspaceId });
          return { action: 'deny' };
        }

        const behavior = this.linkBehaviorResolver?.(url) ?? 'current';
        if (behavior === 'new-tab') {
          // 在新标签页打开（继承来源标签的工作区，保证同一账号上下文）
          const created = this.create({
            windowId: tab.windowId,
            url,
            active: true,
            workspaceId: tab.workspaceId,
          });
          // dev.48：pi 模块内打开的网页，右侧栏图标钉定为 π 品牌图标
          //（来源 tab 即 pi 页时，解析器返回钉定图标 URL）
          const pinnedIcon = this.piIconPinner?.(tab.url);
          if (created && pinnedIcon) {
            created.favicon = pinnedIcon;
            created.piIconPinned = true;
            this.emit('updated', this.toSnapshot(created));
          }
        } else {
          // 在当前标签页打开
          tab.url = url;
          tab.loading = true;
          this.emit('updated', this.toSnapshot(tab));
          wc.loadURL(url).catch((err: unknown) => {
            // ERR_ABORTED (-3)：本次导航被页面自身导航/重定向中断（如目标页立即跳转），
            // 属预期行为，静默忽略；其余错误才记录。
            if (isAbortedError(err)) return;
            console.error(`[tab ${tab.id}] window-open loadURL failed:`, err);
          });
        }
        // 总是 deny，阻止 Electron 创建新 BrowserWindow
        return { action: 'deny' };
      });
    }

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit('updated', this.toSnapshot(tab));
    });

    wc.on('did-finish-load', () => {
      tab.loading = false;
      const nav = readNavigationState(wc);
      tab.canGoBack = nav.canGoBack;
      tab.canGoForward = nav.canGoForward;
      this.emit('updated', this.toSnapshot(tab));
      // 广告浮窗屏蔽（DB1 决策）：页面加载完成后注入隐藏 CSS（CSS 全局生效，
      // 后续 SPA 动态创建的浮窗同样被规则覆盖，无需重复注入）
      this.applyAdBlock(tab.id);
    });

    // 加载失败：重置 loading 状态，记录错误（防止 tab 永久卡在 loading）
    wc.on('did-fail-load', (...args: unknown[]) => {
      const errorCode = args[1];
      const errorDescription = args[2];
      const validatedUrl = args[3];

      // ERR_ABORTED (-3) 是导航被中断（如用户点击了另一个链接），不算真正的失败
      if (errorCode === -3) return;

      tab.loading = false;
      const nav = readNavigationState(wc);
      tab.canGoBack = nav.canGoBack;
      tab.canGoForward = nav.canGoForward;
      this.emit('updated', this.toSnapshot(tab));

      // 记录加载失败详情（便于调试）
      console.error(`[tab ${tab.id}] did-fail-load:`, {
        errorCode,
        errorDescription:
          typeof errorDescription === 'string' ? errorDescription : String(errorDescription),
        url: typeof validatedUrl === 'string' ? validatedUrl : tab.url,
      });
    });

    // 加载停止兜底：确保 loading 状态最终被清理
    wc.on('did-stop-loading', () => {
      if (tab.loading) {
        tab.loading = false;
        const nav = readNavigationState(wc);
        tab.canGoBack = nav.canGoBack;
        tab.canGoForward = nav.canGoForward;
        this.emit('updated', this.toSnapshot(tab));
      }
    });

    // 主框架导航开始：清空旧页面图标并作废旧解析任务。
    // 若不清空，新页面没有 favicon 时标签会残留上一站点图标（用户可见错配）。
    wc.on('did-start-navigation', (...args: unknown[]) => {
      const isInPlace = args[2];
      const isMainFrame = args[3];
      if (isInPlace === true || isMainFrame === false || tab.piIconPinned) return;

      this.faviconSequences.set(tab.id, (this.faviconSequences.get(tab.id) ?? 0) + 1);
      if (tab.favicon !== undefined) {
        tab.favicon = undefined;
        this.emit('updated', this.toSnapshot(tab));
      }
    });

    wc.on('did-navigate', (...args: unknown[]) => {
      const url = args[1];
      // 阶段 2：genoffice 标签的 URL 是稳定伪地址（编辑器页面在 genoffice-app://
      // 下加载，其导航事件不得覆盖伪地址——否则标签身份/路由判定失效）
      if (typeof url === 'string' && tab.viewKind === 'browser') {
        tab.url = url;
      }
      const nav = readNavigationState(wc);
      tab.canGoBack = nav.canGoBack;
      tab.canGoForward = nav.canGoForward;
      this.emit('updated', this.toSnapshot(tab));
    });

    // 页内导航（pushState/hashChange）：更新前进后退可用性。
    // GenOffice 编辑器内部导航（如切换文档）经此事件触发，canGoBack/canGoForward 随之刷新。
    wc.on('did-navigate-in-page', () => {
      const nav = readNavigationState(wc);
      tab.canGoBack = nav.canGoBack;
      tab.canGoForward = nav.canGoForward;
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
      // dev.48：钉定图标的 tab（pi 模块打开的网页）不被页面真实 favicon 覆盖
      if (tab.piIconPinned) return;

      const candidates = Array.isArray(favicons)
        ? favicons.filter((item): item is string => typeof item === 'string')
        : [];

      // 未注入解析器（单测/旧路径）：保留直接透传首个候选的历史行为。
      if (!this.faviconResolver) {
        if (candidates[0]) {
          tab.favicon = candidates[0];
          this.emit('updated', this.toSnapshot(tab));
        }
        return;
      }

      const sequence = (this.faviconSequences.get(tab.id) ?? 0) + 1;
      this.faviconSequences.set(tab.id, sequence);

      void this.faviconResolver({
        pageUrl: tab.url,
        candidates,
        workspaceId: tab.workspaceId,
      })
        .then((favicon) => {
          // 标签已关闭/复用、导航已发生或已有更新事件 → 丢弃过期结果
          if (this.tabs.get(tab.id) !== tab) return;
          if (this.faviconSequences.get(tab.id) !== sequence) return;
          if (tab.piIconPinned || tab.favicon === favicon) return;
          tab.favicon = favicon;
          this.emit('updated', this.toSnapshot(tab));
        })
        .catch((err: unknown) => {
          if (this.tabs.get(tab.id) !== tab) return;
          if (this.faviconSequences.get(tab.id) !== sequence) return;
          console.error(`[tab ${tab.id}] favicon resolve failed:`, err);
          if (tab.favicon !== undefined) {
            tab.favicon = undefined;
            this.emit('updated', this.toSnapshot(tab));
          }
        });
    });

    wc.on('render-process-gone', () => {
      tab.crashed = true;
      tab.loading = false;
      this.emit('crashed', this.toSnapshot(tab));
    });

    // HTML5 全屏（如内嵌视频点击全屏）：更新 tab.htmlFullscreen 并推送 updated 事件。
    // view-integration 据此将 BrowserView 撑满整个窗口，覆盖浏览器 UI 栏
    // （左/右侧边栏、地址栏）；退出全屏时恢复常规布局。
    wc.on('enter-html-full-screen', () => {
      tab.htmlFullscreen = true;
      this.emit('updated', this.toSnapshot(tab));
    });
    wc.on('leave-html-full-screen', () => {
      tab.htmlFullscreen = false;
      this.emit('updated', this.toSnapshot(tab));
    });
  }

  /**
   * 销毁所有 tab 的 webContents（进程退出清理用）。
   *
   * BrowserView 的 webContents 不会被 BrowserWindow.destroy() 自动回收，
   * 需显式 destroy 以释放底层渲染进程线程与 GPU 资源，避免退出后残留进程。
   */
  disposeAll(): void {
    for (const tab of this.tabs.values()) {
      try {
        tab.webContents.destroy();
      } catch {
        // 忽略：webContents 可能已销毁
      }
    }
    this.tabs.clear();
    this.windowTabs.clear();
    this.activeTabPerWindow.clear();
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

  /**
   * 解析「未显式指定工作区」的建标签请求应归属的工作区（TP7）：
   * 继承窗口当前活动标签的工作区；无活动标签（如首开标签）→ 默认工作区。
   */
  private resolveWorkspaceForWindow(windowId: number): string {
    const activeId = this.activeTabPerWindow.get(windowId);
    if (activeId !== undefined) {
      const active = this.tabs.get(activeId);
      if (active) return active.workspaceId;
    }
    return DEFAULT_WORKSPACE_ID;
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
      workspaceId: tab.workspaceId,
      viewKind: tab.viewKind,
      dirty: tab.dirty,
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
