/**
 * Urchin Browser · 根组件
 *
 * 布局：左侧栏 | 中间列(ContentArea + 下侧地址栏) | 右侧栏
 * - 左侧栏：顶部折叠/展开按钮，底部 DeepSeek Harness/pi/文档/邮箱/主页/主题/设置入口
 * - 中间列：上方 ContentArea（BrowserView / SettingsPage / AiChatView），下方下侧边栏（地址栏 + 导航按钮）
 * - 右侧栏：标签页列表，底部折叠/展开按钮
 * - 左右侧栏夹住下侧地址栏
 *
 * 阶段2 解耦决策：
 * - pi 模块作为独立标签页（pi-web-host 托管的 http 页），不再融合到地址栏
 * - 地址栏回归纯 URL 输入职责
 * - 左侧栏底部 pi 入口按钮，点击确保服务运行并直接打开 pi 聊天页
 * - 移除右侧栏的 AI 会话选项卡（会话列表将在阶段3 重构为 pi 标签页内的左区）
 * - 移除 contentViewHidden / omniboxMode / aiStreaming 状态
 * - ADR-014：pi 服务应用级常驻（关标签不停服务）；urchin://ai 释放给未来原生 AI 助手
 *
 * 事件订阅：通过 window.urchin.on('tab:event', ...) 接收主进程推送的 tab 状态变更
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppTitleBar } from './components/app-titlebar';
import { parseTransitDrag } from './transit/drag-utils';
import { resolveDroppedFilePath } from './transit/file-path';
import { DevToolsPanel } from './devtools/DevToolsPanel';
import { useDevtoolsColumn } from './devtools/use-devtools-column';
import {
  getEditGuardSession,
  closeNeedsGuard,
  switchNeedsGuard,
  type EditorGuardAsk,
} from './lib/edit-guard';
import { ContentArea } from './content/ContentArea';
import { useTheme } from './theme/theme-provider';
import type { StatusBarState, StatusBarAction } from '@urchin/ipc-contract';
import type { Suggestion } from './omnibox/types';
import { buildSuggestions } from './omnibox/build-suggestions';
import { cn } from './lib/utils';
import { getCurrentWindowId } from './lib/current-window';
import type { WorkspaceSwitcherMode } from './workspaces/WorkspaceSwitcher';
import { useWorkspaces } from './workspaces/use-workspaces';
import { TabCardContextMenu } from './workspaces/TabCardContextMenu';
import { WorkspaceManagerDialog } from './workspaces/WorkspaceManagerDialog';
import type { Workspace } from './workspaces/types';
import { DEFAULT_WORKSPACE_ID } from './workspaces/types';
import type { TabEventPayload, TabSnapshot } from './tabs/types';
import { LeftSidebar } from './sidebar/LeftSidebar';
import { RightSidebar } from './sidebar/RightSidebar';
import { useWindowDrag } from './lib/use-window-drag';
import {
  BOTTOM_HEIGHT,
  LEFT_COLLAPSED,
  LEFT_EXPANDED,
  RIGHT_COLLAPSED,
  RIGHT_EXPANDED,
  RIGHT_MAX,
  RIGHT_MIN,
  RIGHT_SIDEBAR_WIDTH_KEY,
} from './lib/layout-constants';

declare global {
  interface Window {
    readonly urchin: {
      invoke: <C extends string>(channel: C, req: unknown) => Promise<unknown>;
      on: (channel: string, callback: (payload: unknown) => void) => () => void;
      /** 取 OS 拖入文件的真实磁盘路径（Electron 32+ 已移除 File.path） */
      pathForFile: (file: File) => string;
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

/** URL → 安全状态（地址栏锁图标）：https 视为安全，其余不安全 */
function getSecurityState(url: string): 'secure' | 'insecure' | 'mixed' {
  if (url.startsWith('https://')) return 'secure';
  return 'insecure';
}

