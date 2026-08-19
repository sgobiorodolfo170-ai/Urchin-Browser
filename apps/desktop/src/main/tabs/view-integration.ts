/**
 * M2 Tab Manager · BrowserView 窗口集成
 *
 * 职责：
 * 1. tab 创建时将 BrowserView 挂载到所属窗口
 * 2. tab 激活时切换窗口的 BrowserView
 * 3. tab 移除时从窗口卸载 BrowserView
 * 4. 窗口 resize 时更新 BrowserView 的 bounds
 * 5. 将 TabManager 内部事件桥接到渲染进程（webContents.send）
 * 6. 维护布局状态（左侧栏/右侧栏/下侧栏宽高），据此调整 BrowserView bounds
 *
 * 设计理由：
 * TabManager 本身不感知窗口（仅持有 windowId），通过此集成层将 tab 事件
 * 翻译为对 BrowserWindow 的操作，保持 TabManager 的可测试性。
 *
 * 阶段2 解耦决策：
 * 移除 contentViewHidden 状态（不再有 AI 模式切换）。
 * AI 模块作为独立标签页（urchin://ai）存在，与 settings 一样由 React 渲染。
 * 通过 URL 判断决定 BrowserView 是否让出空间：
 * - urchin://settings / urchin://ai → ZERO_BOUNDS（React 渲染内部页面）
 * - 其他 URL → 非零 bounds（BrowserView 显示外部网页）
 */
import type { TabManager } from './tab-manager';
import type { TabSnapshot } from './types';
import type { WindowManager } from '../windows/window-manager';
import { createLogger } from '@urchin/logger';

const log = createLogger('view-integration');

/** 默认布局尺寸（px）
 *  左右侧栏启动默认折叠（与渲染进程 App.tsx 的 leftExpanded/rightExpanded 初始值保持同步），
 *  折叠宽度为 44px。 */
const DEFAULT_LEFT_WIDTH = 44;
const DEFAULT_RIGHT_WIDTH = 44;
const DEFAULT_BOTTOM_HEIGHT = 48;

/** 由渲染进程 React 组件渲染的内部 URL 前缀（不显示 BrowserView）。
 *  阶段2 解耦：settings 和 ai 都作为 React 渲染的内部页面；newtab 主页同为 React 渲染；
 *  file-viewer 本地文件查看器同为 React 渲染（文件路径经 ?path= 参数传入）。 */
const URCHIN_RENDERER_HOSTS = [
  'urchin://settings',
  'urchin://ai',
  'urchin://newtab',
  'urchin://file-viewer',
];

/** 判断 URL 是否应由渲染进程 React 组件渲染（而非 BrowserView）。
 *  注意：Electron 会把 urchin://settings 规范化为 urchin://settings/（末尾加斜杠），
 *  所以用 startsWith 判断，兼容两种形式。 */
function isRendererManagedUrl(url: string): boolean {
  if (!url) return false;
  return URCHIN_RENDERER_HOSTS.some((prefix) => url === prefix || url.startsWith(prefix + '/'));
}

/** 全零 bounds（用于隐藏 BrowserView） */
const ZERO_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

/** 事件推送通道名 */
const TAB_EVENT_CHANNEL = 'tab:event';

/** 推送到渲染进程的事件 payload */
export interface TabEventPayload {
  readonly type: 'created' | 'updated' | 'removed' | 'activated' | 'crashed';
  readonly snapshot: TabSnapshot;
}

/** 布局状态：左/右侧栏宽度 + 下侧栏高度 */
export interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  /** 临时隐藏 BrowserView（如收藏夹面板弹出时） */
  browserViewHidden: boolean;
}

/** 全局布局状态（v0.1 单窗口，简化为全局） */
const layoutState: LayoutState = {
  leftWidth: DEFAULT_LEFT_WIDTH,
  rightWidth: DEFAULT_RIGHT_WIDTH,
  bottomHeight: DEFAULT_BOTTOM_HEIGHT,
  browserViewHidden: false,
};

/**
 * 计算 BrowserView 的 bounds。
 * BrowserView 占据中间区域：x=leftWidth, y=0,
 * 宽度=windowWidth-leftWidth-rightWidth, 高度=windowHeight-bottomHeight。
 */
function computeViewBounds(windowBounds: { width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: layoutState.leftWidth,
    y: 0,
    width: Math.max(0, windowBounds.width - layoutState.leftWidth - layoutState.rightWidth),
    height: Math.max(0, windowBounds.height - layoutState.bottomHeight),
  };
}

/** 获取布局当前状态（供 IPC handler 调用） */
export function getLayoutState(): LayoutState {
  return { ...layoutState };
}

