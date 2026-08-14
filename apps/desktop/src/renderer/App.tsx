/**
 * Urchin Browser · 根组件
 *
 * 布局：左侧栏 | 中间列(ContentArea + 下侧地址栏) | 右侧栏
 * - 左侧栏：顶部折叠/展开按钮，底部 AI 入口 + 设置入口 + 主题切换
 * - 中间列：上方 ContentArea（BrowserView / SettingsPage / AiChatView），下方下侧边栏（地址栏 + 导航按钮）
 * - 右侧栏：标签页列表，底部折叠/展开按钮
 * - 左右侧栏夹住下侧地址栏
 *
 * 阶段2 解耦决策：
 * - AI 模块改为独立标签页（urchin://ai），不再融合到地址栏
 * - 地址栏回归纯 URL 输入职责
 * - 左侧栏底部新增 AI 入口按钮，点击创建/激活 urchin://ai 标签页
 * - 移除右侧栏的 AI 会话选项卡（会话列表将在阶段3 重构为 AI 标签页内的左区）
 * - 移除 contentViewHidden / omniboxMode / aiStreaming 状态
 *
 * 事件订阅：通过 window.urchin.on('tab:event', ...) 接收主进程推送的 tab 状态变更
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Moon,
  Sun,
  Settings as SettingsIcon,
  Sparkles,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  List as ListIcon,
  Folder,
  FolderOpen,
  FileText,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Omnibox } from './omnibox/omnibox';
import { AiChatView } from '@urchin/ai-extension';
import { SettingsPage } from './settings/SettingsPage';
import { NewTabPage } from './home/NewTabPage';
import { PiSettingsDialog } from './omnibox/pi-settings-dialog';
import { useTheme } from './theme/theme-provider';
import { createHostFromUrchin } from './host-impl';
import type { Suggestion } from './omnibox/types';
import { buildSuggestions } from './omnibox/build-suggestions';
import { cn } from './lib/utils';

// Tab 快照类型（与主进程 TabSnapshot 对齐）
interface TabSnapshot {
  readonly id: number;
  readonly windowId: number;
  readonly url: string;
  readonly title: string;
  readonly favicon?: string;
  readonly active: boolean;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly crashed: boolean;
  readonly indexInWindow: number;
}

interface TabEventPayload {
  readonly type: 'created' | 'updated' | 'removed' | 'activated' | 'crashed';
  readonly snapshot: TabSnapshot;
}

declare global {
  interface Window {
    readonly urchin: {
      invoke: <C extends string>(channel: C, req: unknown) => Promise<unknown>;
      on: (channel: string, callback: (payload: unknown) => void) => () => void;
      onMessagePort: (
        channel: string,
        callback: (
          payload: unknown,
          port: { onmessage: ((e: { data: unknown }) => void) | null; start: () => void },
        ) => void,
      ) => () => void;
      readonly platform: string;
      readonly versions: {
        readonly electron: string;
        readonly chrome: string;
        readonly node: string;
      };
    };
  }
}

/** 布局尺寸常量（与主进程 view-integration.ts 对齐） */
const LEFT_EXPANDED = 220;
const LEFT_COLLAPSED = 44;
const RIGHT_EXPANDED = 360;
const RIGHT_COLLAPSED = 44;
const BOTTOM_HEIGHT = 48;
/** 右侧边栏宽度拖拽调节范围（px） */
const RIGHT_MIN = 120;
const RIGHT_MAX = 600;
/** 右侧边栏宽度持久化 settings key（拖拽调节后记录位置，重启恢复） */
const RIGHT_SIDEBAR_WIDTH_KEY = 'ui.rightSidebarWidth';

function getSecurityState(url: string): 'secure' | 'insecure' | 'mixed' {
  if (url.startsWith('https://')) return 'secure';
  return 'insecure';
}

function isBookmarkable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * 摘要文档目录树节点（与主进程 SummaryTreeNode 对齐）。
 * 数据空间入口：左侧边栏以此树展示本地保存的摘要文档。
 */
interface SummaryTreeNode {
  readonly type: 'directory' | 'file';
  readonly name: string;
  readonly relativePath: string;
  readonly children?: readonly SummaryTreeNode[];
  readonly absolutePath?: string;
}

/**
 * 摘要文档目录树视图（数据空间入口）。
 *
 * 渲染规则：
 * - directory 节点：可展开/折叠，默认展开
 * - file 节点：点击调用 onOpenDoc，在新标签页打开 HTML 文档
 */