function isBookmarkable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function App() {
  const { theme } = useTheme();
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
  const [leftHovered, setLeftHovered] = useState(false);
  const [leftRetracting, setLeftRetracting] = useState(false);
  /** 右侧边栏展开时的宽度（可拖拽调节，默认 RIGHT_EXPANDED；持久化于 settings） */
  const [rightExpandedWidth, setRightExpandedWidth] = useState<number>(RIGHT_EXPANDED);
  /** 右侧边栏拖拽调节中（禁用宽度 transition，保证跟手） */
  const [resizingRight, setResizingRight] = useState(false);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkToast, setBookmarkToast] = useState<string | null>(null);
  // 通用操作 toast（截图/翻译/DeepSeek Harness 等反馈，3 秒自动消失）
  const [actionToast, setActionToast] = useState<string | null>(null);
  // DeepSeek Harness 启动中标记：用于显示启动过程中的持久提示，
  // 启动完成（成功/失败）后再消失。
  const [dshStarting, setDshStarting] = useState(false);
  // pi 托管服务状态（ADR-014：常驻服务，侧栏 π 按钮状态灯依据）
  // stopped=熄灭 / starting=黄 / running=绿 / error=红
  const [piServiceState, setPiServiceState] = useState<
    'stopped' | 'starting' | 'running' | 'error'
  >('stopped');
  // 编辑器轻提示（保存失败等）：稳定引用（useEditSession 依赖稳定性需要）。
  // showEditorToast / editorGuardAsk / handleCloseTab / handleSelectTab 声明于
  // 上方「编辑守卫」区（tab 事件订阅 effect 之前，供事件路径守卫引用）。

  // ── TP7 工作区状态：收拢于 workspaces/use-workspaces.ts hook（真源仍归 App 域，
  //    见 hook 头注释；下方 hook 调用点接线） ──
  /** 内容区 DOM 引用：整窗快照叠加网页截图时用于取 BrowserView 对应矩形
   *  （ref 传给 ContentArea 挂载、传给 useWorkspaces 采集快照，真源仍在 App）。 */
  const contentAreaRef = useRef<HTMLDivElement>(null);
  // M15 DevTools 检视列开合/宽度（真源仍归 App：width 驱动主进程 BrowserView
  // bounds；hook 收拢状态与 F12 订阅，见 devtools/use-devtools-column.ts）
  const { devtoolsOpen, devtoolsWidth, setDevtoolsWidth } = useDevtoolsColumn();

  /** 每工作区最近一次激活的标签（切回该工作区时恢复）。 */
  const lastActiveByWorkspaceRef = useRef<Record<string, number>>({});
  /** 标签持久化（TP4）：退出时保存的标签，按工作区分组。非默认工作区的标签在此懒恢复。 */
  const savedTabsByWorkspaceRef = useRef<
    Record<string, { url: string; title: string; active: boolean }[]>
  >({});
  /** 折叠态工作区切换器悬停标记：悬停期间抑制侧栏自动展开（滚轮切换不被打断）。 */
  const workspaceAvatarHoverRef = useRef(false);
  /** 标签卡片右键菜单状态。 */
  const [tabCardMenu, setTabCardMenu] = useState<{
    x: number;
    y: number;
    tab: {
      id: number;
      url: string;
      title: string;
      workspaceId: string;
    };
  } | null>(null);
  /** 工作区管理对话框（右键工作区选项卡触发）。 */
  const [workspaceManagerTarget, setWorkspaceManagerTarget] = useState<Workspace | null>(null);
  /** 折叠态工作区切换模式（设置 ui.workspaceSwitcherMode；'wheel'=滚轮循环；'cards'=点击打开工作区总览页）。 */
  const [workspaceSwitcherMode, setWorkspaceSwitcherMode] =
    useState<WorkspaceSwitcherMode>('wheel');

  /**
   * 打开本地路径（文件夹/文件统一入口）：
   * - 目录（isDir）→ urchin://file-viewer/?dir= 目录浏览页（选择文件夹就打开文件夹）
   * - GenOffice 接管类型（阶段 4：md/pdf/html/docx）→ urchin://genoffice 伪地址，
   *   主进程创建对应编辑器视图；产物缺失时由主进程回落（html → file:// 直开，
   *   其余 → 文件查看器）
   * - 其余全部（音视频/图片/JSON/文本/其他）→ urchin://file-viewer/?path=
   *   查看器（媒体/图片内嵌渲染 + 同类型连续切换）
   * 供左侧栏按钮 / Ctrl+O / 文件拖放 / 文件关联启动共用。
   */
  const handleOpenFilePath = useCallback((path: string) => {
    void (async () => {
      try {
        const statRes = (await window.urchin.invoke('file.stat', { path })) as {
          kind: string;
          isDir?: boolean;
        };
        // kind → GenOffice 编辑器 app（与主进程 genoffice/paths.ts 的
        // GENOFFICE_KINDS 对应；docx 类文档统一由 docs 编辑器承载）
        const genofficeAppByKind: Readonly<Record<string, string>> = {
          markdown: 'markdown',
          pdf: 'pdf',
          html: 'html',
          docx: 'docs',
          pptx: 'slides',
          xlsx: 'sheets',
        };
        // MHTML：文件选择器/拖放入口统一交给主进程只读查看器（禁用 JS、无 preload），
        // 不再直接 tab.create(file://...)，避免普通 BrowserView 启用 MHTML 内脚本。
        if (statRes.kind === 'mhtml') {
          await window.urchin.invoke('clipper.openMhtmlFile', { path });
          return;
        }
        const genofficeApp = genofficeAppByKind[statRes.kind];
        const url = statRes.isDir
          ? `urchin://file-viewer/?dir=${encodeURIComponent(path)}`
          : genofficeApp
            ? `urchin://genoffice/?kind=${encodeURIComponent(genofficeApp)}&path=${encodeURIComponent(path)}`
            : `urchin://file-viewer/?path=${encodeURIComponent(path)}`;
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url,
          active: true,
        });
      } catch (e) {
        console.error('Failed to open local file:', e);
      }
    })();
  }, []);

  /** 打开文件选择器（左侧栏「打开文件」按钮 / Ctrl+O）：
   *  openFile 对话框 → handleOpenFilePath 统一分流（文件→查看器，
   *  自动捕获所在目录，同目录文件可自由切换）。 */
  const handleOpenFilePicker = useCallback(async () => {
    try {
      const res = (await window.urchin.invoke('file.open', {})) as { path: string | null };
      if (res.path) handleOpenFilePath(res.path);
    } catch (e) {
      console.error('Failed to open file picker:', e);
    }
  }, [handleOpenFilePath]);

  // Ctrl+O 快捷键：打开文件（主进程已 Menu.setApplicationMenu(null) 移除全局菜单，
  // 快捷键需渲染层监听）。仅 Ctrl+O（不含 Shift/Ctrl+P 等组合），防误触。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpenFilePicker();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleOpenFilePicker]);

  // 通用 toast 自动消失（3 秒后清除）
  useEffect(() => {
    if (!actionToast) return;
    const timer = setTimeout(() => setActionToast(null), 3000);
    return () => clearTimeout(timer);
  }, [actionToast]);

  // 截图当前网页（地址栏截图按钮）：主进程弹出整屏框选覆盖窗口，用户拖拽框选
  // 确认后裁剪保存到 <数据目录>/screenshots/ 并打开所在文件夹。
  const handleScreenshot = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('screenshot.capture', {});
      // 覆盖窗口已弹出（截图/取消结果由覆盖窗口自身处理，无需 toast）
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionToast(`截图失败：${message}`);
    }
  }, [activeTabId]);

  // 剪藏当前网页（地址栏剪藏按钮）：主进程弹出独立剪藏面板，
  // 面板内选择 Markdown / MHTML / PDF / 截图并落盘到 documents/clipper。
  const handleClip = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('clipper.open', { tabId: activeTabId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionToast(`剪藏失败：${message}`);
    }
  }, [activeTabId]);

  // 右侧边栏悬停展开延迟（ms，从设置读取，默认 300）
  const [sidebarHoverDelay, setSidebarHoverDelay] = useState<number>(300);
  /** 右侧边栏悬停自动展开开关（设置 ui.rightSidebarAutoExpand，默认 true） */
  const [rightSidebarAutoExpand, setRightSidebarAutoExpand] = useState<boolean>(true);
  /** 左侧边栏悬停自动展开开关（设置 ui.leftSidebarAutoExpand，默认 true） */
  const [leftSidebarAutoExpand, setLeftSidebarAutoExpand] = useState<boolean>(true);

  /** 当前搜索引擎（设置 searchEngine，供地址栏搜索词生成搜索 URL；默认 google） */
  const [searchEngine, setSearchEngine] = useState<string>('google');

  // 右侧栏悬停展开延迟定时器（未触发前可取消）
  const rightHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTabIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // 加载右侧边栏悬停设置（延迟 + 自动展开开关）+ 搜索引擎设置 + 工作区切换模式，并监听设置页变更实时更新
  useEffect(() => {
    async function loadHoverSettings() {
      try {
        const [delayRes, autoRes, leftAutoRes, engineRes, switcherModeRes] = await Promise.all([
          window.urchin.invoke('settings.get', { key: 'debug.sidebarHoverDelay' }),
          window.urchin.invoke('settings.get', { key: 'ui.rightSidebarAutoExpand' }),
          window.urchin.invoke('settings.get', { key: 'ui.leftSidebarAutoExpand' }),
          window.urchin.invoke('settings.get', { key: 'searchEngine' }),
          window.urchin.invoke('settings.get', { key: 'ui.workspaceSwitcherMode' }),
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
        const leftAuto = (leftAutoRes as { value: unknown }).value;
        if (typeof leftAuto === 'boolean') {
          setLeftSidebarAutoExpand(leftAuto);
        } else if (leftAuto === 'true') {
          setLeftSidebarAutoExpand(true);
        } else if (leftAuto === 'false') {
          setLeftSidebarAutoExpand(false);
        }
        const engine = (engineRes as { value: unknown }).value;
        if (typeof engine === 'string' && engine) {
          setSearchEngine(engine);
        }
        const switcherMode = (switcherModeRes as { value: unknown }).value;
        // 非法值回退 wheel（默认模式），保持向后兼容
        if (switcherMode === 'cards') {
          setWorkspaceSwitcherMode('cards');
        } else {
          setWorkspaceSwitcherMode('wheel');
        }
      } catch {
        // 使用默认值
      }
    }
    void loadHoverSettings();

    // 监听设置页保存事件，实时更新悬停设置 / 搜索引擎 / 工作区切换模式
    const onSettingsChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ keys: string[] }>).detail;
      if (
        detail?.keys?.includes('debug.sidebarHoverDelay') ||
        detail?.keys?.includes('ui.rightSidebarAutoExpand') ||
        detail?.keys?.includes('ui.leftSidebarAutoExpand') ||
        detail?.keys?.includes('searchEngine') ||
        detail?.keys?.includes('ui.workspaceSwitcherMode')
      ) {
        void loadHoverSettings();
      }
    };
    window.addEventListener('urchin:settings-changed', onSettingsChanged);
    return () => {
      window.removeEventListener('urchin:settings-changed', onSettingsChanged);
    };
  }, []);

  // ADR-014：轮询 pi 托管服务状态（2s），驱动侧栏 π 按钮状态灯。
  // 服务状态变化不频繁，但需捕获崩溃/外部退出；IPC 本地调用开销可忽略。
  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const s = (await window.urchin.invoke('piWebHost.status', {})) as {
          state?: string;
        };
        if (alive) {
          setPiServiceState(
            s.state === 'running'
              ? 'running'
              : s.state === 'starting'
                ? 'starting'
                : s.state === 'error'
                  ? 'error'
                  : 'stopped',
          );
        }
      } catch {
        if (alive) setPiServiceState('error');
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
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

  // 初始化：加载 tab 列表（多窗口：按当前窗口 id 查询，新窗口加载自己的标签）
  useEffect(() => {
    async function loadTabs() {
      try {
        const windowId = await getCurrentWindowId();
        const result = (await window.urchin.invoke('tab.list', { windowId })) as {
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

  // TP7：加载工作区列表 / 变更广播 / 跟随活动标签 / 失效回退等 effect 已随工作区
  // 状态收拢进 use-workspaces.ts（见下方 hook 调用点）。

  // TP4：启动时读取保存的标签快照（非默认工作区部分），用于切换到该工作区时懒恢复。
  // 默认工作区的标签由主进程在启动时直接恢复，不在此处理。
  useEffect(() => {
    void (async () => {
      try {
        const res = (await window.urchin.invoke('settings.get', { key: 'session.lastTabs' })) as {
          value: unknown;
        };
        const saved = Array.isArray(res?.value)
          ? (res.value as { url: string; title: string; workspaceId: string; active: boolean }[])
          : [];
        const byWs: Record<string, { url: string; title: string; active: boolean }[]> = {};
        for (const tab of saved) {
          const wsId = tab.workspaceId ?? DEFAULT_WORKSPACE_ID;
          if (wsId === DEFAULT_WORKSPACE_ID) continue;
          (byWs[wsId] ??= []).push({ url: tab.url, title: tab.title, active: tab.active });
        }
        savedTabsByWorkspaceRef.current = byWs;
      } catch (e) {
        console.error('Failed to load saved tabs for lazy restore:', e);
      }
    })();
  }, []);

  // ── 编辑守卫：标签关闭/切换拦截 + 确认弹窗状态 ──
  // 声明在 tab 事件订阅 effect 之前：事件路径（新建标签等绕过 handleSelectTab
  // 的激活）的守卫同样要弹此对话框并落位。

  const doCloseTab = useCallback(async (tabId: number) => {
    try {
      await window.urchin.invoke('tab.close', { tabId });
    } catch (e) {
      console.error('Failed to close tab:', e);
    }
  }, []);

  const doSelectTab = useCallback(async (tabId: number) => {
    try {
      await window.urchin.invoke('tab.setActive', { tabId });
    } catch (e) {
      console.error('Failed to set active tab:', e);
    }
  }, []);

  /** 关闭标签：目标标签处于脏编辑会话时先弹三键确认（保存并关闭/不保存/取消）。 */
  const handleCloseTab = useCallback(
    (tabId: number) => {
      if (closeNeedsGuard(tabId)) {
        setEditorGuardAsk({ kind: 'close', tabId, run: () => void doCloseTab(tabId) });
        return;
      }
      void doCloseTab(tabId);
    },
    [doCloseTab],
  );

  /** 切换标签：将从脏编辑会话所在标签离开时先弹三键确认。 */
  const handleSelectTab = useCallback(
    (tabId: number) => {
      if (switchNeedsGuard(tabId)) {
        setEditorGuardAsk({ kind: 'switch', tabId, run: () => void doSelectTab(tabId) });
        return;
      }
      void doSelectTab(tabId);
    },
    [doSelectTab],
  );

  const [editorGuardAsk, setEditorGuardAsk] = useState<EditorGuardAsk | null>(null);

  // 编辑器轻提示（保存失败等）：稳定引用（useEditSession 依赖稳定性需要）
  const showEditorToast = useCallback((msg: string): void => {
    if (msg) setActionToast(msg);
  }, []);

  // 窗口整体关闭兜底：存在脏编辑会话时阻止静默关闭（Electron 弹原生确认）。
  // 标签级守卫只覆盖渲染层的关闭/切换入口，覆盖不到窗口 X 按钮/退出。
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      const s = getEditGuardSession();
      if (s?.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
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
      // 编辑守卫（事件路径）：新建标签/程序化激活绕过 handleSelectTab，
      // 若将激活事件会把用户从脏编辑标签带离——立即弹回脏标签并弹三键确认，
      // 用户选择后再落位到目标标签。弹回引发的再次 activated 事件
      // （目标即会话标签）不会命中 switchNeedsGuard，无循环。
      if (
        (evt.type === 'activated' || (evt.type === 'created' && snapshot.active)) &&
        switchNeedsGuard(snapshot.id)
      ) {
        const session = getEditGuardSession();
        if (session) {
          void window.urchin.invoke('tab.setActive', { tabId: session.tabId });
          setEditorGuardAsk({
            kind: 'switch',
            tabId: snapshot.id,
            run: () => void doSelectTab(snapshot.id),
          });
          return;
        }
      }
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
      // TP7：维护每工作区「最近激活标签」（切换工作区时恢复现场）。
      // 排除总览页：它是临时页，激活后不应顶掉该工作区真正的现场标签。
      if (snapshot.active && !snapshot.url.startsWith('urchin://workspaces')) {
        lastActiveByWorkspaceRef.current[snapshot.workspaceId ?? DEFAULT_WORKSPACE_ID] =
          snapshot.id;
      }
      if (evt.type === 'removed') {
        for (const key of Object.keys(lastActiveByWorkspaceRef.current)) {
          if (lastActiveByWorkspaceRef.current[key] === snapshot.id) {
            delete lastActiveByWorkspaceRef.current[key];
          }
        }
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
    // doSelectTab 为稳定引用（[] 依赖），守卫落位闭包依赖它
  }, [doSelectTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ===== 网页翻译（M24 dev.81） =====

  /** 翻译激活态镜像（活跃 tab；地址栏按钮高亮/恢复原文判定，主进程为权威源；
   *  悬浮状态栏快照消费，真源留在 App。划词结果卡在 ContentArea。） */
  const [translateActive, setTranslateActive] = useState(false);

  /**
   * 网页翻译开关（地址栏按钮）：未激活 → translate.start（引擎/目标语言取设置）；
   * 激活 → translate.stop 恢复原文。进度经 translate:progress 事件推送（见下方订阅）。
   */
  const handleTranslate = useCallback(async () => {
    if (!activeTabId) return;
    try {
      if (translateActive) {
        await window.urchin.invoke('translate.stop', { tabId: activeTabId });
        setTranslateActive(false);
        setActionToast('已恢复原文');
      } else {
        const res = (await window.urchin.invoke('translate.start', { tabId: activeTabId })) as {
          status: 'started' | 'skipped';
          message?: string;
          segmentCount?: number;
        };
        if (res.status === 'skipped') {
          setActionToast('页面语言与目标语言一致，无需翻译');
        } else {
          setActionToast(`正在翻译（共 ${res.segmentCount ?? 0} 段）…`);
        }
      }
    } catch (e) {
      setActionToast(`翻译失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [activeTabId, translateActive]);

  // 活跃 tab / URL 变化时刷新翻译激活态（导航自动重译由主进程自持，UI 仅镜像）
  useEffect(() => {
    if (!activeTabId) {
      setTranslateActive(false);
      return;
    }
    let cancelled = false;
    window.urchin
      .invoke('translate.getStatus', { tabId: activeTabId })
      .then((res) => {
        if (!cancelled) setTranslateActive((res as { active: boolean }).active);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTabId, activeTab?.url]);

  // 翻译进度事件订阅（只响应活跃 tab，避免后台 tab 噪音；划词结果卡订阅在 ContentArea）
  useEffect(() => {
    const offProgress = window.urchin.on('translate:progress', (payload) => {
      const data = payload as {
        tabId: number;
        phase: 'collecting' | 'translating' | 'done' | 'error';
        done?: number;
        total?: number;
        message?: string;
      };
      if (data.tabId !== activeTabIdRef.current) return;
      if (data.phase === 'translating') {
        setActionToast(`正在翻译 ${data.done ?? 0}/${data.total ?? 0} 段…`);
      } else if (data.phase === 'done') {
        setActionToast(
          data.message ?? (data.total ? `翻译完成（共 ${data.total} 段）` : '已恢复原文'),
        );
        window.urchin
          .invoke('translate.getStatus', { tabId: data.tabId })
          .then((res) => {
            setTranslateActive((res as { active: boolean }).active);
          })
          .catch(() => undefined);
      } else if (data.phase === 'error') {
        setActionToast(data.message ?? '翻译失败');
      }
    });
    return () => {
      offProgress();
    };
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
        windowId: await getCurrentWindowId(),
        url: 'urchin://settings',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open settings tab:', e);
    }
  }, [tabs, activeTabId]);

  // 打开 GenOffice 文档主页（阶段 4.5，用户指令：左侧栏入口改为嵌入的
  // GenOffice 前端入口）：已有主页标签则激活，否则新建
  const handleOpenGenOfficeHome = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://genoffice-home'));
    if (existing) {
      try {
        await window.urchin.invoke('tab.setActive', { tabId: existing.id });
      } catch (e) {
        console.error('Failed to activate GenOffice home tab:', e);
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://genoffice-home',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open GenOffice home tab:', e);
    }
  }, [tabs]);

  // 打开 pi 模块（ADR-014）：确保服务运行 → 直接打开/聚焦 pi 聊天页（http 标签）。
  // 服务常驻——关 pi 标签不停服务；无启动器中间页；无 toggle 关闭语义。
  // origin 匹配复用标签（兼容页面导航后 token 丢失、URL 变化）。
  const handleOpenPi = useCallback(async () => {
    let piUrl: string | null = null;
    let piState: string | undefined;
    try {
      const s = (await window.urchin.invoke('piWebHost.status', {})) as {
        state?: string;
        url?: string;
      };
      piState = s.state;
      if (s.state === 'running' && typeof s.url === 'string') piUrl = s.url;
    } catch {
      // IPC 未就绪：提示错误
      setActionToast('pi 服务状态查询失败');
      setPiServiceState('error');
      return;
    }

    // starting：服务正在启动，提示等待
    if (piState === 'starting') {
      setActionToast('正在启动 pi…');
      return;
    }

    // stopped / error：启动服务（launch 幂等，error 态会重启）
    if (!piUrl) {
      setPiServiceState('starting');
      setActionToast('正在启动 pi…');
      try {
        const res = (await window.urchin.invoke('piWebHost.launch', {})) as {
          url?: string;
        };
        if (typeof res.url === 'string') {
          piUrl = res.url;
        } else {
          throw new Error('launch returned no url');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionToast(`pi 启动失败：${msg}`);
        setPiServiceState('error');
        return;
      }
    }

    // 服务就绪：按 origin 复用/新建 pi 标签
    const targetOrigin = (() => {
      try {
        return piUrl ? new URL(piUrl).origin : null;
      } catch {
        return null;
      }
    })();
    const existing = targetOrigin
      ? tabs.find((t) => {
          try {
            return t.url && new URL(t.url).origin === targetOrigin;
          } catch {
            return false;
          }
        })
      : undefined;
    if (existing) {
      try {
        await window.urchin.invoke('tab.setActive', { tabId: existing.id });
      } catch (e) {
        console.error('Failed to activate pi tab:', e);
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: piUrl,
        active: true,
      });
    } catch (e) {
      console.error('Failed to open pi tab:', e);
    }
  }, [tabs]);

  /**
   * 打开邮箱标签页（M25）：toggle 模式——已存在则激活，否则创建。
   * 与 handleOpenAi 同模式：urchin://mail 内部页由 React MailView 渲染。
   */
  const handleOpenMail = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://mail'));
    if (existing) {
      if (existing.id !== activeTabId) {
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate mail tab:', e);
        }
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://mail',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open mail tab:', e);
    }
  }, [tabs, activeTabId]);

  /**
   * 打开笔记 / 便利贴页（M27）：toggle 模式——已存在则激活，否则创建。
   * 与邮箱一致：urchin://notebook 内部页由 React NotebookView 渲染。
   */
  const handleOpenNotebook = useCallback(async () => {
    const existing = tabs.find((t) => t.url?.startsWith('urchin://notebook'));
    if (existing) {
      if (existing.id !== activeTabId) {
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate notebook tab:', e);
        }
      }
      return;
    }
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://notebook',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open notebook tab:', e);
    }
  }, [tabs, activeTabId]);

  /**
   * 打开 DeepSeek Harness 标签页：启动 dsh web 子进程 → 在浏览器标签页打开前端。
   * 与 piWeb 不同：关闭该标签页后自动停止后端（主进程 tab-lifecycle 绑定）。
   * toggle 语义：已激活则关闭标签（触发后端停止）；未激活则激活；未运行则启动。
   */
  const handleOpenDeepSeekHarness = useCallback(async () => {
    // 查 dsh 服务状态：running 则复用/激活标签
    let dshUrl: string | null = null;
    try {
      const s = (await window.urchin.invoke('deepseekHarness.status', {})) as {
        state?: string;
        url?: string;
      };
      if (s.state === 'running' && typeof s.url === 'string') dshUrl = s.url;
    } catch {
      // 状态查询失败：回落到启动流程
    }
    if (dshUrl) {
      const dshTab = tabs.find((t) => t.url?.startsWith(dshUrl));
      if (dshTab) {
        if (dshTab.id === activeTabId) {
          // 已激活 → 关闭标签（触发后端停止）
          try {
            await window.urchin.invoke('tab.close', { tabId: dshTab.id });
          } catch (e) {
            console.error('Failed to close dsh tab:', e);
          }
        } else {
          try {
            await window.urchin.invoke('tab.setActive', { tabId: dshTab.id });
          } catch (e) {
            console.error('Failed to activate dsh tab:', e);
          }
        }
        return;
      }
      // 服务运行但标签已关闭 → 新开标签
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url: dshUrl,
          active: true,
        });
      } catch (e) {
        console.error('Failed to open dsh tab:', e);
      }
      return;
    }
    // 未运行 → launch → 打开标签
    setDshStarting(true);
    try {
      const res = (await window.urchin.invoke('deepseekHarness.launch', {})) as {
        url: string;
        port: number;
      };
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: res.url,
        active: true,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setActionToast(`DeepSeek Harness 启动失败：${message}`);
      console.error('Failed to launch dsh:', e);
    } finally {
      setDshStarting(false);
    }
  }, [tabs, activeTabId]);

  // doCloseTab / doSelectTab / handleCloseTab / handleSelectTab / editorGuardAsk /
  // beforeunload 兜底声明于上方「编辑守卫」区（tab 事件订阅 effect 之前）。

  /**
   * 标签拖出浏览器窗口：自定义指针拖拽，检测到鼠标移出窗口边界时
   * 经 window.createWithUrl 在新窗口打开该 URL。
   *
   * 方案背景（2026-08-19 迭代）：
   * - v1 HTML5 系统拖放（text/uri-list）→ Windows 对拖到桌面的 URL 默认生成快捷方式，
   *   且拖出窗口后 DOM 事件由 OS 接管、主进程拿不到 URL
   * - v2 自定义拖拽：窗口内全程受控（指针事件），移出边界即触发打开
   * - v3（用户反馈）：① 拖出后关闭原窗口标签（移动语义，与原窗口不再保留一致）；
   *   ② 新窗口定位到拖出瞬间的屏幕坐标（跟随拖拽位置，不重叠在原窗口上）。
   *   指针移出 OS 窗口后渲染进程收不到事件，故用出界瞬间的屏幕坐标定位（出界即开窗）
   * 仅 http/https 可拖（内部页无法外部打开）。
   */
  const tabDragRef = useRef<{
    pointerId: number;
    url: string;
    tabId: number;
    workspaceId: string;
    captureEl: HTMLElement;
  } | null>(null);

  const handleTabPointerDown = useCallback((e: React.PointerEvent, tab: TabSnapshot) => {
    // TP7：右键不触发拖拽（右键弹出工作区菜单）
    if (e.button !== 0) return;
    if (!/^https?:\/\//i.test(tab.url)) return;
    // 关闭按钮等交互元素上不启动拖拽：setPointerCapture 会把 pointerup 后的
    // click 事件重定向到卡片（捕获目标），关闭按钮的 onClick 永远不触发（关闭阻塞）
    if ((e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    tabDragRef.current = {
      pointerId: e.pointerId,
      url: tab.url,
      tabId: tab.id,
      workspaceId: tab.workspaceId ?? DEFAULT_WORKSPACE_ID,
      captureEl: el,
    };
    if (typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 指针捕获失败忽略：仍可拖拽 */
      }
    }
  }, []);

  const handleTabPointerMove = useCallback((e: React.PointerEvent) => {
    const st = tabDragRef.current;
    if (!st) return;
    // 指针移出窗口边界 → 在新窗口打开该标签 URL（定位到出界屏幕坐标），并关闭原窗口标签
    if (
      e.clientX < 0 ||
      e.clientY < 0 ||
      e.clientX > window.innerWidth ||
      e.clientY > window.innerHeight
    ) {
      tabDragRef.current = null;
      try {
        st.captureEl.releasePointerCapture(st.pointerId);
      } catch {
        /* 未捕获/已释放忽略 */
      }
      const { url, tabId, workspaceId } = st;
      void window.urchin
        .invoke('window.createWithUrl', { url, x: e.screenX, y: e.screenY, workspaceId })
        .then(() => window.urchin.invoke('tab.close', { tabId }))
        .catch((err) => console.error('Failed to open tab in new window:', err));
    }
  }, []);

  const handleTabPointerEnd = useCallback(() => {
    tabDragRef.current = null;
  }, []);

  /** 标签卡片右键菜单：记录点击位置与标签快照（跨工作区打开/关闭标签）。 */
  const handleTabContextMenu = useCallback((e: React.MouseEvent, tab: TabSnapshot) => {
    e.preventDefault();
    setTabCardMenu({
      x: e.clientX,
      y: e.clientY,
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title || tab.url || '新标签页',
        workspaceId: tab.workspaceId ?? DEFAULT_WORKSPACE_ID,
      },
    });
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
          windowId: await getCurrentWindowId(),
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
  const notifyLayout = useCallback(
    async (left: number, right: number, dtw?: number) => {
      try {
        await window.urchin.invoke('ui.layout.setState', {
          leftWidth: left,
          rightWidth: right,
          bottomHeight: BOTTOM_HEIGHT,
          devtoolsWidth: dtw ?? devtoolsWidth,
        });
      } catch (e) {
        console.error('Failed to update layout:', e);
      }
    },
    [devtoolsWidth],
  );

  const handleToggleLeft = useCallback(() => {
    const next = !leftExpanded;
    setLeftExpanded(next);
    setLeftHovered(false);
    setLeftRetracting(false);
    void notifyLayout(
      next ? LEFT_EXPANDED : LEFT_COLLAPSED,
      rightExpanded ? rightExpandedWidth : RIGHT_COLLAPSED,
      devtoolsOpen ? devtoolsWidth : 0,
    );
  }, [leftExpanded, rightExpanded, rightExpandedWidth, notifyLayout, devtoolsOpen, devtoolsWidth]);

  const handleToggleRight = useCallback(() => {
    const next = !rightExpanded;
    setRightExpanded(next);
    // 手动切换时清除悬停/回弹状态
    setRightHovered(false);
    setRightRetracting(false);
    void notifyLayout(
      leftExpanded || leftHovered ? LEFT_EXPANDED : LEFT_COLLAPSED,
      next ? rightExpandedWidth : RIGHT_COLLAPSED,
      devtoolsOpen ? devtoolsWidth : 0,
    );
  }, [
    leftExpanded,
    leftHovered,
    rightExpanded,
    rightExpandedWidth,
    notifyLayout,
    devtoolsOpen,
    devtoolsWidth,
  ]);

  // 双击右侧边栏空白处：展开/折叠切换（替代已移除的底部折叠/展开按钮）
  // 与悬停自动展开/自动折叠互斥（右侧栏自动展开开关控制后者）
  // 仅空白区域触发：标签卡片（data-tab-card）、按钮、宽度拖拽手柄（role=separator）
  // 等交互元素各自处理自己的点击，双击其上不应折叠/展开整栏
  const handleRightDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (target.closest('button, [role="separator"], [data-tab-card]')) return;
      handleToggleRight();
    },
    [handleToggleRight],
  );

  // 右侧栏悬停展开：仅当栏处于折叠状态（rightExpanded=false）且设置允许自动展开时触发
  // 使用设置中配置的延迟（debug.sidebarHoverDelay），0 = 立即展开
  const handleRightMouseEnter = useCallback(() => {
    if (rightExpanded || !rightSidebarAutoExpand) return;
    // TP7：鼠标停在工作区切换器图标上时抑制自动展开（滚轮切换工作区不被打断）
    if (workspaceAvatarHoverRef.current) return;
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
      void notifyLayout(
        leftExpanded || leftHovered ? LEFT_EXPANDED : LEFT_COLLAPSED,
        rightExpandedWidth,
        devtoolsOpen ? devtoolsWidth : 0,
      );
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
    leftHovered,
    rightExpandedWidth,
    notifyLayout,
    sidebarHoverDelay,
    devtoolsOpen,
    devtoolsWidth,
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
    void notifyLayout(
      leftExpanded || leftHovered ? LEFT_EXPANDED : LEFT_COLLAPSED,
      RIGHT_COLLAPSED,
      devtoolsOpen ? devtoolsWidth : 0,
    );
    // 回弹动画结束后清除标记（300ms 对应回弹时长）
    window.setTimeout(() => setRightRetracting(false), 320);
  }, [
    rightExpanded,
    rightHovered,
    leftExpanded,
    leftHovered,
    notifyLayout,
    devtoolsOpen,
    devtoolsWidth,
  ]);

  const handleLeftDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (target.closest('button, input, textarea, [role="separator"], [data-transit-item]')) {
        return;
      }
      handleToggleLeft();
    },
    [handleToggleLeft],
  );

  const handleLeftMouseEnter = useCallback(() => {
    if (leftExpanded || !leftSidebarAutoExpand) return;
    if (leftHoverTimerRef.current) {
      clearTimeout(leftHoverTimerRef.current);
      leftHoverTimerRef.current = null;
    }
    const doExpand = (): void => {
      setLeftHovered(true);
      setLeftRetracting(false);
      void notifyLayout(
        LEFT_EXPANDED,
        rightExpanded || rightHovered ? rightExpandedWidth : RIGHT_COLLAPSED,
        devtoolsOpen ? devtoolsWidth : 0,
      );
    };
    if (sidebarHoverDelay <= 0) {
      doExpand();
    } else {
      leftHoverTimerRef.current = setTimeout(() => {
        leftHoverTimerRef.current = null;
        doExpand();
      }, sidebarHoverDelay);
    }
  }, [
    leftExpanded,
    leftSidebarAutoExpand,
    rightExpanded,
    rightHovered,
    rightExpandedWidth,
    notifyLayout,
    sidebarHoverDelay,
    devtoolsOpen,
    devtoolsWidth,
  ]);

  const handleLeftMouseLeave = useCallback(() => {
    if (leftHoverTimerRef.current) {
      clearTimeout(leftHoverTimerRef.current);
      leftHoverTimerRef.current = null;
    }
    if (leftExpanded || !leftHovered) return;
    setLeftRetracting(true);
    setLeftHovered(false);
    void notifyLayout(
      LEFT_COLLAPSED,
      rightExpanded || rightHovered ? rightExpandedWidth : RIGHT_COLLAPSED,
      devtoolsOpen ? devtoolsWidth : 0,
    );
    window.setTimeout(() => setLeftRetracting(false), 320);
  }, [
    leftExpanded,
    leftHovered,
    rightExpanded,
    rightHovered,
    rightExpandedWidth,
    notifyLayout,
    devtoolsOpen,
    devtoolsWidth,
  ]);

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
      void notifyLayout(
        leftExpanded || leftHovered ? LEFT_EXPANDED : LEFT_COLLAPSED,
        next,
        devtoolsOpen ? devtoolsWidth : 0,
      );
    },
    [leftExpanded, leftHovered, notifyLayout, devtoolsOpen, devtoolsWidth],
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

  // toggle 收藏：已收藏则删除，未收藏则弹出收藏夹面板选择文件夹保存（dev.120）。
  // 未收藏分支不再直接 bookmark.create 到根级——改由面板 picker 模式让用户选目标文件夹。
  const handleSaveBookmark = useCallback(async () => {
    if (!activeTab?.url || !isBookmarkable(activeTab.url)) return;
    try {
      if (bookmarkSaved && currentBookmarkId) {
        // 已收藏 → 删除
        await window.urchin.invoke('bookmark.delete', { id: currentBookmarkId });
        setBookmarkSaved(false);
        setCurrentBookmarkId(null);
        setBookmarkToast('已从书签移除');
        setTimeout(() => setBookmarkToast(null), 2000);
        void refreshBookmarkSaved(activeTab.url);
      } else {
        // 未收藏 → 弹出收藏夹面板（picker 模式）选文件夹保存
        await window.urchin.invoke('ui.panel.saveBookmarkPicker', {});
        // 实际保存由面板内完成；bookmark:changed 广播后 refreshBookmarkSaved 会刷新星标
      }
    } catch (e) {
      console.error('Failed to toggle bookmark:', e);
      setBookmarkToast('书签操作失败');
      setTimeout(() => setBookmarkToast(null), 2000);
    }
  }, [activeTab?.url, bookmarkSaved, currentBookmarkId, refreshBookmarkSaved]);

  // URL 变化时重新检查收藏状态（修复：此前仅 setBookmarkSaved(false) 未查询实际状态）
  useEffect(() => {
    void refreshBookmarkSaved(activeTab?.url);
  }, [activeTab?.url, refreshBookmarkSaved]);

  // 书签变更同步：主进程广播 bookmark:changed（收藏夹面板取消收藏等场景），
  // 重新查询当前 URL 收藏状态，让地址栏星标亮/灭与数据一致。
  useEffect(() => {
    const unsubscribe = window.urchin.on('bookmark:changed', () => {
      void refreshBookmarkSaved(activeTab?.url);
    });
    return () => {
      unsubscribe();
    };
  }, [activeTab?.url, refreshBookmarkSaved]);

  const leftWidth = leftExpanded || leftHovered ? LEFT_EXPANDED : LEFT_COLLAPSED;
  // 右侧栏有效展开：固定展开 OR 折叠态下的悬停预览
  const effectiveRightExpanded = rightExpanded || rightHovered;
  const rightWidth = effectiveRightExpanded ? rightExpandedWidth : RIGHT_COLLAPSED;

  // M15 DevTools 检视列开合/宽度变化 → 同步主进程 BrowserView bounds（扣减右侧区域）。
  // 放在此处确保 leftWidth/rightWidth 已定义；devtoolsOpen=false 传 0（折叠）。
  useEffect(() => {
    void notifyLayout(leftWidth, rightWidth, devtoolsOpen ? devtoolsWidth : 0);
  }, [devtoolsOpen, devtoolsWidth, leftWidth, rightWidth, notifyLayout]);

  // 中区内容页判断（供整窗快照叠加判定 / 状态栏导航禁用判定；
  // 内容分支渲染已迁至 ContentArea，两处各自做纯派生、无状态真源）
  // 注意：urchin://settings 会被 Electron URL 规范化为带末尾斜杠，
  // 所以用 startsWith 判断而非严格相等，避免匹配失败导致组件不渲染。
  const isSettingsTab = !!activeTab?.url?.startsWith('urchin://settings');
  const isMailTab = !!activeTab?.url?.startsWith('urchin://mail');
  const isNotebookTab = !!activeTab?.url?.startsWith('urchin://notebook');
  const isGenOfficeHomeTab = !!activeTab?.url?.startsWith('urchin://genoffice-home');
  const isNewTab = !!activeTab?.url?.startsWith('urchin://newtab');
  const isWorkspacesTab = !!activeTab?.url?.startsWith('urchin://workspaces');
  const isFileViewerTab = !!activeTab?.url?.startsWith('urchin://file-viewer');
  // GenOffice 编辑器标签（阶段 2）：视图由主进程 WebContentsView 覆盖渲染，
  // React 中区留空、底部地址栏隐藏（编辑器自带工具条与保存流程）
  const isGenOfficeTab = activeTab?.viewKind === 'genoffice';
  // 渲染优先级：设置页 > GenOffice 主页 > 主页 > 文件查看器 > 普通网页
  // settings / genoffice-home / newtab / file-viewer 都由 React 组件渲染，
  // BrowserView 让出空间（ZERO_BOUNDS）；pi 聊天页是 http 标签，BrowserView 正常渲染

  // 内部页面（settings / mail / genoffice-home / newtab / file-viewer / genoffice）
  // 下，导航按钮无意义，禁用
  const isInternalPage =
    isSettingsTab ||
    isMailTab ||
    isNotebookTab ||
    isGenOfficeHomeTab ||
    isNewTab ||
    isWorkspacesTab ||
    isFileViewerTab ||
    isGenOfficeTab;

  // ── TP7 工作区状态与操作：收拢于 workspaces/use-workspaces.ts hook ──
  // 真源仍归 App 域（currentWorkspaceId 被 tab:event 订阅 / handleNewTab / 总览页 /
  // 侧栏多处消费；快照采集依赖 contentAreaRef 与 isInternalPage，见 hook 头注释）。
  // lastActive / TP4 懒恢复两个 ref 仍由 App 持有传入（分别被 tab:event 订阅与
  // 启动加载 effect 写入）。
  const {
    workspaces,
    currentWorkspaceId,
    workspaceOverviewItems,
    visibleTabs,
    handleSwitchWorkspace,
    handleCycleWorkspace,
    handleCreateAndSwitchWorkspace,
    handleOverviewSwitch,
    handleOverviewCreate,
    handleUpdateWorkspace,
    handleRemoveWorkspace,
    handleClearWorkspaceData,
    handleOpenInWorkspace,
    handleOpenInNewWorkspace,
    handleOpenWorkspacesPage,
  } = useWorkspaces({
    tabs,
    activeTabId,
    contentAreaRef,
    isInternalPage,
    lastActiveByWorkspaceRef,
    savedTabsByWorkspaceRef,
    doSelectTab,
    doCloseTab,
    handleCloseTab,
  });

  // 新标签页归属当前工作区（TP7），依赖 hook 返回的 currentWorkspaceId，
  // 故声明于 hook 调用之后（仅被 JSX onNewTab 消费，移位不影响行为）。
  const handleNewTab = useCallback(async () => {
    try {
      // 新标签页总是作为内部页（urchin://newtab）无法被归类到某个网站，
      // 显式归属当前工作区（TP7：空工作区的新建也落在该工作区）。
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://newtab',
        active: true,
        workspaceId: currentWorkspaceId,
      });
    } catch (e) {
      console.error('Failed to create tab:', e);
    }
  }, [currentWorkspaceId]);

  /** 折叠态：悬停工作区切换器时抑制侧栏自动展开（滚轮切换不被打断）。 */
  const handleWorkspaceAvatarEnter = useCallback(() => {
    workspaceAvatarHoverRef.current = true;
    if (rightHoverTimerRef.current) {
      clearTimeout(rightHoverTimerRef.current);
      rightHoverTimerRef.current = null;
    }
    setRightHovered(false);
  }, []);
  const handleWorkspaceAvatarLeave = useCallback(() => {
    workspaceAvatarHoverRef.current = false;
  }, []);

  // 折叠态工作区总览页开关（handleOpenWorkspacesPage）/ 总览页数据
  // （workspaceOverviewItems）/ 当前工作区标签列表（visibleTabs）均已随工作区
  // 状态收拢进 use-workspaces.ts（见上方 hook 调用点）。

  // 按住侧边栏空白处拖动窗口（左/右两侧栏共用）
  const windowDrag = useWindowDrag();

  // 左右侧栏 DOM 引用：用于在宽度过渡期间读取实际 offsetWidth，同步 BrowserView bounds
  const leftAsideRef = useRef<HTMLElement>(null);
  const rightAsideRef = useRef<HTMLElement>(null);

  // 主页跳转（主页按钮）：新建标签打开主页，绝不把当前网站标签原地变成主页
  // （原地跳转会毁掉被顶下去的网站标签——此前"变新标签页"bug 的根因）。
  // 当前已是最新主页（urchin://newtab）时不重复创建，避免堆叠主页标签。
  const handleGoHome = useCallback(() => {
    if (activeTab?.url === 'urchin://newtab') return;
    void (async () => {
      try {
        await window.urchin.invoke('tab.create', {
          windowId: await getCurrentWindowId(),
          url: 'urchin://newtab',
          active: true,
        });
      } catch (e) {
        console.error('Failed to open homepage:', e);
      }
    })();
  }, [activeTab?.url]);

  // Windows 使用自绘 chrome（8px 外框 + 圆角 shell + 自绘标题栏）；
  // 其他平台保留原生标题栏，渲染层不叠加外框/标题栏，避免双重窗口装饰。
  const useCustomChrome = window.urchin.platform === 'win32';

  // 侧栏宽度过渡同步：侧栏展开/折叠/悬停时有 CSS width transition（150/300ms），
  // 而 notifyLayout 在切换瞬间发送目标宽度，BrowserView 瞬间跳到目标宽度，
  // 过渡期侧栏仍较宽 → 网页盖住侧栏。此处用 rAF 循环读取实际宽度并同步主进程，
  // 使 BrowserView bounds 跟随动画宽度，消除覆盖。过渡结束后停止。
  useEffect(() => {
    if (!useCustomChrome) return;
    let raf = 0;
    let lastLeft = -1;
    let lastRight = -1;
    let stableCount = 0;
    const sync = (): void => {
      const leftEl = leftAsideRef.current;
      const rightEl = rightAsideRef.current;
      const left = leftEl
        ? Math.round(leftEl.offsetWidth)
        : leftExpanded
          ? LEFT_EXPANDED
          : LEFT_COLLAPSED;
      const right = rightEl
        ? Math.round(rightEl.offsetWidth)
        : rightExpanded || rightHovered
          ? rightExpandedWidth
          : RIGHT_COLLAPSED;
      if (left !== lastLeft || right !== lastRight) {
        lastLeft = left;
        lastRight = right;
        stableCount = 0;
        void notifyLayout(left, right, devtoolsOpen ? devtoolsWidth : 0);
      } else {
        stableCount += 1;
      }
      // 连续 6 帧宽度不变（约 100ms）或总时长超 450ms 后停止
      if (stableCount < 6) {
        raf = requestAnimationFrame(sync);
      }
    };
    raf = requestAnimationFrame(sync);
    const stop = window.setTimeout(() => cancelAnimationFrame(raf), 450);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(stop);
    };
  }, [
    leftExpanded,
    leftHovered,
    leftRetracting,
    rightExpanded,
    rightHovered,
    rightRetracting,
    rightExpandedWidth,
    notifyLayout,
    useCustomChrome,
    devtoolsOpen,
    devtoolsWidth,
  ]);

  // ── 底部悬浮状态栏：状态同步 + 动作分发 ──
  // 状态栏为独立透明子窗口悬浮于网页之上（main/status-bar/status-bar-overlay.ts），
  // 不在主窗口 React 层渲染。主渲染进程仍是 tab/建议/书签/toast/主题 的单一真源；
  // 此处组装快照经 ui.statusbar.sync 同步给主进程转发，用户动作经 ui.statusbar.action
  // 回传分发到既有 handler（见下方 effect）。
  const statusBarState = useMemo<StatusBarState>(() => {
    // 所有页面（含 GenOffice 与 pi 聊天页）均用悬浮地址栏
    const statusBarVisible = true;
    // 导航禁用页面（设置/邮件/主页/工作区/文件查看器）：后退/前进/刷新无意义
    const isNavDisabledPage = isInternalPage && !isGenOfficeTab && !isGenOfficeHomeTab;
    // toast 优先级：DeepSeek Harness 启动 > 截图/翻译 > 书签
    const toast = dshStarting
      ? { text: '正在启动 DeepSeek Harness…', spinning: true }
      : actionToast
        ? { text: actionToast }
        : bookmarkToast
          ? { text: bookmarkToast }
          : null;
    return {
      visible: statusBarVisible,
      url: activeTab?.url ?? '',
      loading: activeTab?.loading ?? false,
      securityState: getSecurityState(activeTab?.url ?? ''),
      canGoBack: !isNavDisabledPage && !!activeTab?.canGoBack,
      canGoForward: !isNavDisabledPage && !!activeTab?.canGoForward,
      reloadDisabled: !activeTabId || isNavDisabledPage,
      bookmarkSaved,
      bookmarkable: !isNavDisabledPage && !!activeTab?.url && isBookmarkable(activeTab.url),
      screenshotDisabled: !activeTabId,
      clipDisabled: !activeTab?.url || !/^https?:\/\//i.test(activeTab.url),
      translateActive,
      translateDisabled: !activeTab?.url || !/^https?:\/\//i.test(activeTab.url),
      searchEngine,
      suggestions: suggestions.map((s) => ({ ...s })),
      toast,
      theme,
      collapsed: false, // 折叠态由主进程管理，App 恒发 false
    };
  }, [
    isGenOfficeTab,
    isGenOfficeHomeTab,
    isInternalPage,
    activeTab?.url,
    activeTab?.loading,
    activeTab?.canGoBack,
    activeTab?.canGoForward,
    activeTabId,
    bookmarkSaved,
    actionToast,
    bookmarkToast,
    dshStarting,
    translateActive,
    searchEngine,
    suggestions,
    theme,
  ]);

  useEffect(() => {
    void window.urchin.invoke('ui.statusbar.sync', statusBarState).catch((e) => {
      console.error('Failed to sync status bar state:', e);
    });
  }, [statusBarState]);

  // 悬浮层用户动作 → 分发到既有 handler（与原内嵌地址栏行为一致）
  useEffect(() => {
    const off = window.urchin.on('ui.statusbar.action', (payload) => {
      const action = payload as StatusBarAction;
      switch (action.type) {
        case 'navigate':
          void handleNavigate(action.url);
          break;
        case 'back':
          void handleGoBack();
          break;
        case 'forward':
          void handleGoForward();
          break;
        case 'reload':
          void handleReload();
          break;
        case 'bookmark-toggle':
          void handleSaveBookmark();
          break;
        case 'screenshot':
          void handleScreenshot();
          break;
        case 'clip':
          void handleClip();
          break;
        case 'translate':
          void handleTranslate();
          break;
        case 'suggestion-query':
          void handleSuggestionQuery(action.query);
          break;
        case 'focus-page':
          // 主进程已处理焦点；此处无需动作
          break;
      }
    });
    return off;
  }, [
    handleNavigate,
    handleGoBack,
    handleGoForward,
    handleReload,
    handleSaveBookmark,
    handleScreenshot,
    handleClip,
    handleTranslate,
    handleSuggestionQuery,
  ]);

  return (
    <div
      className={cn(
        'h-screen w-screen overflow-hidden',
        useCustomChrome ? 'app-window-frame' : 'bg-titlebar',
      )}
      // 外框（8px #F6F2F0）长按拖动窗口：仅当点到外框本身（e.target===currentTarget）时启动，
      // 避免与标题栏/侧栏/内容交互冲突。
      onPointerDown={(e) => {
        if (useCustomChrome && e.target === e.currentTarget) {
          windowDrag.startDrag(e);
        }
      }}
      onPointerMove={windowDrag.moveDrag}
      onPointerUp={windowDrag.endDrag}
      onPointerCancel={windowDrag.endDrag}
      // 拖放本地文件到窗口：直接按类型在新标签页打开（audio/video/pdf 原生渲染，文本走查看器）
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        // 中转区拖入：link/video → 打开 URL
        const transitItem = parseTransitDrag(e.dataTransfer);
        if (transitItem) {
          if ((transitItem.kind === 'link' || transitItem.kind === 'video') && transitItem.url) {
            handleOpenFilePath(transitItem.url);
          }
          return;
        }
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const path = resolveDroppedFilePath(file);
        if (path) handleOpenFilePath(path);
      }}
    >
      <div
        data-app-window-bg="true"
        // 窗口统一底色：以标题栏同色令牌 --color-titlebar 为顶部基调，向下渐变到
        // surface；左右侧栏/内容区/地址栏均透明，让同一层渐变贯穿整个窗口，消除各区域
        // 独立背景造成的竖向色带。顶部只在中段叠一层极淡品牌色，边缘仍保持标题栏同色。
        className={cn(
          'flex h-full w-full flex-col overflow-hidden bg-titlebar',
          useCustomChrome && 'app-window-shell',
        )}
        style={{
          backgroundImage:
            'radial-gradient(ellipse 92% 42% at 50% 18%, color-mix(in srgb, var(--color-primary) 8%, transparent) 0%, transparent 72%), linear-gradient(180deg, var(--color-titlebar) 0%, color-mix(in srgb, var(--color-titlebar) 60%, var(--color-surface)) 26%, var(--color-surface) 66%, var(--color-surface-secondary) 100%)',
        }}
      >
        {useCustomChrome && <AppTitleBar />}

        {/* 主体三列：左/右侧栏夹住中区，整体位于自绘标题栏下方 */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* === 左侧栏 ===
           *  背景透明，透出窗口级统一渐变（顶部与 OS 原生标题栏同色）；
           *  border-r 保留：这是"左侧边栏与网页区"之间的分割线
           *  （网页区左上角圆角的夹角边之一）。
           *  尺寸与悬停状态由 App 持有（leftWidth 同时驱动主进程 BrowserView bounds）。 */}
          <LeftSidebar
            expanded={leftExpanded}
            hovered={leftHovered}
            retracting={leftRetracting}
            width={leftWidth}
            asideRef={leftAsideRef}
            piServiceState={piServiceState}
            onToggle={handleToggleLeft}
            onMouseEnter={handleLeftMouseEnter}
            onMouseLeave={handleLeftMouseLeave}
            onDoubleClick={handleLeftDoubleClick}
            onOpenDeepSeekHarness={() => void handleOpenDeepSeekHarness()}
            onOpenPi={() => void handleOpenPi()}
            onOpenNotebook={() => void handleOpenNotebook()}
            onOpenGenOfficeHome={() => void handleOpenGenOfficeHome()}
            onOpenMail={() => void handleOpenMail()}
            onGoHome={() => void handleGoHome()}
            onOpenSettings={() => void handleOpenSettings()}
          />

          {/* === 中间列：ContentArea（内容区 + 编辑守卫弹窗 + 划词翻译卡） ===
           *  展示组件见 content/ContentArea.tsx（refactor-plan-p2 §2.3 步骤 4）；
           *  标签/工作区/守卫触发的真源仍在 App（tab 生命周期被侧栏列表、
           *  右键菜单、tab:event 弹回守卫多处消费）。 */}
          <ContentArea
            contentAreaRef={contentAreaRef}
            activeTab={activeTab}
            activeTabId={activeTabId}
            tabCount={tabs.length}
            onNavigate={(url) => void handleNavigate(url)}
            onOpenFilePicker={() => void handleOpenFilePicker()}
            onFileViewerToast={showEditorToast}
            workspaceOverviewItems={workspaceOverviewItems}
            currentWorkspaceId={currentWorkspaceId}
            onOverviewSwitch={handleOverviewSwitch}
            onOverviewCreate={handleOverviewCreate}
            guardAsk={editorGuardAsk}
            onGuardDismiss={() => setEditorGuardAsk(null)}
          />

          {/* M15 DevTools 检视列（F12 开关；右侧栏左侧的第三列）。
           *  开合/宽度真源在 App（useDevtoolsColumn：width 驱动主进程
           *  BrowserView bounds），派生逻辑在 DevToolsPanel 内部。 */}
          {devtoolsOpen && (
            <DevToolsPanel
              activeTab={activeTab}
              onWidthChange={setDevtoolsWidth}
              width={devtoolsWidth}
            />
          )}

          {/* === 右侧栏 ===
           *  展示组件见 sidebar/RightSidebar.tsx（refactor-plan-p2 §2.3 步骤 3）；
           *  尺寸/悬停状态仍由 App 持有（rightWidth 驱动主进程 BrowserView bounds）。 */}
          <RightSidebar
            asideRef={rightAsideRef}
            width={rightWidth}
            effectiveExpanded={effectiveRightExpanded}
            resizing={resizingRight}
            retracting={rightRetracting}
            windowDrag={windowDrag}
            onMouseEnter={handleRightMouseEnter}
            onMouseLeave={handleRightMouseLeave}
            onDoubleClick={handleRightDoubleClick}
            onResizeStart={handleRightResizeStart}
            onResizeMove={handleRightResizeMove}
            onResizeEnd={handleRightResizeEnd}
            workspaces={workspaces}
            currentWorkspaceId={currentWorkspaceId}
            onSelectWorkspace={handleSwitchWorkspace}
            onCycleWorkspace={handleCycleWorkspace}
            onCreateWorkspace={handleCreateAndSwitchWorkspace}
            onWorkspaceContextMenu={(e, workspace) => {
              e.preventDefault();
              setWorkspaceManagerTarget(workspace);
            }}
            tabs={visibleTabs}
            activeTabId={activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onNewTab={() => void handleNewTab()}
            onTabPointerDown={handleTabPointerDown}
            onTabPointerMove={handleTabPointerMove}
            onTabPointerEnd={handleTabPointerEnd}
            onTabContextMenu={handleTabContextMenu}
            switcherMode={workspaceSwitcherMode}
            onSwitcherCycle={handleCycleWorkspace}
            onSwitcherClick={
              workspaceSwitcherMode === 'cards' ? handleOpenWorkspacesPage : handleToggleRight
            }
            onSwitcherPointerEnter={handleWorkspaceAvatarEnter}
            onSwitcherPointerLeave={handleWorkspaceAvatarLeave}
          />
        </div>

        {/* 标签卡片右键菜单（TP7）：在另一工作区打开当前页 / 新工作区 / 关闭标签 */}
        {tabCardMenu && (
          <TabCardContextMenu
            x={tabCardMenu.x}
            y={tabCardMenu.y}
            tab={tabCardMenu.tab}
            workspaces={workspaces}
            onClose={() => setTabCardMenu(null)}
            onOpenInWorkspace={(workspaceId, tab) => void handleOpenInWorkspace(workspaceId, tab)}
            onOpenInNewWorkspace={(tab) => void handleOpenInNewWorkspace(tab)}
            onCloseTab={(tabId) => handleCloseTab(tabId)}
          />
        )}

        {/* 工作区管理对话框（右键工作区选项卡触发，TP7） */}
        {workspaceManagerTarget && (
          <WorkspaceManagerDialog
            workspace={workspaceManagerTarget}
            onClose={() => setWorkspaceManagerTarget(null)}
            onSave={(id, patch) => handleUpdateWorkspace(id, patch)}
            onClearData={(id) => handleClearWorkspaceData(id)}
            onRemove={(id) => handleRemoveWorkspace(id)}
          />
        )}
      </div>
    </div>
  );
}