/**
 * 设置布局状态（供 IPC handler 调用），返回新状态。
 *
 * 阶段2 解耦：移除 contentHidden 字段（不再有 AI 模式切换）。
 * 为向后兼容，仍接受 contentHidden 入参但忽略（避免破坏既有 IPC 调用）。
 * browserViewHidden：临时隐藏 BrowserView（如收藏夹面板弹出时），避免遮挡弹出层。
 */
export function setLayoutState(next: {
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
  contentHidden?: boolean;
  browserViewHidden?: boolean;
}): LayoutState & { contentHidden: boolean } {
  if (next.leftWidth !== undefined) layoutState.leftWidth = next.leftWidth;
  if (next.rightWidth !== undefined) layoutState.rightWidth = next.rightWidth;
  if (next.bottomHeight !== undefined) layoutState.bottomHeight = next.bottomHeight;
  if (next.browserViewHidden !== undefined) layoutState.browserViewHidden = next.browserViewHidden;
  // contentHidden 已废弃：AI 模块改为独立标签页，不再需要全局隐藏 BrowserView。
  // 保留字段仅为了 ipc-schema 向后兼容，实际值固定为 false。
  return { ...layoutState, contentHidden: false };
}

/** 安装集成后的句柄，包含卸载函数与刷新 bounds 函数 */
export interface TabViewIntegrationHandle {
  /** 卸载所有监听 */
  dispose: () => void;
  /** 刷新所有窗口的 BrowserView bounds（SidePanel 状态变更后调用） */
  refreshAllViewBounds: () => void;
}

/**
 * 安装 TabManager ↔ WindowManager 集成。
 *
 * 订阅 TabManager 事件，自动管理 BrowserView 的挂载/切换/卸载，
 * 并将事件推送到对应窗口的渲染进程。
 */
