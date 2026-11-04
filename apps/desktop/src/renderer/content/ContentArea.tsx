/**
 * 中间列内容区（ContentArea）
 *
 * 结构：内容区（Ctrl+滚轮缩放容器 + 内部页分支：设置/邮箱/笔记/GenOffice 主页/
 * 主页/工作区总览页/文件查看器；普通网页由主进程 BrowserView 渲染、React 留空）
 * + 编辑守卫三键确认弹窗 + 划词翻译结果卡。
 *
 * 与侧栏同一展示组件模式：标签/工作区/编辑守卫的真源都在 App（标签生命周期被
 * 侧栏列表、右键菜单、tab:event 弹回守卫多处消费，收拢在 App 避免真源分裂），
 * 本组件只消费状态并通过回调上抛动作。（refactor-plan-p2 §2.3 步骤 4，
 * 代码自 App.tsx 原样迁出）
 */
import { useEffect, useRef, useState } from 'react';
import { MailView } from '../mail/MailView';
import { NotebookView } from '../notebook/NotebookView';
import { SettingsPage } from '../settings/SettingsPage';
import { NewTabPage } from '../home/NewTabPage';
import { GenOfficeHome } from '../home/GenOfficeHome';
import { FileViewer } from '../files/FileViewer';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { getEditGuardSession, type EditorGuardAsk } from '../lib/edit-guard';
import {
  WorkspaceOverviewPage,
  type WorkspaceOverviewItem,
} from '../workspaces/WorkspaceOverviewPage';
import type { TabSnapshot } from '../tabs/types';
import type { WorkspaceColor } from '../workspaces/types';
import { CONTENT_ZOOM_MAX, CONTENT_ZOOM_MIN, CONTENT_ZOOM_STEP } from '../lib/layout-constants';

export interface ContentAreaProps {
  /** 内容区 DOM 引用：App 持有真源（整窗快照采集需取 BrowserView 对应矩形） */
  readonly contentAreaRef: React.RefObject<HTMLDivElement>;
  readonly activeTab: TabSnapshot | null;
  readonly activeTabId: number | null;
  /** 标签总数：关闭最后一个标签后与 urchin://newtab 一并回落主页 */
  readonly tabCount: number;
  /** 同标签导航（主页 / 文件查看器上/下一个、进入子目录） */
  readonly onNavigate: (url: string) => void;
  /** 打开本地文件选择器（GenOffice 主页保底页入口） */
  readonly onOpenFilePicker: () => void;
  /** 文件查看器轻提示（保存失败等） */
  readonly onFileViewerToast: (msg: string) => void;
  /** 工作区总览页卡片数据（App 由 workspaces + 整窗快照 useMemo 组装） */
  readonly workspaceOverviewItems: readonly WorkspaceOverviewItem[];
  readonly currentWorkspaceId: string;
  /** 总览页点卡：切换工作区并关闭总览页（顺序约束见 App 实现） */
  readonly onOverviewSwitch: (workspaceId: string) => void;
  /** 总览页新建工作区：创建后切换并关闭总览页 */
  readonly onOverviewCreate: (name: string, color: WorkspaceColor) => Promise<void>;
  /** 编辑守卫三键确认请求（状态与触发在 App：关闭/切换入口 + tab:event 弹回） */
  readonly guardAsk: EditorGuardAsk | null;
  /** 取消守卫确认（取消按钮 / Esc / 遮罩点击共用） */
  readonly onGuardDismiss: () => void;
}

