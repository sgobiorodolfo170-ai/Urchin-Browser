/**
 * 左侧边栏
 *
 * 结构：顶部折叠/展开按钮 → 中转区（TransitPanel）→ 底部功能入口
 * （DeepSeek Harness / pi / 笔记 / GenOffice / 邮箱 / 主页 / 主题 / 设置）。
 *
 * 尺寸与悬停展开状态由 App 持有（leftWidth 同时驱动主进程 BrowserView bounds），
 * 本组件只消费状态并通过回调上抛动作，避免布局真源分裂。
 */
import {
  Moon,
  Sun,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Home,
  FileText,
  Mail as MailIcon,
  PenLine,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useTheme } from '../theme/theme-provider';
import { useWindowDrag } from '../lib/use-window-drag';
import { TransitPanel } from '../transit/TransitPanel';

export type PiServiceState = 'stopped' | 'starting' | 'running' | 'error';

export interface LeftSidebarProps {
  readonly expanded: boolean;
  readonly hovered: boolean;
  readonly retracting: boolean;
  readonly width: number;
  readonly asideRef: React.RefObject<HTMLElement>;
  readonly piServiceState: PiServiceState;
  readonly onToggle: () => void;
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onDoubleClick: (e: React.MouseEvent) => void;
  readonly onOpenDeepSeekHarness: () => void;
  readonly onOpenPi: () => void;
  readonly onOpenNotebook: () => void;
  readonly onOpenGenOfficeHome: () => void;
  readonly onOpenMail: () => void;
  readonly onGoHome: () => void;
  readonly onOpenSettings: () => void;
}

export function LeftSidebar({
  expanded,
  hovered,
  retracting,
  width,
  asideRef,
  piServiceState,
  onToggle,
  onMouseEnter,
  onMouseLeave,
  onDoubleClick,
  onOpenDeepSeekHarness,
  onOpenPi,
  onOpenNotebook,
  onOpenGenOfficeHome,
  onOpenMail,
  onGoHome,
  onOpenSettings,
}: LeftSidebarProps): React.JSX.Element {
  // 注意：toggleTheme 以 context 对象方法形式调用（不解构），避免 @typescript-eslint/unbound-method
  const themeContext = useTheme();
  const { theme } = themeContext;
  const windowDrag = useWindowDrag();

  return (
    /* === 左侧栏 ===
     *  背景透明，透出窗口级统一渐变（顶部与 OS 原生标题栏同色）；
     *  border-r 保留：这是"左侧边栏与网页区"之间的分割线
     *  （网页区左上角圆角的夹角边之一）。 */
    <aside
      ref={asideRef}
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-transparent',
        retracting
          ? 'transition-[width] duration-300 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]'
          : 'transition-[width] duration-150 ease-out',
      )}
      style={{ width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onDoubleClick={onDoubleClick}
      onPointerDown={windowDrag.startDrag}
      onPointerMove={windowDrag.moveDrag}
      onPointerUp={windowDrag.endDrag}
      onPointerCancel={windowDrag.endDrag}
      aria-label="左侧边栏"
    >
      {/* 顶部：折叠/展开按钮 */}
      <button
        className="flex h-11 w-full items-center justify-center text-text-secondary hover:bg-surface-secondary hover:text-text"
        onClick={onToggle}
        aria-label={expanded ? '折叠左侧栏' : '展开左侧栏'}
      >
        {expanded ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
      </button>

      {/* 中转区：折叠按钮下方、功能区上方。展开态列表 / 折叠态迷你图标 */}
      <TransitPanel expanded={expanded || hovered} />

      {/* 底部：DeepSeek Harness / pi / GenOffice 文档 / 邮箱 / 主页 / 主题切换 / 设置入口
       *（GenOffice 入口打开模块主页：打开文件 / 格式说明 / 原生 AI 设置） */}
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-border p-2">
        {/* DeepSeek Harness 入口（用户指令：pi 按钮上方新增） */}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenDeepSeekHarness}
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
        {/* pi 入口（ADR-014：点击确保服务运行并直接打开 pi 聊天页；服务常驻） */}
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenPi}
          aria-label="pi"
          title={
            piServiceState === 'running'
              ? 'pi（运行中）'
              : piServiceState === 'starting'
                ? 'pi（启动中…）'
                : piServiceState === 'error'
                  ? 'pi（故障）'
                  : 'pi（未启动）'
          }
        >
          {/* pi 模块入口图标（用户指定素材，public/pi-icon.png，白底深蓝 π 方形图标） */}
          <img
            src="./pi-icon.png"
            alt=""
            draggable={false}
            className="h-5 w-5 rounded object-contain"
          />
          {/* ADR-014 状态灯：运行绿/启动黄/故障红/未启动熄灭 */}
          <span
            className={cn(
              'absolute right-1 top-1 h-2 w-2 rounded-full border border-surface',
              piServiceState === 'running'
                ? 'bg-green-500'
                : piServiceState === 'starting'
                  ? 'bg-amber-500'
                  : piServiceState === 'error'
                    ? 'bg-red-500'
                    : 'bg-transparent',
            )}
            aria-hidden
          />
        </button>
        {/* 笔记 / 便利贴入口（M27）：位于 pi 与 GenOffice 之间，
         *  打开 urchin://notebook 内部页（三区：导航 / 笔记任务 / 无限画布） */}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenNotebook}
          aria-label="笔记"
          title="笔记 / 便利贴"
        >
          <PenLine className="h-4 w-4" />
        </button>
        {/* GenOffice 文档入口（阶段 4.5，用户指令：由「打开文件」按钮改为
         *  嵌入的 GenOffice 前端入口；打开文件动作收敛到主页/Ctrl+O/拖放） */}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenGenOfficeHome}
          aria-label="GenOffice 文档"
          title="GenOffice 文档（Word / PDF / Markdown / HTML）"
        >
          <FileText className="h-4 w-4" />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenMail}
          aria-label="邮箱"
          title="邮箱"
        >
          <MailIcon className="h-4 w-4" />
        </button>
        {/* 主页按钮（从地址栏移入，位于邮箱与主题之间，倒数第三） */}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onGoHome}
          aria-label="主页"
          title="主页"
        >
          <Home className="h-4 w-4" />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={() => themeContext.toggleTheme()}
          aria-label="切换主题"
          title="切换主题"
        >
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