export function installTabViewIntegration(
  tabManager: TabManager,
  windowManager: WindowManager,
): TabViewIntegrationHandle {
  /** 跟踪每个 tab 上次处理 bounds 时的 URL，避免相同 URL 重复 setBounds。
   *  网页加载过程中会频繁触发 updated 事件（did-start-loading / page-title-updated /
   *  page-favicon-updated / did-navigate 等），若每次都 setBounds 会导致 BrowserView
   *  反复重新布局，严重阻塞网页加载。仅在 URL 真正变化时才需要重新评估可见性。 */
  const lastBoundsUrlPerTab = new Map<number, string>();

  /** 为指定窗口的活跃 tab 设置 BrowserView bounds。
   *  优先级（从高到低）：
   *  1. isRendererManagedUrl（urchin://settings / urchin://ai）→ ZERO_BOUNDS（让 React 渲染内部页面）
   *  2. 其他 URL（外部网页 + 未识别的内部 URL）→ 非零 bounds
   *
   *  性能优化：通过 lastBoundsUrlPerTab 跟踪上次处理 URL，避免相同 URL 重复 setBounds。
   *  网页加载过程中会频繁触发 updated 事件，若每次都 setBounds 会导致 BrowserView
   *  反复重新布局，严重阻塞网页加载。 */
  function updateActiveViewBounds(windowId: number, force = false): void {
    const managed = windowManager.getWindow(windowId);
    if (!managed) return;
    const tabs = tabManager.query({ windowId });
    const activeTab = tabs.find((t) => t.active);
    if (!activeTab) return;
    const tab = tabManager.getTab(activeTab.id);
    if (!tab) return;

    // URL 去重：若 URL 未变化且非强制刷新，跳过 setBounds 避免重复布局。
    // 但 browserViewHidden / htmlFullscreen 状态变更时必须强制刷新（force 由调用方传入）。
    if (!force && lastBoundsUrlPerTab.get(activeTab.id) === activeTab.url) {
      return;
    }
    lastBoundsUrlPerTab.set(activeTab.id, activeTab.url);

    // 临时隐藏 BrowserView（如收藏夹面板弹出时）：
    // Electron BrowserView 始终渲染在主窗口 webContents 之上，不隐藏则 React 渲染的
    // 弹出层（收藏夹/历史面板）被遮挡且不可点击。面板关闭后 browserViewHidden 恢复 false。
    if (layoutState.browserViewHidden) {
      tab.view.setBounds(ZERO_BOUNDS);
      return;
    }

    // HTML5 全屏（内嵌视频点击全屏）：将 BrowserView 撑满整个窗口，
    // 覆盖浏览器 UI 栏（左/右侧边栏、地址栏），实现视频真正全屏。
    // 窗口已由 Electron 自动进入 OS 全屏（enter-html-full-screen 触发），
    // BrowserView 撑满后视频即占满屏幕。
    if (tab.htmlFullscreen) {
      const full = managed.browserWindow.getContentBounds();
      tab.view.setBounds({ x: 0, y: 0, width: full.width, height: full.height });
      return;
    }

    // React 渲染的内部页面（settings / ai）：隐藏 BrowserView，让 React 组件可见
    if (isRendererManagedUrl(activeTab.url)) {
      tab.view.setBounds(ZERO_BOUNDS);
      return;
    }

    // 外部网页 + 其他内部 URL：非零 bounds
    const bounds = computeViewBounds(managed.browserWindow.getContentBounds());
    // 防御性检查：确保 bounds 宽高不为零，否则网页不可见
    if (bounds.width <= 0 || bounds.height <= 0) {
      log.warn('computed bounds are zero or negative', {
        tabId: activeTab.id,
        url: activeTab.url,
        bounds,
      });
    }
    tab.view.setBounds(bounds);
  }

  /** 刷新所有窗口的 BrowserView bounds（SidePanel 状态变更后调用） */
  function refreshAllViewBounds(): void {
    for (const managed of windowManager.getAllWindows()) {
      // 布局状态变更（如侧边栏折叠/展开），必须强制刷新所有 bounds
      updateActiveViewBounds(managed.id, true);
    }
  }

  /** 推送事件到指定窗口的渲染进程 */
  function pushEvent(windowId: number, payload: TabEventPayload): void {
    const managed = windowManager.getWindow(windowId);
    if (!managed) return;
    managed.browserWindow.webContents.send(TAB_EVENT_CHANNEL, payload);
  }

  // tab 创建：挂载 BrowserView 到窗口（如果 tab 是活跃的）
  const onCreated = (snapshot: TabSnapshot): void => {
    if (snapshot.active) {
      const managed = windowManager.getWindow(snapshot.windowId);
      if (!managed) {
        log.warn('tab created but window not found', { windowId: snapshot.windowId });
        return;
      }
      const tab = tabManager.getTab(snapshot.id);
      if (!tab) return;
      managed.browserWindow.setBrowserView(tab.view);
      // setBrowserView 后必须 force=true 设置 bounds：新挂载的 BrowserView
      // 默认 bounds 为 {0,0,0,0}，即使 URL 去重命中也必须强制设置正确 bounds
      updateActiveViewBounds(snapshot.windowId, true);
    }
    pushEvent(snapshot.windowId, { type: 'created', snapshot });
  };

  // tab 更新：推送事件给渲染进程
  // 性能优化：URL 未变化时跳过 updateActiveViewBounds（避免频繁 setBounds 阻塞加载），
  // 但 pushEvent 仍需执行以同步渲染进程状态（loading / title / favicon 等）。
  // 为避免事件风暴，对 loading/title/favicon 等非关键更新做节流。
  let updatedThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingUpdatedSnapshot: TabSnapshot | null = null;
  /** 各 tab 上次的 HTML5 全屏态（全屏切换需强制刷新 bounds，URL 去重会跳过） */
  const lastFullscreenPerTab = new Map<number, boolean>();
  const onUpdated = (snapshot: TabSnapshot): void => {
    // URL 变更可能影响 BrowserView 可见性（如切换到/离开 urchin://settings / urchin://ai）
    if (snapshot.active) {
      const tab = tabManager.getTab(snapshot.id);
      // htmlFullscreen 变化时强制刷新：否则 URL 去重跳过，全屏/退出全屏不生效
      const fullscreenChanged =
        tab !== undefined &&
        tab.htmlFullscreen !== (lastFullscreenPerTab.get(snapshot.id) ?? false);
      if (fullscreenChanged) {
        lastFullscreenPerTab.set(snapshot.id, tab.htmlFullscreen);
      }
      updateActiveViewBounds(snapshot.windowId, fullscreenChanged);
    }
    // 节流 pushEvent：网页加载过程中 did-start-loading / page-title-updated /
    // page-favicon-updated / did-navigate 等事件密集触发，若每次都 IPC send 会导致
    // 渲染进程被 IPC 消息淹没，React 状态更新阻塞 UI。合并 16ms 内的 updated 事件。
    if (updatedThrottleTimer === null) {
      updatedThrottleTimer = setTimeout(() => {
        updatedThrottleTimer = null;
        if (pendingUpdatedSnapshot) {
          pushEvent(pendingUpdatedSnapshot.windowId, {
            type: 'updated',
            snapshot: pendingUpdatedSnapshot,
          });
          pendingUpdatedSnapshot = null;
        }
      }, 16);
      // 第一条事件立即发送，确保 loading 状态及时反馈
      pushEvent(snapshot.windowId, { type: 'updated', snapshot });
    } else {
      pendingUpdatedSnapshot = snapshot;
    }
  };

  // tab 激活：切换窗口的 BrowserView
  const onActivated = (snapshot: TabSnapshot): void => {
    const managed = windowManager.getWindow(snapshot.windowId);
    if (!managed) return;
    const tab = tabManager.getTab(snapshot.id);
    if (!tab) return;
    managed.browserWindow.setBrowserView(tab.view);
    // setBrowserView 后必须 force=true 设置 bounds：新挂载的 BrowserView
    // 默认 bounds 为 {0,0,0,0}，即使 URL 去重命中也必须强制设置正确 bounds。
    // 这是网站打开受阻的核心原因：之前 force=false 导致切 tab 后 bounds 不更新。
    updateActiveViewBounds(snapshot.windowId, true);
    pushEvent(snapshot.windowId, { type: 'activated', snapshot });
  };

  // tab 移除：从窗口卸载 BrowserView，必要时激活下一个 tab
  const onRemoved = (snapshot: TabSnapshot): void => {
    // 清理 URL 跟踪 Map，避免内存泄漏
    lastBoundsUrlPerTab.delete(snapshot.id);
    const managed = windowManager.getWindow(snapshot.windowId);
    if (managed && snapshot.active) {
      // 被移除的是活跃 tab，先卸载 view
      managed.browserWindow.setBrowserView(null);
      // TabManager.remove 内部已自动激活下一个 tab，onActivated 会重新挂载
    }
    pushEvent(snapshot.windowId, { type: 'removed', snapshot });
  };

  // tab 崩溃：推送事件
  const onCrashed = (snapshot: TabSnapshot): void => {
    pushEvent(snapshot.windowId, { type: 'crashed', snapshot });
  };

  tabManager.on('created', onCreated);
  tabManager.on('updated', onUpdated);
  tabManager.on('activated', onActivated);
  tabManager.on('removed', onRemoved);
  tabManager.on('crashed', onCrashed);

  // 监听所有现有窗口的 resize 事件
  const resizeListeners = new Map<number, () => void>();
  for (const managed of windowManager.getAllWindows()) {
    // resize 时必须强制刷新 bounds（窗口尺寸变化，bounds 必须重新计算）
    const handler = (): void => updateActiveViewBounds(managed.id, true);
    managed.browserWindow.on('resize', handler);
    resizeListeners.set(managed.id, handler);
  }

  // 监听新窗口创建
  const onWindowCreated = (windowId: number): void => {
    const managed = windowManager.getWindow(windowId);
    if (!managed) return;
    const handler = (): void => updateActiveViewBounds(windowId, true);
    managed.browserWindow.on('resize', handler);
    resizeListeners.set(windowId, handler);

    // 修复：窗口 ready-to-show 后重新挂载活跃 tab 的 BrowserView。
    //
    // 根因：主窗口以 show:false 创建，初始 tab 在窗口 show 之前就通过 onCreated
    // 调用了 setBrowserView + setBounds。BrowserView 挂载在隐藏窗口上时，
    // Electron 合成器可能不会正确初始化该 view 的渲染层，导致后续 setBounds
    // （导航触发 onUpdated）也无法让网页可见——只有再次调用 setBrowserView
    // （如切 tab 触发 onActivated）才能让 view 重新挂载并正确渲染。
    // 表现：打开网站后中区不显示网页，切到 pi 标签页再切回来才显示。
    //
    // 修复：监听窗口 ready-to-show（factory 的 ready-to-show handler 已先执行
    // win.show() 使窗口可见），在窗口可见后重新挂载活跃 tab 的 BrowserView
    // 并强制刷新 bounds，确保 view 渲染层正确初始化。浏览器基础功能优先级最高，
    // 此修复确保网页在首次导航时即可正确显示。
    managed.browserWindow.once('ready-to-show', () => {
      const tabs = tabManager.query({ windowId });
      const activeTab = tabs.find((t) => t.active);
      if (!activeTab) return;
      const tab = tabManager.getTab(activeTab.id);
      if (!tab) return;
      managed.browserWindow.setBrowserView(tab.view);
      updateActiveViewBounds(windowId, true);
      log.info('window ready-to-show, re-attached active BrowserView', {
        windowId,
        tabId: activeTab.id,
      });
    });
  };
  windowManager.on('window-created', onWindowCreated);

  log.info('tab view integration installed');

  const dispose = (): void => {
    if (updatedThrottleTimer !== null) {
      clearTimeout(updatedThrottleTimer);
      updatedThrottleTimer = null;
    }
    tabManager.off('created', onCreated);
    tabManager.off('updated', onUpdated);
    tabManager.off('activated', onActivated);
    tabManager.off('removed', onRemoved);
    tabManager.off('crashed', onCrashed);
    windowManager.off('window-created', onWindowCreated);
    log.info('tab view integration uninstalled');
  };

  return { dispose, refreshAllViewBounds };
}