function SummaryTreeView({
  nodes,
  loading,
  onOpenDoc,
}: {
  nodes: readonly SummaryTreeNode[];
  loading: boolean;
  onOpenDoc: (absolutePath: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        加载中…
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-secondary">
        暂无摘要文档
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-1">
      {nodes.map((node) => (
        <SummaryTreeItem key={node.relativePath} node={node} depth={0} onOpenDoc={onOpenDoc} />
      ))}
    </div>
  );
}

function SummaryTreeItem({
  node,
  depth,
  onOpenDoc,
}: {
  node: SummaryTreeNode;
  depth: number;
  onOpenDoc: (absolutePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const paddingLeft = 8 + depth * 12;

  if (node.type === 'file') {
    return (
      <button
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-surface hover:text-text"
        style={{ paddingLeft }}
        onClick={() => node.absolutePath && onOpenDoc(node.absolutePath)}
        title={node.name}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-text hover:bg-surface"
        style={{ paddingLeft }}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        {expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="flex-1 truncate">{node.name}</span>
      </button>
      {expanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <SummaryTreeItem
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              onOpenDoc={onOpenDoc}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 标签页图标（展开态与折叠态共用）：
 *  加载中 → spinner；崩溃 → 红叉；urchin://ai → Sparkles；urchin://settings → 齿轮；
 *  普通网页 → 灰点（v0.1 无真实 favicon 源，占位）。 */
function TabFavicon({ tab, className }: { tab: TabSnapshot; className?: string }) {
  if (tab.loading) {
    return (
      <div
        className={cn(
          'shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent',
          className ?? 'h-3 w-3',
        )}
      />
    );
  }
  if (tab.crashed) {
    return <X className={cn('shrink-0 text-error', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://ai')) {
    return <Sparkles className={cn('shrink-0 text-primary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://settings')) {
    return <SettingsIcon className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  return (
    <div className={cn('shrink-0 rounded-full border border-border', className ?? 'h-3 w-3')} />
  );
}

/**
 * 按住侧边栏空白处拖动窗口（手动实现，非 -webkit-app-region）。
 *
 * -webkit-app-region: drag 会吞掉鼠标事件（双击展开/折叠、悬停自动展开失效），
 * 故手动：pointerdown 记录起点，移动超过阈值（3px）才真正拖窗，经 IPC
 * ui.window.dragBy 发送屏幕坐标增量，主进程移动窗口。
 * - 交互元素（按钮/输入/拖拽手柄等）上不触发拖窗（保留原有交互）
 * - 未超阈值的按下-抬起视为点击/双击，不受影响
 */
function useWindowDrag() {
  const dragStateRef = useRef<{
    lastX: number;
    lastY: number;
    started: boolean;
    captureEl?: HTMLElement;
    pointerId?: number;
  } | null>(null);

  const endDrag = useCallback(() => {
    const st = dragStateRef.current;
    // 主动释放指针捕获：不释放的话捕获残留在侧边栏元素上，
    // 拖窗时指针移出窗口导致 pointerup 错过，后续所有点击被吞（表现为卡死/无法操作）。
    if (st?.captureEl && st.pointerId !== undefined) {
      try {
        st.captureEl.releasePointerCapture(st.pointerId);
      } catch {
        /* 指针未捕获/已释放，忽略 */
      }
    }
    dragStateRef.current = null;
  }, []);

  // 兜底清理：拖拽期间 pointerup/pointercancel 若在侧边栏元素外错过（如拖窗时指针
  // 短暂移出窗口再松开），捕获会永久卡在侧边栏上。在 window 层兜底监听，
  // 任何位置松手都能清除拖拽状态。
  useEffect(() => {
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [endDrag]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    // 交互元素上不触发窗口拖拽
    if (target.closest('button, input, select, textarea, a, [role="button"], [role="separator"]')) {
      return;
    }
    dragStateRef.current = { lastX: e.screenX, lastY: e.screenY, started: false };
    // 捕获指针：拖出元素后仍持续接收 move/up（jsdom 无此方法时跳过）
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
        dragStateRef.current.captureEl = el;
        dragStateRef.current.pointerId = e.pointerId;
      } catch {
        /* 指针已捕获（如旧拖拽状态未清），忽略，仍可拖拽 */
      }
    }
  }, []);

  const moveDrag = useCallback((e: React.PointerEvent) => {
    const st = dragStateRef.current;
    if (!st) return;
    // 未超阈值：视为点击/双击，不拖窗
    if (!st.started) {
      const dist = Math.hypot(e.screenX - st.lastX, e.screenY - st.lastY);
      if (dist < 3) return;
      st.started = true;
    }
    const dx = e.screenX - st.lastX;
    const dy = e.screenY - st.lastY;
    st.lastX = e.screenX;
    st.lastY = e.screenY;
    void window.urchin.invoke('ui.window.dragBy', { dx, dy }).catch(() => {
      // 主进程窗口移动失败静默（测试环境等）
    });
  }, []);

  return { startDrag, moveDrag, endDrag };
}

export function App() {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- useTheme 返回的 toggleTheme 是稳定引用
  const { theme, toggleTheme } = useTheme();
  const [tabs, setTabs] = useState<readonly TabSnapshot[]>([]);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  // 启动默认折叠：左右侧边栏初始为折叠态，用户可手动展开
  const [leftExpanded, setLeftExpanded] = useState(false);
  const [rightExpanded, setRightExpanded] = useState(false);
  // 右侧栏折叠时的悬停预览展开：鼠标移入自动展开，移出回弹收起
  const [rightHovered, setRightHovered] = useState(false);
  // 回弹动画标记：为 true 时使用带过冲的弹性缓动，营造"有力度"的回弹感
  const [rightRetracting, setRightRetracting] = useState(false);
  /** 右侧边栏展开时的宽度（可拖拽调节，默认 RIGHT_EXPANDED；持久化于 settings） */
  const [rightExpandedWidth, setRightExpandedWidth] = useState<number>(RIGHT_EXPANDED);
  /** 右侧边栏拖拽调节中（禁用宽度 transition，保证跟手） */
  const [resizingRight, setResizingRight] = useState(false);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkToast, setBookmarkToast] = useState<string | null>(null);
  // 网页内容提取（AI 助手）：一键提取当前网页正文并保存到本地
  // 按钮位于地址栏 omnibox.tsx，点击直接调用 summary.run IPC（纯本地操作，不依赖 LLM）
  const [summaryRunning, setSummaryRunning] = useState(false);
  const [summaryToast, setSummaryToast] = useState<string | null>(null);
  // pi 设置对话框显示状态：齿轮按钮位于 AiChatView 中区 header 右上角，
  // 通过此状态与 PiSettingsDialog 解耦（PiSettingsDialog 在 App.tsx 渲染）
  const [showPiSettings, setShowPiSettings] = useState(false);

  // 摘要文档目录树（左侧边栏数据空间入口）
  // 左侧边栏展开时显示已保存的摘要文档树，点击叶节点在新标签页打开
  const [summaryTree, setSummaryTree] = useState<readonly SummaryTreeNode[]>([]);
  const [summaryTreeLoading, setSummaryTreeLoading] = useState(false);

  /** 加载摘要文档目录树 */
  const loadSummaryTree = useCallback(async () => {
    setSummaryTreeLoading(true);
    try {
      const result = (await window.urchin.invoke('summary.listTree', {})) as {
        tree: readonly SummaryTreeNode[];
        rootPath: string;
      };
      setSummaryTree(result.tree);
    } catch (e) {
      console.error('Failed to load summary tree:', e);
      setSummaryTree([]);
    } finally {
      setSummaryTreeLoading(false);
    }
  }, []);

  // 左侧边栏展开时加载目录树
  useEffect(() => {
    if (leftExpanded) {
      void loadSummaryTree();
    }
  }, [leftExpanded, loadSummaryTree]);

  /** 打开摘要文档：在新标签页中打开 HTML 文件 */
  const handleOpenSummaryDoc = useCallback((absolutePath: string) => {
    void window.urchin.invoke('summary.open', { absolutePath }).catch((e) => {
      console.error('Failed to open summary doc:', e);
    });
  }, []);

  /**
   * 一键提取当前网页内容并保存到本地（AI 助手）。
   *
   * 流程：调用 summary.run IPC → 主进程在页面上下文执行提取脚本 →
   *      格式化为自包含 HTML → 保存到本地目录。
   * 纯本地操作，不依赖 LLM 模型，与 pi 模块完全隔离。
   */
  const handleSummarize = useCallback(async () => {
    if (!activeTabId || summaryRunning) return;
    setSummaryRunning(true);
    setSummaryToast('正在提取网页内容…');
    try {
      const result = (await window.urchin.invoke('summary.run', { tabId: activeTabId })) as {
        filePath: string;
        relativePath: string;
        documentTitle: string;
      };
      setSummaryToast(`已保存：${result.documentTitle}`);
      // 左侧边栏展开时刷新目录树，让新文档立即出现
      if (leftExpanded) {
        void loadSummaryTree();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSummaryToast(`提取失败：${message}`);
    } finally {
      setSummaryRunning(false);
    }
  }, [activeTabId, summaryRunning, leftExpanded, loadSummaryTree]);

  // 摘要 toast 自动消失（3 秒后清除）
  useEffect(() => {
    if (!summaryToast) return;
    const timer = setTimeout(() => setSummaryToast(null), 3000);
    return () => clearTimeout(timer);
  }, [summaryToast]);

  // 阶段5：Host API 实例（单例），供 AI 模块通过标准接口访问浏览器核心
  // createHostFromUrchin 仅做接口适配，无副作用，安全地在 render 期间构造一次
  const host = useMemo(() => createHostFromUrchin(), []);

  // 右侧边栏悬停展开延迟（ms，从设置读取，默认 300）
  const [sidebarHoverDelay, setSidebarHoverDelay] = useState<number>(300);
  /** 右侧边栏悬停自动展开开关（设置 ui.rightSidebarAutoExpand，默认 true） */
  const [rightSidebarAutoExpand, setRightSidebarAutoExpand] = useState<boolean>(true);

  // 右侧栏悬停展开延迟定时器（未触发前可取消）
  const rightHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTabIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // 加载右侧边栏悬停设置（延迟 + 自动展开开关），并监听设置页变更实时更新
  useEffect(() => {
    async function loadHoverSettings() {
      try {
        const [delayRes, autoRes] = await Promise.all([
          window.urchin.invoke('settings.get', { key: 'debug.sidebarHoverDelay' }),
          window.urchin.invoke('settings.get', { key: 'ui.rightSidebarAutoExpand' }),
        ]);
        const delay = (delayRes as { value: unknown }).value;
        if (typeof delay === 'number' && Number.isFinite(delay)) {
          setSidebarHoverDelay(delay);
        }
        const auto = (autoRes as { value: unknown }).value;
        // 兼容 boolean（旧 toggle 存储）与字符串（select 存储 'true'/'false'）
        if (typeof auto === 'boolean') {
          setRightSidebarAutoExpand(auto);
        } else if (auto === 'true') {
          setRightSidebarAutoExpand(true);
        } else if (auto === 'false') {
          setRightSidebarAutoExpand(false);
        }
      } catch {
        // 使用默认值
      }
    }
    void loadHoverSettings();

    // 监听设置页保存事件，实时更新悬停设置
    const onSettingsChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ keys: string[] }>).detail;
      if (
        detail?.keys?.includes('debug.sidebarHoverDelay') ||
        detail?.keys?.includes('ui.rightSidebarAutoExpand')
      ) {
        void loadHoverSettings();
      }
    };
    window.addEventListener('urchin:settings-changed', onSettingsChanged);
    return () => {
      window.removeEventListener('urchin:settings-changed', onSettingsChanged);
    };
  }, []);

  // 加载持久化的右侧边栏宽度（拖拽调节后记录，重启恢复）
  useEffect(() => {
    async function loadRightWidth() {
      try {
        const res = (await window.urchin.invoke('settings.get', {
          key: RIGHT_SIDEBAR_WIDTH_KEY,
        })) as { value: unknown };
        if (
          typeof res.value === 'number' &&
          Number.isFinite(res.value) &&
          res.value >= RIGHT_MIN &&
          res.value <= RIGHT_MAX
        ) {
          setRightExpandedWidth(res.value);
        }
      } catch {
        // 使用默认宽度
      }
    }
    void loadRightWidth();
  }, []);

  // 初始化：加载 tab 列表
  useEffect(() => {
    async function loadTabs() {
      try {
        const result = (await window.urchin.invoke('tab.list', { windowId: 1 })) as {
          tabs: readonly TabSnapshot[];
        };
        setTabs(result.tabs);
        const active = result.tabs.find((t) => t.active);
        setActiveTabId(active ? active.id : (result.tabs[0]?.id ?? null));
      } catch (e) {
        console.error('Failed to load tabs:', e);
      }
    }
    void loadTabs();
  }, []);

  // 订阅 tab 事件推送
  // 性能：did-navigate / did-start-loading 等事件在页面加载高峰期高频触发，
  // updated 事件做 16ms 去抖合并（对齐一帧），避免每事件全量 setTabs 重渲染导致的卡顿。
  useEffect(() => {
    let pending: TabEventPayload | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      const evt = pending;
      pending = null;
      if (!evt?.snapshot) return;
      const snapshot = evt.snapshot;
      setTabs((prev) => {
        switch (evt.type) {
          case 'created':
            if (prev.some((t) => t.id === snapshot.id)) return prev;
            // 前插：与右侧边栏倒推排序一致（新建标签置顶，LIFO）
            return [snapshot, ...prev];
          case 'updated':
            return prev.map((t) => (t.id === snapshot.id ? snapshot : t));
          case 'activated':
            setActiveTabId(snapshot.id);
            return prev.map((t) => ({ ...t, active: t.id === snapshot.id }));
          case 'removed':
            // 移除的正是激活标签：清空 activeTabId，避免悬空引用（后续导航报 "Tab not found"）。
            // 主进程移除激活 tab 后若窗口仍有剩余 tab，会补发 activated 事件重新设置；
            // 无剩余时仅靠此处清空。用事件快照的 active 标志判断，不依赖异步初始化的 ref。
            if (snapshot.active) setActiveTabId(null);
            return prev.filter((t) => t.id !== snapshot.id);
          case 'crashed':
            return prev.map((t) => (t.id === snapshot.id ? snapshot : t));
          default:
            return prev;
        }
      });
      if (evt.type === 'created' && snapshot.active) {
        setActiveTabId(snapshot.id);
      }
    };
    const unsubscribe = window.urchin.on('tab:event', (payload) => {
      const event = payload as TabEventPayload;
      if (!event?.snapshot) return;
      if (event.type !== 'updated') {
        // 结构性事件（创建/激活/移除/崩溃）立即处理，不做合并
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pending = event;
        flush();
        return;
      }
      // updated 事件合并：仅保留同一 tab 的最新快照
      if (pending && pending.snapshot.id !== event.snapshot.id) {
        flush();
      }
      pending = event;
      timer ??= setTimeout(flush, 16);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const handleNewTab = useCallback(async () => {
    try {
      // 新标签页打开内嵌主页（urchin://newtab，无法自由更换）
      await window.urchin.invoke('tab.create', {
        windowId: 1,
        url: 'urchin://newtab',
        active: true,
      });
    } catch (e) {
      console.error('Failed to create tab:', e);
    }
  }, []);

  // 打开设置标签页：如果已有设置标签页则激活它，不重复创建
  const handleOpenSettings = useCallback(async () => {
    // Toggle 行为：当前已激活设置页则关闭它；否则激活或创建
    // 注意：URL 规范化会加末尾斜杠（urchin://settings/），用 startsWith 兼容两种形式
    const existing = tabs.find((t) => t.url?.startsWith('urchin://settings'));
    if (existing) {
      if (existing.id === activeTabId) {
        // 当前设置页已激活：关闭它
        try {
          await window.urchin.invoke('tab.close', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to close settings tab:', e);
        }
      } else {
        // 设置页存在但未激活：激活它
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate settings tab:', e);
        }
      }
      return;
    }
    // 没有设置标签页，创建新的
    try {
      await window.urchin.invoke('tab.create', {
        windowId: 1,
        url: 'urchin://settings',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open settings tab:', e);
    }
  }, [tabs, activeTabId]);

  // 打开 AI 标签页：如果已有 AI 标签页则激活它，不重复创建
  // 阶段2 解耦：AI 模块作为独立标签页（urchin://ai），不再融合到地址栏
  const handleOpenAi = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://ai'));
    if (existing) {
      if (existing.id === activeTabId) {
        // 当前 AI 页已激活：关闭它（toggle 行为）
        try {
          await window.urchin.invoke('tab.close', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to close ai tab:', e);
        }
      } else {
        // AI 页存在但未激活：激活它
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate ai tab:', e);
        }
      }
      return;
    }
    // 没有 AI 标签页，创建新的
    try {
      await window.urchin.invoke('tab.create', {
        windowId: 1,
        url: 'urchin://ai',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open ai tab:', e);
    }
  }, [tabs, activeTabId]);

  const handleCloseTab = useCallback(async (tabId: number) => {
    try {
      await window.urchin.invoke('tab.close', { tabId });
    } catch (e) {
      console.error('Failed to close tab:', e);
    }
  }, []);

  const handleSelectTab = useCallback(async (tabId: number) => {
    try {
      await window.urchin.invoke('tab.setActive', { tabId });
    } catch (e) {
      console.error('Failed to set active tab:', e);
    }
  }, []);

  const handleNavigate = useCallback(
    async (url: string) => {
      // 主页占位设计（2026-08-15）：打开网站时优先消费主页占位标签——
      // 当前活跃标签是主页（urchin://newtab）→ 就地转为网站标签（不新建）；
      // 当前是网站标签（地址栏/收藏夹输入）→ 当前标签导航。
      // 无活跃标签（关闭最后一个标签后）→ 新建标签。
      if (activeTabId) {
        try {
          await window.urchin.invoke('tab.loadUrl', { tabId: activeTabId, url });
        } catch (e) {
          console.error('Failed to navigate:', e);
        }
        return;
      }
      // 无标签页：新建标签并导航，避免导航静默失效
      try {
        await window.urchin.invoke('tab.create', {
          windowId: 1,
          url,
          active: true,
        });
      } catch (e) {
        console.error('Failed to navigate (create tab):', e);
      }
    },
    [activeTabId],
  );

  const handleGoBack = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('tab.goBack', { tabId: activeTabId });
    } catch (e) {
      console.error('Failed to go back:', e);
    }
  }, [activeTabId]);

  const handleGoForward = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('tab.goForward', { tabId: activeTabId });
    } catch (e) {
      console.error('Failed to go forward:', e);
    }
  }, [activeTabId]);

  const handleReload = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('tab.reload', { tabId: activeTabId, ignoreCache: false });
    } catch (e) {
      console.error('Failed to reload:', e);
    }
  }, [activeTabId]);

  // 补全建议查询：历史 + 书签混合数据源（OM2 决策：150ms debounce 由 Omnibox 内部处理）
  // v0.1.0-dev.23 修复：此前为空实现 stub（直接 setSuggestions([])），
  // 现并联调用 history.search / bookmark.search，经 buildSuggestions 合并评分。
  // 查询竞态防护：仅采纳最后一次查询的结果，避免慢响应覆盖新输入。
  const suggestionQuerySeq = useRef(0);
  const handleSuggestionQuery = useCallback(async (query: string) => {
    const seq = ++suggestionQuerySeq.current;
    try {
      const [historyRes, bookmarkRes] = await Promise.all([
        window.urchin.invoke('history.search', { query, limit: 10 }),
        window.urchin.invoke('bookmark.search', { query, limit: 10 }),
      ]);
      if (seq !== suggestionQuerySeq.current) return; // 已有更新的查询，丢弃本次结果
      const history = (
        historyRes as { entries: { url: string; title: string; visitCount: number }[] }
      ).entries;
      const bookmarks = (bookmarkRes as { bookmarks: { url?: string; title: string }[] }).bookmarks;
      setSuggestions(
        buildSuggestions(
          query,
          history.map((h) => ({ url: h.url, title: h.title, visitCount: h.visitCount })),
          bookmarks
            .map((b) => ({ url: b.url ?? '', title: b.title }))
            .filter((b) => b.url.length > 0),
        ),
      );
    } catch (e) {
      if (seq !== suggestionQuerySeq.current) return;
      console.error('Failed to load suggestions:', e);
      setSuggestions([]);
    }
  }, []);

  // 通知主进程布局变化
  const notifyLayout = useCallback(async (left: number, right: number) => {
    try {
      await window.urchin.invoke('ui.layout.setState', {
        leftWidth: left,
        rightWidth: right,
        bottomHeight: BOTTOM_HEIGHT,
      });
    } catch (e) {
      console.error('Failed to update layout:', e);
    }
  }, []);

  const handleToggleLeft = useCallback(() => {
    const next = !leftExpanded;
    setLeftExpanded(next);
    void notifyLayout(
      next ? LEFT_EXPANDED : LEFT_COLLAPSED,
      rightExpanded ? rightExpandedWidth : RIGHT_COLLAPSED,
    );
  }, [leftExpanded, rightExpanded, rightExpandedWidth, notifyLayout]);

  const handleToggleRight = useCallback(() => {
    const next = !rightExpanded;
    setRightExpanded(next);
    // 手动切换时清除悬停/回弹状态
    setRightHovered(false);
    setRightRetracting(false);
    void notifyLayout(
      leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED,
      next ? rightExpandedWidth : RIGHT_COLLAPSED,
    );
  }, [leftExpanded, rightExpanded, rightExpandedWidth, notifyLayout]);

  // 双击右侧边栏空白处：展开/折叠切换（替代已移除的底部折叠/展开按钮）
  // 与悬停自动展开/自动折叠互斥（右侧栏自动展开开关控制后者）
  const handleRightDoubleClick = useCallback(() => {
    handleToggleRight();
  }, [handleToggleRight]);

  // 右侧栏悬停展开：仅当栏处于折叠状态（rightExpanded=false）且设置允许自动展开时触发
  // 使用设置中配置的延迟（debug.sidebarHoverDelay），0 = 立即展开
  const handleRightMouseEnter = useCallback(() => {
    if (rightExpanded || !rightSidebarAutoExpand) return;
    // 清除上一个未触发的定时器，避免重复展开
    if (rightHoverTimerRef.current) {
      clearTimeout(rightHoverTimerRef.current);
      rightHoverTimerRef.current = null;
    }
    const doExpand = (): void => {
      setRightHovered(true);
      setRightRetracting(false);
      // 用拖拽后的实际宽度（而非固定 RIGHT_EXPANDED），否则主进程 BrowserView
      // 布局宽度与栏显示宽度不一致 → 网页滚动条与分割线间出现空白
      void notifyLayout(leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED, rightExpandedWidth);
    };
    if (sidebarHoverDelay <= 0) {
      doExpand();
    } else {
      rightHoverTimerRef.current = setTimeout(() => {
        rightHoverTimerRef.current = null;
        doExpand();
      }, sidebarHoverDelay);
    }
  }, [
    rightExpanded,
    rightSidebarAutoExpand,
    leftExpanded,
    rightExpandedWidth,
    notifyLayout,
    sidebarHoverDelay,
  ]);

  // 右侧栏离开回弹：折叠状态下鼠标离开时收起，使用带过冲的弹性缓动
  // 若悬停定时器尚未触发（未展开），则取消定时器不展开
  const handleRightMouseLeave = useCallback(() => {
    // 取消未触发的悬停定时器
    if (rightHoverTimerRef.current) {
      clearTimeout(rightHoverTimerRef.current);
      rightHoverTimerRef.current = null;
    }
    if (rightExpanded || !rightHovered) return;
    setRightRetracting(true);
    setRightHovered(false);
    void notifyLayout(leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED, RIGHT_COLLAPSED);
    // 回弹动画结束后清除标记（300ms 对应回弹时长）
    window.setTimeout(() => setRightRetracting(false), 320);
  }, [rightExpanded, rightHovered, leftExpanded, notifyLayout]);

  // 右侧边栏宽度拖拽调节：鼠标在网页与右侧边栏的边界线上按住拖动，实时调宽。
  // 展开态下于栏左缘内侧渲染拖拽手柄（避免与 BrowserView 重叠导致无法 hover/点击）。
  // 拖拽中禁 width transition（保证跟手）；释放时持久化到 settings（记录位置，重启恢复）。
  const rightDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleRightResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!rightExpanded && !rightHovered) return;
      e.preventDefault();
      rightDragRef.current = { startX: e.clientX, startWidth: rightExpandedWidth };
      setResizingRight(true);
      // 捕获指针：移动/释放事件跟随手柄，即使指针滑出栏外
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [rightExpanded, rightHovered, rightExpandedWidth],
  );

  const handleRightResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = rightDragRef.current;
      if (!drag) return;
      // 向左拖（clientX 减小）→ 栏变宽；向右拖 → 栏变窄
      const next = Math.min(
        RIGHT_MAX,
        Math.max(RIGHT_MIN, drag.startWidth + (drag.startX - e.clientX)),
      );
      setRightExpandedWidth(next);
      void notifyLayout(leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED, next);
    },
    [leftExpanded, notifyLayout],
  );

  const handleRightResizeEnd = useCallback(() => {
    if (!rightDragRef.current) return;
    rightDragRef.current = null;
    setResizingRight(false);
    // 释放时持久化宽度（记录位置，重启恢复）
    void window.urchin
      .invoke('settings.set', { key: RIGHT_SIDEBAR_WIDTH_KEY, value: rightExpandedWidth })
      .catch((e) => {
        console.error('Failed to persist right sidebar width:', e);
      });
    // 通知其他组件（如收藏夹面板）宽度已变化
    window.dispatchEvent(
      new CustomEvent('urchin:settings-changed', { detail: { keys: [RIGHT_SIDEBAR_WIDTH_KEY] } }),
    );
  }, [rightExpandedWidth]);

  // 当前 URL 对应的书签 ID（若已收藏），用于 toggle 时删除。
  // 通过 bookmark.search 查询当前 URL 是否已被收藏，实现按钮亮/灭状态同步。
  const [currentBookmarkId, setCurrentBookmarkId] = useState<string | null>(null);

  // 刷新当前 URL 的收藏状态：activeTab.url 变化时或创建/删除书签后调用
  const refreshBookmarkSaved = useCallback(async (url: string | undefined) => {
    if (!url || !isBookmarkable(url)) {
      setBookmarkSaved(false);
      setCurrentBookmarkId(null);
      return;
    }
    try {
      const result = (await window.urchin.invoke('bookmark.search', {
        query: url,
        limit: 50,
      })) as { bookmarks: readonly { id: string; title: string; url?: string }[] };
      // search 对 title/url 做子串匹配，需精确匹配 url 字段
      const match = result.bookmarks.find((bm) => bm.url === url);
      setBookmarkSaved(!!match);
      setCurrentBookmarkId(match ? match.id : null);
    } catch (e) {
      console.error('Failed to check bookmark status:', e);
      setBookmarkSaved(false);
      setCurrentBookmarkId(null);
    }
  }, []);

  // toggle 收藏：已收藏则删除，未收藏则创建。
  // 修复：此前 handleSaveBookmark 只创建不删除，再次点击不会移除收藏。
  const handleSaveBookmark = useCallback(async () => {
    if (!activeTab?.url || !isBookmarkable(activeTab.url)) return;
    try {
      if (bookmarkSaved && currentBookmarkId) {
        // 已收藏 → 删除
        await window.urchin.invoke('bookmark.delete', { id: currentBookmarkId });
        setBookmarkSaved(false);
        setCurrentBookmarkId(null);
        setBookmarkToast('已从书签移除');
      } else {
        // 未收藏 → 创建
        await window.urchin.invoke('bookmark.create', {
          url: activeTab.url,
          title: activeTab.title || activeTab.url,
          type: 'bookmark',
        });
        setBookmarkSaved(true);
        setBookmarkToast('已添加到书签');
      }
      setTimeout(() => setBookmarkToast(null), 2000);
      // 刷新收藏状态（当前 URL 的亮/灭）
      void refreshBookmarkSaved(activeTab.url);
    } catch (e) {
      console.error('Failed to toggle bookmark:', e);
      setBookmarkToast('书签操作失败');
      setTimeout(() => setBookmarkToast(null), 2000);
    }
  }, [activeTab?.url, activeTab?.title, bookmarkSaved, currentBookmarkId, refreshBookmarkSaved]);

  // URL 变化时重新检查收藏状态（修复：此前仅 setBookmarkSaved(false) 未查询实际状态）
  useEffect(() => {
    void refreshBookmarkSaved(activeTab?.url);
  }, [activeTab?.url, refreshBookmarkSaved]);

  const leftWidth = leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED;
  // 右侧栏有效展开：固定展开 OR 折叠态下的悬停预览
  const effectiveRightExpanded = rightExpanded || rightHovered;
  const rightWidth = effectiveRightExpanded ? rightExpandedWidth : RIGHT_COLLAPSED;

  // 中区内容判断
  // 注意：urchin://settings / urchin://ai 会被 Electron URL 规范化为带末尾斜杠，
  // 所以用 startsWith 判断而非严格相等，避免匹配失败导致组件不渲染。
  const isSettingsTab = !!activeTab?.url?.startsWith('urchin://settings');
  const isAiTab = !!activeTab?.url?.startsWith('urchin://ai');
  const isNewTab = !!activeTab?.url?.startsWith('urchin://newtab');
  // 渲染优先级：设置页 > AI 页 > 主页 > 普通网页（BrowserView）
  // settings / ai / newtab 都由 React 组件渲染，BrowserView 让出空间（ZERO_BOUNDS）

  // 内部页面（settings / ai / newtab）下，导航按钮无意义，禁用
  const isInternalPage = isSettingsTab || isAiTab || isNewTab;
  // AI 标签页关联的"上一个活跃网页 tab ID"：用于 AI 摘要功能
  // 阶段2 简化：传入当前 activeTabId（即 AI 标签页 ID），AI 组件会自动处理
  // 阶段3 重构时将通过 host.tabs.getActive() 获取真正的活跃网页 tab
  const aiActiveTabId = activeTabId;

  // 按住侧边栏空白处拖动窗口（左/右两侧栏共用）
  const windowDrag = useWindowDrag();

  // 主页跳转（主页按钮）：新建标签打开主页，绝不把当前网站标签原地变成主页
  // （原地跳转会毁掉被顶下去的网站标签——此前"变新标签页"bug 的根因）。
  // 当前已是最新主页（urchin://newtab）时不重复创建，避免堆叠主页标签。
  const handleGoHome = useCallback(() => {
    if (activeTab?.url === 'urchin://newtab') return;
    void window.urchin
      .invoke('tab.create', { windowId: 1, url: 'urchin://newtab', active: true })
      .catch((e) => console.error('Failed to open homepage:', e));
  }, [activeTab?.url]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface">
      {/* === 左侧栏 ===
       *  背景用 bg-surface（与窗口标题栏同色）：标题栏是 OS 原生色（浅色=白/深色=深），
       *  侧栏与标题栏同色后两者间的色差分割线消失，视觉上一体。
       *  border-r 保留：这是"左侧边栏与网页区"之间的分割线（网页区左上角圆角的夹角边之一）。 */}
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150"
        style={{ width: leftWidth }}
        onPointerDown={windowDrag.startDrag}
        onPointerMove={windowDrag.moveDrag}
        onPointerUp={windowDrag.endDrag}
        onPointerCancel={windowDrag.endDrag}
      >
        {/* 顶部：折叠/展开按钮 */}
        <button
          className="flex h-11 w-full items-center justify-center text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={handleToggleLeft}
          aria-label={leftExpanded ? '折叠左侧栏' : '展开左侧栏'}
        >
          {leftExpanded ? (
            <PanelLeftClose className="h-4 w-4" />
          ) : (
            <PanelLeftOpen className="h-4 w-4" />
          )}
        </button>

        {/* 中部：摘要文档目录树（数据空间入口）
         *  左侧边栏折叠时不渲染（宽度不足）；展开时加载并显示本地摘要文档
         *  点击文件节点在新标签页打开 HTML 文档 */}
        <div className="flex-1 overflow-hidden">
          {leftExpanded && (
            <SummaryTreeView
              nodes={summaryTree}
              loading={summaryTreeLoading}
              onOpenDoc={handleOpenSummaryDoc}
            />
          )}
        </div>

        {/* 底部：AI 入口 + 设置 + 主题切换 */}
        <div className="flex flex-col items-center gap-1 border-t border-border p-2">
          <button
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
            onClick={() => void handleOpenAi()}
            aria-label="AI 助手"
            title="AI 助手"
          >
            <Sparkles className="h-4 w-4" />
          </button>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
            onClick={toggleTheme}
            aria-label="切换主题"
            title="切换主题"
          >
            {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
          <button
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
            onClick={() => void handleOpenSettings()}
            aria-label="设置"
            title="设置"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* === 中间列：ContentArea + 下侧地址栏 === */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* ContentArea */}
        <div className="flex-1 overflow-hidden bg-white">
          {
            isSettingsTab ? (
              /* 设置页：React 组件渲染 */
              <SettingsPage />
            ) : isAiTab ? (
              /* AI 页：React 组件渲染（独立标签页应用，通过 Host API 访问浏览器核心） */
              <AiChatView
                host={host}
                activeTabId={aiActiveTabId}
                onOpenPiSettings={() => setShowPiSettings(true)}
              />
            ) : isNewTab || tabs.length === 0 ? (
              /* 主页：React 组件渲染（内嵌，无法自由更换）。
               * 关闭最后一个标签后 activeTab 为空，此时同样回落到主页 */
              <NewTabPage onNavigate={(url) => void handleNavigate(url)} />
            ) : null /* 普通网页：由 Electron BrowserView 渲染，React 仅留空 */
          }
        </div>

        {/* 下侧边栏：地址栏 + 导航按钮（被左右侧栏夹住）
         *  AI 标签页隐藏地址栏：AI 模块作为独立全屏对话应用，不需要 URL 导航 */}
        {!isAiTab && (
          <div
            className="flex shrink-0 items-center gap-1.5 border-t border-border bg-surface px-2"
            style={{ height: BOTTOM_HEIGHT }}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onClick={() => void handleGoBack()}
              disabled={!activeTab?.canGoBack || isInternalPage}
              aria-label="后退"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onClick={() => void handleGoForward()}
              disabled={!activeTab?.canGoForward || isInternalPage}
              aria-label="前进"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onClick={() => void handleReload()}
              disabled={!activeTabId || isInternalPage}
              aria-label="刷新"
            >
              <RotateCw className={cn('h-4 w-4', activeTab?.loading && 'animate-spin')} />
            </Button>
            {/* 主页按钮：位于刷新按钮后面，跳转内嵌主页（urchin://newtab） */}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onClick={() => void handleGoHome()}
              aria-label="主页"
            >
              <Home className="h-4 w-4" />
            </Button>

            <Omnibox
              currentUrl={activeTab?.url ?? ''}
              loading={activeTab?.loading ?? false}
              securityState={getSecurityState(activeTab?.url ?? '')}
              suggestions={suggestions}
              onNavigate={(url) => void handleNavigate(url)}
              onSuggestionQuery={(q) => void handleSuggestionQuery(q)}
              bookmarkSaved={bookmarkSaved}
              bookmarkable={!isInternalPage && !!activeTab?.url && isBookmarkable(activeTab.url)}
              onBookmarkToggle={() => void handleSaveBookmark()}
              onSummarize={() => void handleSummarize()}
              summarizeDisabled={
                summaryRunning || !activeTab?.url || !/^https?:\/\//i.test(activeTab.url)
              }
            />

            {bookmarkToast && (
              <div className="absolute bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-md bg-surface-secondary px-3 py-1.5 text-xs text-text shadow-md border border-border">
                {bookmarkToast}
              </div>
            )}

            {summaryToast && (
              <div className="absolute bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-md bg-surface-secondary px-3 py-1.5 text-xs text-text shadow-md border border-border flex items-center gap-1.5">
                {summaryRunning && <RotateCw className="h-3 w-3 animate-spin" />}
                <span>{summaryToast}</span>
              </div>
            )}
          </div>
        )}
      </main>

      {/* === 右侧栏 === */}
      {/* 折叠态下悬停展开，鼠标离开带过冲弹性回弹；展开/收起使用不同缓动以体现"力度"。
       *  拖拽调节中（resizingRight）禁用宽度 transition，保证跟手。 */}
      <aside
        className={cn(
          'relative flex shrink-0 flex-col border-l border-border bg-surface-secondary',
          resizingRight
            ? ''
            : rightRetracting
              ? 'transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]'
              : 'transition-[width] duration-150 ease-out',
        )}
        style={{ width: rightWidth }}
        onMouseEnter={handleRightMouseEnter}
        onMouseLeave={handleRightMouseLeave}
        onDoubleClick={handleRightDoubleClick}
        onPointerDown={windowDrag.startDrag}
        onPointerMove={windowDrag.moveDrag}
        onPointerUp={windowDrag.endDrag}
        onPointerCancel={windowDrag.endDrag}
        aria-label="右侧边栏"
      >
        {/* 宽度调节手柄：展开态下渲染于栏左缘内侧（避免与 BrowserView 重叠），
         *  鼠标移入手柄区域变横向调节光标，按住左右拖动调宽 */}
        {effectiveRightExpanded && (
          <div
            className="absolute top-0 bottom-11 left-0 z-10 w-1.5 cursor-col-resize"
            onPointerDown={handleRightResizeStart}
            onPointerMove={handleRightResizeMove}
            onPointerUp={handleRightResizeEnd}
            onPointerCancel={handleRightResizeEnd}
            aria-label="调节右侧栏宽度"
            role="separator"
          />
        )}
        {effectiveRightExpanded ? (
          <>
            {/* 视图标题：标签页 */}
            <div className="flex shrink-0 border-b border-border">
              <div className="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-text">
                <ListIcon className="h-3.5 w-3.5" />
                标签页
              </div>
            </div>

            {/* 标签列表：凸起悬浮感（卡片浮于底色之上，带阴影 + 微光边框 + 顶部高光） */}
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex-1 overflow-y-auto p-2">
                {tabs.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-text-secondary">暂无标签页</p>
                )}
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={cn(
                      // 凸起悬浮感：圆角卡片 + 投影 + 细边框 + 顶部高光线；
                      // 激活态更亮（主色投影 + 高对比文字）
                      'group relative mb-1.5 flex cursor-default items-center gap-2 rounded-lg border px-2.5 py-2 text-sm shadow-sm',
                      'border-border/60 bg-surface',
                      'before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:h-px before:rounded-full before:bg-white/70',
                      tab.id === activeTabId
                        ? 'border-primary/40 bg-surface text-text shadow-[0_2px_8px_-2px_rgba(37,99,235,0.35)]'
                        : 'text-text-secondary shadow-[0_1px_4px_-1px_rgba(0,0,0,0.25)] hover:bg-surface-secondary hover:text-text',
                    )}
                    onClick={() => void handleSelectTab(tab.id)}
                  >
                    <TabFavicon tab={tab} />
                    <span className="flex-1 truncate">{tab.title || tab.url || '新标签页'}</span>
                    <button
                      className="shrink-0 rounded p-0.5 opacity-0 hover:bg-surface-secondary group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleCloseTab(tab.id);
                      }}
                      aria-label="关闭标签"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              {/* 新建标签 */}
              <div className="shrink-0 border-t border-border p-2">
                <button
                  className="flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-sm text-text-secondary hover:bg-surface hover:text-text"
                  onClick={() => void handleNewTab()}
                  aria-label="新建标签"
                >
                  <Plus className="h-4 w-4" />
                  新建标签
                </button>
              </div>
            </div>
          </>
        ) : (
          // 折叠状态：竖向显示所有标签页的图标（仅图标不展示名称），点击图标切换标签；
          // 无标签时留空（底部"展开"按钮仍可用）
          <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  // 折叠态图标：同样凸起悬浮感，激活态带主色描边
                  'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border bg-surface shadow-sm',
                  'border-border/60 before:pointer-events-none before:absolute before:inset-x-1 before:top-0 before:h-px before:rounded-full before:bg-white/70',
                  tab.id === activeTabId
                    ? 'border-primary/50 text-text shadow-[0_2px_6px_-1px_rgba(37,99,235,0.4)]'
                    : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
                )}
                onClick={() => void handleSelectTab(tab.id)}
                aria-label={`切换到标签 ${tab.title || tab.url || '新标签页'}`}
                title={tab.title || tab.url || '新标签页'}
              >
                <TabFavicon tab={tab} className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        )}

        {/* 底部折叠/展开按钮已移除（2026-08-14）：改为双击右侧边栏空白处展开/折叠，
         *  由 aside 的 onDoubleClick 处理；与悬停自动展开互斥（设置开关控制）。 */}
      </aside>

      {/* pi 设置对话框：由 AiChatView 中区 header 的齿轮按钮触发 */}
      <PiSettingsDialog open={showPiSettings} onClose={() => setShowPiSettings(false)} />
    </div>
  );
}
