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
 * - AI 模块改为独立标签页（urchin://ai），不再融合到地址栏
 * - 地址栏回归纯 URL 输入职责
 * - 左侧栏底部新增 AI 入口按钮，点击创建/激活 urchin://ai 标签页
 * - 移除右侧栏的 AI 会话选项卡（会话列表将在阶段3 重构为 AI 标签页内的左区）
 * - 移除 contentViewHidden / omniboxMode / aiStreaming 状态
 *
 * 事件订阅：通过 window.urchin.on('tab:event', ...) 接收主进程推送的 tab 状态变更
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Moon,
  Sun,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  List as ListIcon,
  Folder,
  FolderOpen,
  FileText,
  ChevronRight,
  ChevronDown,
  Mail as MailIcon,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Omnibox } from './omnibox/omnibox';
// 回退提示：旧对话视图 AiChatView(@urchin/ai-extension)在阶段 1 启动器切换时移出渲染树,
// 恢复时重新 import 并在 isAiTab 分支渲染即可（配套:const host = useMemo(() => createHostFromUrchin(), [])）
import { PiWebLauncherView } from './pi-web/launcher-view';
import { MailView } from './mail/MailView';
import { SettingsPage } from './settings/SettingsPage';
import { NewTabPage } from './home/NewTabPage';
import { GenOfficeHome } from './home/GenOfficeHome';
import { FileViewer } from './files/FileViewer';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { getEditGuardSession, closeNeedsGuard, switchNeedsGuard } from './lib/edit-guard';
import { lookupBuiltinSite, builtinIconUrl } from './home/site-directory-lookup';
import { PiSettingsDialog } from './omnibox/pi-settings-dialog';
import { useTheme } from './theme/theme-provider';
import type { Suggestion } from './omnibox/types';
import { buildSuggestions } from './omnibox/build-suggestions';
import { cn } from './lib/utils';
import { getCurrentWindowId } from './lib/current-window';
import { getGenOfficeTabIcon } from './components/genoffice-icons';

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
  /** 视图类型（阶段 2 GenOffice 融合）：genoffice = 编辑器视图，隐藏地址栏 */
  readonly viewKind?: 'browser' | 'genoffice';
  /** 编辑器未保存修改标记（侧栏脏点） */
  readonly dirty?: boolean;
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
 *  加载中 → spinner；崩溃 → 红叉；urchin://ai → π 品牌图标；urchin://settings → 齿轮；
 *  普通网页 → 优先封装库内置图标（site-directory 命中 → 本地 /sites/<key>.png，离线可用），
 *  未命中内置 → 网页真实 favicon（主进程 page-favicon-updated 抓取）；
 *  图标加载失败逐级回退，皆不可用 → 灰点占位。 */
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
    // dev.45：pi 模块标签统一使用品牌 π 图标（与左侧栏入口一致，public/pi-icon.png）
    return (
      <img
        src="./pi-icon.png"
        alt=""
        draggable={false}
        className={cn('shrink-0 rounded object-contain', className ?? 'h-3 w-3')}
      />
    );
  }
  if (tab.url?.startsWith('urchin://settings')) {
    return <SettingsIcon className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  // 内部页标签图标与左侧栏入口按钮对齐（settings/ai 已上方处理）
  if (tab.url?.startsWith('urchin://newtab')) {
    return <Home className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://mail')) {
    return <MailIcon className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  if (tab.url?.startsWith('urchin://genoffice')) {
    const iconClass = cn('shrink-0', className ?? 'h-3 w-3');
    const genofficeIcon = getGenOfficeTabIcon(tab.url, iconClass);
    if (genofficeIcon) return genofficeIcon;
    return <FileText className={cn('shrink-0 text-text-secondary', className ?? 'h-3 w-3')} />;
  }
  const builtin = lookupBuiltinSite(tab.url ?? '');
  const builtinSrc = builtin ? builtinIconUrl(builtin) : undefined;
  return (
    <TabSiteIcon
      src={builtinSrc ?? tab.favicon}
      fallbackSrc={builtinSrc && tab.favicon ? tab.favicon : undefined}
      className={className}
    />
  );
}

/** 标签页网站图标 <img>：加载失败逐级回退（内置图标 → 网页 favicon → 浏览器图标半透明占位）。
 *  src 变化（同一标签页导航到新站点）时重置回退状态，重新从最新源尝试。 */
function TabSiteIcon({
  src,
  fallbackSrc,
  className,
}: {
  src?: string;
  fallbackSrc?: string;
  className?: string;
}) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    setStep(0);
  }, [src, fallbackSrc]);
  const current = step === 0 ? src : fallbackSrc;
  if (!current) {
    // 完全无法识别（无内置图标、网页无 favicon 或加载失败）：
    // 用浏览器图标半透明占位，淡化显示避免与真实站点图标混淆
    // 相对路径：生产页面从 file:// 加载，绝对路径会解析到磁盘根导致 404
    return (
      <img
        src="./browser-icon.png"
        alt=""
        draggable={false}
        className={cn('shrink-0 object-contain opacity-40', className ?? 'h-3 w-3')}
      />
    );
  }
  return (
    <img
      src={current}
      alt=""
      draggable={false}
      className={cn('shrink-0 object-contain', className ?? 'h-3 w-3')}
      onError={() => setStep((s) => s + 1)}
    />
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
    // 交互元素上不触发窗口拖拽（含标签卡片：卡片自身支持拖出窗口，见 handleTabPointerDown）
    if (
      target.closest(
        'button, input, select, textarea, a, [role="button"], [role="separator"], [data-tab-card]',
      )
    ) {
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
  // 编辑器轻提示（保存失败等）：稳定引用（useEditSession 依赖稳定性需要）。
  // showEditorToast / editorGuardAsk / handleCloseTab / handleSelectTab 声明于
  // 上方「编辑守卫」区（tab 事件订阅 effect 之前，供事件路径守卫引用）。
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
        };
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

  // 截图当前网页（地址栏截图按钮）：主进程弹出整屏框选覆盖窗口，用户拖拽框选
  // 确认后裁剪保存到 <数据目录>/screenshots/ 并打开所在文件夹。
  const handleScreenshot = useCallback(async () => {
    if (!activeTabId) return;
    try {
      await window.urchin.invoke('screenshot.capture', {});
      // 覆盖窗口已弹出（截图/取消结果由覆盖窗口自身处理，无需 toast）
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSummaryToast(`截图失败：${message}`);
    }
  }, [activeTabId]);

  // 右侧边栏悬停展开延迟（ms，从设置读取，默认 300）
  const [sidebarHoverDelay, setSidebarHoverDelay] = useState<number>(300);
  /** 右侧边栏悬停自动展开开关（设置 ui.rightSidebarAutoExpand，默认 true） */
  const [rightSidebarAutoExpand, setRightSidebarAutoExpand] = useState<boolean>(true);

  /** 当前搜索引擎（设置 searchEngine，供地址栏搜索词生成搜索 URL；默认 google） */
  const [searchEngine, setSearchEngine] = useState<string>('google');

  // 右侧栏悬停展开延迟定时器（未触发前可取消）
  const rightHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTabIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // 加载右侧边栏悬停设置（延迟 + 自动展开开关）+ 搜索引擎设置，并监听设置页变更实时更新
  useEffect(() => {
    async function loadHoverSettings() {
      try {
        const [delayRes, autoRes, engineRes] = await Promise.all([
          window.urchin.invoke('settings.get', { key: 'debug.sidebarHoverDelay' }),
          window.urchin.invoke('settings.get', { key: 'ui.rightSidebarAutoExpand' }),
          window.urchin.invoke('settings.get', { key: 'searchEngine' }),
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
        const engine = (engineRes as { value: unknown }).value;
        if (typeof engine === 'string' && engine) {
          setSearchEngine(engine);
        }
      } catch {
        // 使用默认值
      }
    }
    void loadHoverSettings();

    // 监听设置页保存事件，实时更新悬停设置与搜索引擎
    const onSettingsChanged = (e: Event): void => {
      const detail = (e as CustomEvent<{ keys: string[] }>).detail;
      if (
        detail?.keys?.includes('debug.sidebarHoverDelay') ||
        detail?.keys?.includes('ui.rightSidebarAutoExpand') ||
        detail?.keys?.includes('searchEngine')
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

  const [editorGuardAsk, setEditorGuardAsk] = useState<{
    kind: 'close' | 'switch';
    tabId: number;
    run: () => void;
  } | null>(null);

  // 编辑器轻提示（保存失败等）：稳定引用（useEditSession 依赖稳定性需要）
  const showEditorToast = useCallback((msg: string): void => {
    if (msg) setSummaryToast(msg);
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

  /** 翻译激活态镜像（活跃 tab；地址栏按钮高亮/恢复原文判定，主进程为权威源） */
  const [translateActive, setTranslateActive] = useState(false);

  /** 划词翻译结果卡（右键菜单 → 主进程翻译 → translate:selection-result 事件回传；坐标为窗口相对坐标） */
  const [selectionCard, setSelectionCard] = useState<{
    x: number;
    y: number;
    source: string;
    result?: string;
    error?: string;
  } | null>(null);

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
        setSummaryToast('已恢复原文');
      } else {
        const res = (await window.urchin.invoke('translate.start', { tabId: activeTabId })) as {
          status: 'started' | 'skipped';
          message?: string;
          segmentCount?: number;
        };
        if (res.status === 'skipped') {
          setSummaryToast('页面语言与目标语言一致，无需翻译');
        } else {
          setSummaryToast(`正在翻译（共 ${res.segmentCount ?? 0} 段）…`);
        }
      }
    } catch (e) {
      setSummaryToast(`翻译失败：${e instanceof Error ? e.message : String(e)}`);
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

  // 翻译进度事件 + 划词结果卡事件订阅（只响应活跃 tab，避免后台 tab 噪音）
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
        setSummaryToast(`正在翻译 ${data.done ?? 0}/${data.total ?? 0} 段…`);
      } else if (data.phase === 'done') {
        setSummaryToast(
          data.message ?? (data.total ? `翻译完成（共 ${data.total} 段）` : '已恢复原文'),
        );
        window.urchin
          .invoke('translate.getStatus', { tabId: data.tabId })
          .then((res) => {
            setTranslateActive((res as { active: boolean }).active);
          })
          .catch(() => undefined);
      } else if (data.phase === 'error') {
        setSummaryToast(data.message ?? '翻译失败');
      }
    });
    const offSelection = window.urchin.on('translate:selection-result', (payload) => {
      const data = payload as {
        tabId: number;
        source: string;
        result?: string;
        error?: string;
        x: number;
        y: number;
      };
      if (data.tabId !== activeTabIdRef.current) return;
      setSelectionCard({
        x: data.x,
        y: data.y,
        source: data.source,
        result: data.result,
        error: data.error,
      });
    });
    return () => {
      offProgress();
      offSelection();
    };
  }, []);

  const handleNewTab = useCallback(async () => {
    try {
      // 新标签页打开内嵌主页（urchin://newtab，无法自由更换）
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
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

  // 打开 pi 模块（dev.39 一键直达）：pi 已运行 → 直接开/复用 pi 网页标签；
  // 未运行 → 打开启动器标签页（挂载即自动启动并跳转，无需再点「启动」按钮）。
  // 阶段2 解耦：AI 模块作为独立标签页（urchin://ai），不再融合到地址栏
  const handleOpenAi = useCallback(async () => {
    // 1. 查询 pi 服务状态：running 则直达 pi 网页标签（toggle 语义：已激活则关闭标签）
    let piUrl: string | null = null;
    try {
      const s = (await window.urchin.invoke('piWeb.status', {})) as {
        state?: string;
        url?: string;
      };
      if (s.state === 'running' && typeof s.url === 'string') piUrl = s.url;
    } catch {
      // 状态查询失败（如 IPC 未就绪）：回落到启动器页展示错误
    }
    if (piUrl) {
      const piTab = tabs.find((t) => t.url === piUrl);
      if (piTab) {
        if (piTab.id === activeTabId) {
          try {
            await window.urchin.invoke('tab.close', { tabId: piTab.id });
          } catch (e) {
            console.error('Failed to close pi tab:', e);
          }
        } else {
          try {
            await window.urchin.invoke('tab.setActive', { tabId: piTab.id });
          } catch (e) {
            console.error('Failed to activate pi tab:', e);
          }
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
      return;
    }

    // 2. pi 未运行：打开/复用启动器标签页（进入即自动启动）
    const existing = tabs.find((t) => t.url?.startsWith('urchin://ai'));
    if (existing) {
      if (existing.id === activeTabId) {
        // 当前启动器页已激活：关闭它（toggle 行为）
        try {
          await window.urchin.invoke('tab.close', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to close ai tab:', e);
        }
      } else {
        // 启动器页存在但未激活：激活它
        try {
          await window.urchin.invoke('tab.setActive', { tabId: existing.id });
        } catch (e) {
          console.error('Failed to activate ai tab:', e);
        }
      }
      return;
    }
    // 没有启动器标签页，创建新的
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url: 'urchin://ai',
        active: true,
      });
    } catch (e) {
      console.error('Failed to open ai tab:', e);
    }
  }, [tabs, activeTabId]);

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
    setSummaryToast('正在启动 DeepSeek Harness…');
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
      setSummaryToast(`DeepSeek Harness 启动失败：${message}`);
      console.error('Failed to launch dsh:', e);
    }
  }, [tabs, activeTabId]);

  /**
   * 打开 pi 网页版 URL（阶段 1 启动器视图回调）：新开标签页加载。
   * 启动器标签页（urchin://ai）保持打开,随时可返回停止服务。
   */
  const handleOpenPiWebUrl = useCallback(async (url: string) => {
    try {
      await window.urchin.invoke('tab.create', {
        windowId: await getCurrentWindowId(),
        url,
        active: true,
      });
    } catch (e) {
      console.error('Failed to open pi web tab:', e);
    }
  }, []);

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
    captureEl: HTMLElement;
  } | null>(null);

  const handleTabPointerDown = useCallback((e: React.PointerEvent, tab: TabSnapshot) => {
    if (!/^https?:\/\//i.test(tab.url)) return;
    // 关闭按钮等交互元素上不启动拖拽：setPointerCapture 会把 pointerup 后的
    // click 事件重定向到卡片（捕获目标），关闭按钮的 onClick 永远不触发（关闭阻塞）
    if ((e.target as HTMLElement).closest('button')) return;
    const el = e.currentTarget as HTMLElement;
    tabDragRef.current = { pointerId: e.pointerId, url: tab.url, tabId: tab.id, captureEl: el };
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
      const { url, tabId } = st;
      void window.urchin
        .invoke('window.createWithUrl', { url, x: e.screenX, y: e.screenY })
        .then(() => window.urchin.invoke('tab.close', { tabId }))
        .catch((err) => console.error('Failed to open tab in new window:', err));
    }
  }, []);

  const handleTabPointerEnd = useCallback(() => {
    tabDragRef.current = null;
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

  const leftWidth = leftExpanded ? LEFT_EXPANDED : LEFT_COLLAPSED;
  // 右侧栏有效展开：固定展开 OR 折叠态下的悬停预览
  const effectiveRightExpanded = rightExpanded || rightHovered;
  const rightWidth = effectiveRightExpanded ? rightExpandedWidth : RIGHT_COLLAPSED;

  // 中区内容判断
  // 注意：urchin://settings / urchin://ai 会被 Electron URL 规范化为带末尾斜杠，
  // 所以用 startsWith 判断而非严格相等，避免匹配失败导致组件不渲染。
  const isSettingsTab = !!activeTab?.url?.startsWith('urchin://settings');
  const isAiTab = !!activeTab?.url?.startsWith('urchin://ai');
  const isMailTab = !!activeTab?.url?.startsWith('urchin://mail');
  const isGenOfficeHomeTab = !!activeTab?.url?.startsWith('urchin://genoffice-home');
  const isNewTab = !!activeTab?.url?.startsWith('urchin://newtab');
  const isFileViewerTab = !!activeTab?.url?.startsWith('urchin://file-viewer');
  // GenOffice 编辑器标签（阶段 2）：视图由主进程 WebContentsView 覆盖渲染，
  // React 中区留空、底部地址栏隐藏（编辑器自带工具条与保存流程）
  const isGenOfficeTab = activeTab?.viewKind === 'genoffice';
  // 渲染优先级：设置页 > AI 页 > GenOffice 主页 > 主页 > 文件查看器 > 普通网页
  // settings / ai / genoffice-home / newtab / file-viewer 都由 React 组件渲染，
  // BrowserView 让出空间（ZERO_BOUNDS）

  // 内部页面（settings / ai / genoffice-home / newtab / file-viewer / genoffice）
  // 下，导航按钮无意义，禁用
  const isInternalPage =
    isSettingsTab ||
    isAiTab ||
    isMailTab ||
    isGenOfficeHomeTab ||
    isNewTab ||
    isFileViewerTab ||
    isGenOfficeTab;

  // 设置页深链参数（?tab=<key>）：调用方以 key 绑定该值驱动 SettingsPage 初始选项卡
  const settingsInitialTab = (() => {
    if (!isSettingsTab) return undefined;
    try {
      const value = new URL(activeTab?.url ?? '').searchParams.get('tab');
      return value ?? undefined;
    } catch {
      return undefined;
    }
  })();
  // 按住侧边栏空白处拖动窗口（左/右两侧栏共用）
  const windowDrag = useWindowDrag();

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

  return (
    <div
      className="flex h-screen w-screen overflow-hidden bg-surface"
      // 拖放本地文件到窗口：直接按类型在新标签页打开（audio/video/pdf 原生渲染，文本走查看器）
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        const path = (file as File & { path?: string })?.path;
        if (path) handleOpenFilePath(path);
      }}
    >
      {/* === 左侧栏 ===
       *  背景用 bg-titlebar（与窗口标题栏同色令牌）：标题栏是 OS 原生色
       *  （浅色=白 / 暗色=中性深灰），侧栏跟随该令牌后两者间的色差分割线消失，
       *  视觉上一体。border-r 保留：这是"左侧边栏与网页区"之间的分割线
       *  （网页区左上角圆角的夹角边之一）。 */}
      <aside
        className="flex shrink-0 flex-col border-r border-border bg-titlebar transition-[width] duration-150"
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

         {/* 底部：DeepSeek Harness / pi / GenOffice 文档 / 邮箱 / 主页 / 主题切换 / 设置入口
          *（GenOffice 入口打开模块主页：打开文件 / 格式说明 / 原生 AI 设置） */}
          <div className="flex flex-col items-center gap-1 border-t border-border p-2">
           {/* DeepSeek Harness 入口（用户指令：pi 按钮上方新增） */}
           <button
             className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
             onClick={() => void handleOpenDeepSeekHarness()}
             aria-label="DeepSeek Harness"
             title="DeepSeek Harness"
           >
             <img
               src="./dsh-icon.svg"
               alt=""
               draggable={false}
               className="h-5 w-5 rounded object-contain"
             />
           </button>
           {/* pi 入口（与 GenOffice 文档入口互换位置，用户指令） */}
           <button
             className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
             onClick={() => void handleOpenAi()}
             aria-label="AI 助手"
             title="AI 助手"
           >
             {/* pi 模块入口图标（用户指定素材，public/pi-icon.png，白底深蓝 π 方形图标） */}
             <img
               src="./pi-icon.png"
               alt=""
               draggable={false}
               className="h-5 w-5 rounded object-contain"
             />
           </button>
           {/* GenOffice 文档入口（阶段 4.5，用户指令：由「打开文件」按钮改为
            *  嵌入的 GenOffice 前端入口；打开文件动作收敛到主页/Ctrl+O/拖放） */}
           <button
             className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
             onClick={() => void handleOpenGenOfficeHome()}
             aria-label="GenOffice 文档"
             title="GenOffice 文档（Word / PDF / Markdown / HTML）"
           >
             <FileText className="h-4 w-4" />
           </button>
           <button
             className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
             onClick={() => void handleOpenMail()}
             aria-label="邮箱"
             title="邮箱"
           >
             <MailIcon className="h-4 w-4" />
           </button>
           {/* 主页按钮（从地址栏移入，位于邮箱与主题之间，倒数第三） */}
           <button
             className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
             onClick={() => void handleGoHome()}
             aria-label="主页"
             title="主页"
           >
             <Home className="h-4 w-4" />
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
        {/* ContentArea
         *  背景必须用主题令牌 bg-surface 而非硬编码白色：本 div 位于网页
         *  BrowserView 之下，DPI 取整级缝隙会透出此背景——硬编码白在深色
         *  模式下表现为「网页四边白色分割线」（dev.50 修复）。
         *  内部页面（设置/主页/文件查看器）均自带满幅 bg-surface 根，
         *  容器换色不影响其外观。 */}
        <div className="flex-1 overflow-hidden bg-surface">
          {
            isSettingsTab ? (
              /* 设置页：React 组件渲染；key 随 ?tab= 深链变化重挂载以定位选项卡 */
              <SettingsPage
                key={settingsInitialTab ?? 'settings'}
                initialTab={settingsInitialTab}
              />
            ) : isAiTab ? (
              /* AI 页：pi 网页版启动器（阶段 1，docs/pi-web-评估.md）——pi 对话迁移至
               * 独立系统 Node 子进程的 pi-web-ui 网页,本页仅作入口（启动/停止/打开）。
               * 旧对话视图 AiChatView 保留于 @urchin/ai-extension,回退时恢复渲染即可。 */
              <PiWebLauncherView autoStart onOpenUrl={(url) => void handleOpenPiWebUrl(url)} />
            ) : isMailTab ? (
              /* M25 邮箱模块：IMAP 收信 + 邮件阅读（ADR-010）。
               * 引擎在主进程（imapflow），UI 在渲染进程，IPC 走 zod 契约。 */
              <MailView />
            ) : isGenOfficeHomeTab && !isGenOfficeTab ? (
              /* GenOffice 文档主页保底（阶段 4.6）：正常情况下主进程以
               *  GenOffice shell Home 视图承载（viewKind=genoffice，React 留空）；
               *  仅当 shell 产物缺失时回落本 React 页面（浏览器标签） */
              <GenOfficeHome onOpenFile={() => void handleOpenFilePicker()} />
            ) : isNewTab || tabs.length === 0 ? (
              /* 主页：React 组件渲染（内嵌，无法自由更换）。
               * 关闭最后一个标签后 activeTab 为空，此时同样回落到主页 */
              <NewTabPage onNavigate={(url) => void handleNavigate(url)} />
            ) : isFileViewerTab ? (
              /* 本地文件查看器/文件夹浏览器：React 组件渲染（urchin://file-viewer），
               * ?path= 查看文件（媒体/PDF/图片内嵌 + 同类型连续切换），?dir= 浏览文件夹。
               * onNavigate 走 handleNavigate：同标签导航（上/下一个、进入子目录）不堆标签 */
              <FileViewer
                url={activeTab?.url ?? ''}
                onNavigate={(u) => void handleNavigate(u)}
                tabId={activeTabId ?? undefined}
                onToast={showEditorToast}
              />
            ) : null /* 普通网页：由 Electron BrowserView 渲染，React 仅留空 */
          }
        </div>

        {/* 编辑守卫确认弹窗（关闭/切换标签时目标涉及脏编辑会话） */}
        <ConfirmDialog
          open={editorGuardAsk !== null}
          title={editorGuardAsk?.kind === 'close' ? '关闭前保存更改？' : '切换前保存更改？'}
          message="当前文档有未保存的修改。（保存写入原文件；失败可改用查看器右上角「另存为」）"
          onDismiss={() => setEditorGuardAsk(null)}
          actions={[
            {
              label: editorGuardAsk?.kind === 'close' ? '保存并关闭' : '保存并切换',
              variant: 'primary',
              autoFocus: true,
              onClick: () => {
                void (async () => {
                  const s = getEditGuardSession();
                  if (!s || !editorGuardAsk) {
                    setEditorGuardAsk(null);
                    return;
                  }
                  const ok = await s.save();
                  setEditorGuardAsk(null);
                  if (ok) editorGuardAsk.run();
                })();
              },
            },
            {
              label: '不保存',
              variant: 'danger',
              onClick: () => {
                void (async () => {
                  const s = getEditGuardSession();
                  const ask = editorGuardAsk;
                  setEditorGuardAsk(null);
                  if (s && ask) await s.discard();
                  if (ask) ask.run();
                })();
              },
            },
            {
              label: '取消',
              onClick: () => setEditorGuardAsk(null),
            },
          ]}
        />

        {/* 下侧边栏：地址栏 + 导航按钮（被左右侧栏夹住）
         *  AI 标签页隐藏地址栏：AI 模块作为独立全屏对话应用，不需要 URL 导航
         *  GenOffice 编辑器/主页标签同样隐藏：编辑器自带工具条与保存流程，
         *  主页为内部页面，伪地址均无导航意义 */}
        {!isAiTab && !isGenOfficeTab && !isGenOfficeHomeTab && (
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
              onScreenshot={() => void handleScreenshot()}
              screenshotDisabled={!activeTabId}
              onTranslate={() => void handleTranslate()}
              translateActive={translateActive}
              translateDisabled={!activeTab?.url || !/^https?:\/\//i.test(activeTab.url)}
              searchEngine={searchEngine}
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

            {/* 划词翻译结果卡（M24 dev.81）：右键菜单触发，主进程翻译后经事件回传；
                定位用右键菜单同款窗口相对坐标（已含 BrowserView 偏移补偿），防溢出夹边 */}
            {selectionCard && (
              <div
                className="fixed z-50 max-w-md rounded-lg border border-border bg-surface p-3 shadow-dropdown"
                style={{
                  left: Math.max(8, Math.min(selectionCard.x, window.innerWidth - 420)),
                  top: Math.min(selectionCard.y + 12, window.innerHeight - 180),
                }}
              >
                <div className="mb-1.5 flex items-start justify-between gap-3">
                  <div
                    className="min-w-0 flex-1 truncate text-xs text-text-secondary"
                    title={selectionCard.source}
                  >
                    {selectionCard.source}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-text-secondary hover:text-text"
                    onClick={() => setSelectionCard(null)}
                    aria-label="关闭划词翻译"
                  >
                    ✕
                  </button>
                </div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-text">
                  {selectionCard.error ?? selectionCard.result}
                </div>
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
            className="absolute top-0 bottom-12 left-0 z-10 w-1.5 cursor-col-resize"
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
                    data-tab-card
                    draggable={false}
                    onPointerDown={(e) => handleTabPointerDown(e, tab)}
                    onPointerMove={handleTabPointerMove}
                    onPointerUp={handleTabPointerEnd}
                    onPointerCancel={handleTabPointerEnd}
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
                    onDoubleClick={() => void handleCloseTab(tab.id)}
                  >
                    {/* 图标铺满标签高度：36px 与折叠态一致，卡片高度随内容撑开约 52px，
                     *  items-center 垂直居中，object-contain 保持比例不变形 */}
                    <TabFavicon tab={tab} className="h-9 w-9" />
                    <span className="flex-1 truncate">{tab.title || tab.url || '新标签页'}</span>
                    {/* GenOffice 编辑器未保存修改标记（阶段 2） */}
                    {tab.dirty && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        title="有未保存的修改"
                        aria-label="有未保存的修改"
                      />
                    )}
                    <button
                      className="shrink-0 rounded p-0.5 opacity-0 hover:bg-error/10 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleCloseTab(tab.id);
                      }}
                      aria-label="关闭标签"
                    >
                      <X className="h-3 w-3 text-error" />
                    </button>
                  </div>
                ))}
              </div>
              {/* 新建标签：高度与底部地址栏一致（BOTTOM_HEIGHT=48），底边对齐 */}
              <div
                className="flex shrink-0 items-center border-t border-border px-2"
                style={{ height: BOTTOM_HEIGHT }}
              >
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
          <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                draggable={false}
                onPointerDown={(e) => handleTabPointerDown(e, tab)}
                onPointerMove={handleTabPointerMove}
                onPointerUp={handleTabPointerEnd}
                onPointerCancel={handleTabPointerEnd}
                className={cn(
                  // 折叠态图标：方形小圆角（区别于展开态卡片的圆角更大），激活态带主色描边。
                  // 尺寸 40px = 折叠栏宽 44px - 左右各留 2px 边界空隙
                  'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-surface shadow-sm',
                  'border-border/60 before:pointer-events-none before:absolute before:inset-x-1 before:top-0 before:h-px before:rounded-full before:bg-white/70',
                  tab.id === activeTabId
                    ? 'border-primary/50 text-text shadow-[0_2px_6px_-1px_rgba(37,99,235,0.4)]'
                    : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
                )}
                onClick={() => void handleSelectTab(tab.id)}
                onDoubleClick={() => void handleCloseTab(tab.id)}
                aria-label={`切换到标签 ${tab.title || tab.url || '新标签页'}`}
                title={tab.title || tab.url || '新标签页'}
              >
                <TabFavicon tab={tab} className="h-9 w-9" />
                {/* GenOffice 编辑器未保存修改标记（折叠态角标） */}
                {tab.dirty && (
                  <span
                    className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                    aria-label="有未保存的修改"
                  />
                )}
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