export function ContentArea({
  contentAreaRef,
  activeTab,
  activeTabId,
  tabCount,
  onNavigate,
  onOpenFilePicker,
  onFileViewerToast,
  workspaceOverviewItems,
  currentWorkspaceId,
  onOverviewSwitch,
  onOverviewCreate,
  guardAsk,
  onGuardDismiss,
}: ContentAreaProps) {
  // 活跃 tab id 镜像 ref：划词结果卡订阅保持稳定引用，回调内读取最新值（与 App 同模式）
  const activeTabIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  /** 笔记页不参与内容区 Ctrl+滚轮缩放（画布有自己的滚轮缩放），用 ref 在 wheel 闭包里读取。 */
  const isNotebookTabRef = useRef(false);

  /** 中区内部页缩放倍率（Ctrl+滚轮；网页标签由主进程单独缩放 BrowserView）。 */
  const [contentZoom, setContentZoom] = useState(1);

  // Ctrl+滚轮仅缩放中区内部页（设置/主页/邮箱等 React 页面）。
  // 侧边栏与地址栏尺寸保持固定；网页标签的缩放由主进程注入脚本作用于 BrowserView，
  // 不会经过这里，因此也不会带动浏览器 chrome 缩放。
  useEffect(() => {
    const el = contentAreaRef.current;
    if (!el) return undefined;
    const handleWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return;
      // 笔记页画布自行处理滚轮缩放，且页面整体不应被 Ctrl+滚轮缩放
      if (isNotebookTabRef.current) return;
      e.preventDefault();
      setContentZoom((prev) => {
        const raw = e.deltaY < 0 ? prev * CONTENT_ZOOM_STEP : prev / CONTENT_ZOOM_STEP;
        return Math.min(CONTENT_ZOOM_MAX, Math.max(CONTENT_ZOOM_MIN, Math.round(raw * 100) / 100));
      });
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [contentAreaRef]);

  /** 划词翻译结果卡（右键菜单 → 主进程翻译 → translate:selection-result 事件回传；坐标为窗口相对坐标） */
  const [selectionCard, setSelectionCard] = useState<{
    x: number;
    y: number;
    source: string;
    result?: string;
    error?: string;
  } | null>(null);

  // 划词翻译结果卡事件订阅（只响应活跃 tab，避免后台 tab 噪音；
  // 翻译进度事件订阅在 App——进度 toast / 翻译激活态由 App 单一真源持有）
  useEffect(() => {
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
      offSelection();
    };
  }, []);

  // 中区内容判断
  // 注意：urchin://settings 会被 Electron URL 规范化为带末尾斜杠，
  // 所以用 startsWith 判断而非严格相等，避免匹配失败导致组件不渲染。
  const isSettingsTab = !!activeTab?.url?.startsWith('urchin://settings');
  const isMailTab = !!activeTab?.url?.startsWith('urchin://mail');
  const isNotebookTab = !!activeTab?.url?.startsWith('urchin://notebook');
  isNotebookTabRef.current = isNotebookTab;
  const isGenOfficeHomeTab = !!activeTab?.url?.startsWith('urchin://genoffice-home');
  const isNewTab = !!activeTab?.url?.startsWith('urchin://newtab');
  const isWorkspacesTab = !!activeTab?.url?.startsWith('urchin://workspaces');
  const isFileViewerTab = !!activeTab?.url?.startsWith('urchin://file-viewer');
  // GenOffice 编辑器标签（阶段 2）：视图由主进程 WebContentsView 覆盖渲染，
  // React 中区留空、底部地址栏隐藏（编辑器自带工具条与保存流程）
  const isGenOfficeTab = activeTab?.viewKind === 'genoffice';

  // 进入笔记页时重置内容区缩放：笔记页不参与 Ctrl+滚轮缩放，避免残留倍率导致三区不铺满。
  useEffect(() => {
    if (isNotebookTab) setContentZoom(1);
  }, [isNotebookTab]);

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

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* ContentArea
       *  背景透明：透出窗口级统一渐变。本 div 位于网页 BrowserView 之下，
       *  DPI 取整级缝隙处会透出此层，因此不能再使用独立 surface 色块；
       *  内部页面（设置/主页/文件查看器）自带满幅背景，不受影响。 */}
      <div ref={contentAreaRef} className="flex-1 overflow-hidden bg-transparent">
        {/* 中区内部页缩放容器（Ctrl+滚轮）：仅缩放内容，侧栏/地址栏尺寸固定 */}
        <div
          className="h-full w-full"
          style={
            contentZoom === 1
              ? undefined
              : {
                  width: `${100 / contentZoom}%`,
                  height: `${100 / contentZoom}%`,
                  transform: `scale(${contentZoom})`,
                  transformOrigin: 'top left',
                }
          }
        >
          {
            isSettingsTab ? (
              /* 设置页：React 组件渲染；key 随 ?tab= 深链变化重挂载以定位选项卡 */
              <SettingsPage
                key={settingsInitialTab ?? 'settings'}
                initialTab={settingsInitialTab}
              />
            ) : isMailTab ? (
              /* M25 邮箱模块：IMAP 收信 + 邮件阅读（ADR-010）。
               * 引擎在主进程（imapflow），UI 在渲染进程，IPC 走 zod 契约。 */
              <MailView />
            ) : isNotebookTab ? (
              /* M27 笔记 / 便利贴：三区（导航 / 笔记任务 / 无限画布）。
               * 状态持久化到 settings 键 notebook.state。 */
              <NotebookView />
            ) : isGenOfficeHomeTab && !isGenOfficeTab ? (
              /* GenOffice 文档主页保底（阶段 4.6）：正常情况下主进程以
               *  GenOffice shell Home 视图承载（viewKind=genoffice，React 留空）；
               *  仅当 shell 产物缺失时回落本 React 页面（浏览器标签） */
              <GenOfficeHome onOpenFile={onOpenFilePicker} />
            ) : isNewTab || tabCount === 0 ? (
              /* 主页：React 组件渲染（内嵌，无法自由更换）。
               * 关闭最后一个标签后 activeTab 为空，此时同样回落到主页 */
              <NewTabPage onNavigate={onNavigate} />
            ) : isWorkspacesTab ? (
              /* 工作区总览页（urchin://workspaces，参考 ego-lite Space 卡片设计）：
               * 卡片网格展示全部工作区 + 各工作区网页缩略图；点卡切换并关闭本页
               * 注：即使目标 == 当前工作区（例如总览页本身归属当前工作区），
               * 也需主动激活其最近激活标签，避免关闭总览页后主进程回落到任意 tab */
              <WorkspaceOverviewPage
                items={workspaceOverviewItems}
                currentWorkspaceId={currentWorkspaceId}
                onSwitch={onOverviewSwitch}
                onCreate={onOverviewCreate}
              />
            ) : isFileViewerTab ? (
              /* 本地文件查看器/文件夹浏览器：React 组件渲染（urchin://file-viewer），
               * ?path= 查看文件（媒体/PDF/图片内嵌 + 同类型连续切换），?dir= 浏览文件夹。
               * onNavigate 上抛 App 同标签导航（上/下一个、进入子目录）不堆标签 */
              <FileViewer
                url={activeTab?.url ?? ''}
                onNavigate={onNavigate}
                tabId={activeTabId ?? undefined}
                onToast={onFileViewerToast}
              />
            ) : null /* 普通网页：由 Electron BrowserView 渲染，React 仅留空 */
          }
        </div>
      </div>

      {/* 编辑守卫确认弹窗（关闭/切换标签时目标涉及脏编辑会话） */}
      <ConfirmDialog
        open={guardAsk !== null}
        title={guardAsk?.kind === 'close' ? '关闭前保存更改？' : '切换前保存更改？'}
        message="当前文档有未保存的修改。（保存写入原文件；失败可改用查看器右上角「另存为」）"
        onDismiss={onGuardDismiss}
        actions={[
          {
            label: guardAsk?.kind === 'close' ? '保存并关闭' : '保存并切换',
            variant: 'primary',
            autoFocus: true,
            onClick: () => {
              void (async () => {
                const s = getEditGuardSession();
                if (!s || !guardAsk) {
                  onGuardDismiss();
                  return;
                }
                const ok = await s.save();
                onGuardDismiss();
                if (ok) guardAsk.run();
              })();
            },
          },
          {
            label: '不保存',
            variant: 'danger',
            onClick: () => {
              void (async () => {
                const s = getEditGuardSession();
                const ask = guardAsk;
                onGuardDismiss();
                if (s && ask) await s.discard();
                if (ask) ask.run();
              })();
            },
          },
          {
            label: '取消',
            onClick: onGuardDismiss,
          },
        ]}
      />

      {/* 划词翻译结果卡（M24 dev.81）：右键菜单触发，主进程翻译后经事件回传。
       * 定位用右键菜单同款窗口相对坐标（已含 BrowserView 偏移补偿），防溢出夹边。
       * 注意：BrowserView 在网页标签时覆盖主窗口 React，此卡仅在落入底部状态栏区域或
       * 内部 React 页面时可见；网页中部命中时层级受限是既有行为，本次不改变。 */}
      {!isGenOfficeTab && !isGenOfficeHomeTab && selectionCard && (
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
    </main>
  );
}
