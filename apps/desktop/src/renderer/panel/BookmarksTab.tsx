/**
 * 收藏夹 tab（P2 Session 4：自 bookmark-panel.ts 内联脚本迁移）
 *
 * 目录导航完整语义（对应原 renderBookmarks / jumpToFolder / bindBookmarkRows /
 * startInlineRename / deleteBookmarkNode / bindNewFolder / saveBookmarkTo）：
 * - 面包屑（⌂ 收藏夹 › 文件夹A › …）每级可点击回跳；文件夹行点击下钻；
 * - 行内重命名（书签/文件夹均经 bookmark.update）、删除（文件夹级联删除，经
 *   面板内确认框二次确认——不可用原生 window.confirm：原生对话框会夺走窗口焦点
 *   触发 blur，而面板 blur 即销毁，删除永远执行不到，见 requestDeleteFolder 注释；
 *   删除所在层/祖先时回根目录）、新建文件夹（当前层，Enter 确认/Esc 取消）；
 * - picker 模式（?mode=picker）：底部「保存到当前文件夹/取消」操作条 +
 *   文件夹行「保存到此处」按钮（bookmark.create 后 ui.panel.close 关闭面板）。
 *
 * 状态语义（必须与原实现一致）：
 * - 目录轨迹（folderId/trail）为 ref 保存的面板级状态：跨 tab 切换保留
 *   （原 IIFE 模块变量），每次数据刷新时按最新列表修剪失效段并刷新标题；
 * - 每次切入本 tab / 每次变更动作后重新拉取 bookmark.list 全量渲染
 *   （原 renderBookmarks 的重拉语义，保持外部变更可见）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Bookmark, BookmarkListRes, UiPanelGetPickerContextRes } from '@urchin/ipc-contract';
import { invoke, openUrlInActiveTab } from './panel-ipc';
import { FaviconSlot, InlineRenameInput } from './common';

/** 面包屑轨迹段（原 bmTrail 元素：{ id, title }） */
interface BmTrailSeg {
  id: string;
  title: string;
}

/** 待存页面上下文（picker 模式经 ui.panel.getPickerContext 拉取） */
type PickerContext = UiPanelGetPickerContextRes;

/** 一次刷新得到的渲染快照（原 renderBookmarks 组装的 HTML 等价物） */
interface BookmarksView {
  /** 修剪后的面包屑轨迹（从根到当前） */
  trail: BmTrailSeg[];
  /** 当前层子项（文件夹在前，其余按 position） */
  children: Bookmark[];
  /** 全量列表（文件夹行的子项计数用） */
  all: Bookmark[];
  /** 是否处于根级（空态文案区分「暂无书签/此文件夹为空」） */
  atRoot: boolean;
  /** picker 底栏目标标签（当前文件夹名 / 根目录） */
  pickerLabel: string;
}

const ICONS = {
  bookmark: '⭐',
  folder: '📁',
  site: '🌐',
} as const;

export function BookmarksTab({ active, pickerMode }: { active: boolean; pickerMode: boolean }) {
  /** 渲染快照（null = 加载中） */
  const [view, setView] = useState<BookmarksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [pickerContext, setPickerContext] = useState<PickerContext | null>(null);
  /** 待删除的文件夹（面板内确认框状态；null = 未在确认中） */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  // 目录轨迹：面板级状态（跨 tab 切换保留），以 ref 为真源（导航与异步刷新
  // 共享同一份，避免闭包过期态）；快照经 view 下发渲染。
  const folderIdRef = useRef<string | null>(null);
  const trailRef = useRef<BmTrailSeg[]>([]);
  /** picker 上下文只拉取一次的守卫（原 `if (pickerMode && !pickerContext)` 语义） */
  const pickerCtxFetchedRef = useRef(false);

  /**
   * 拉取全量书签并计算当前层渲染快照。
   * 对应原 renderBookmarks：修剪轨迹失效段（外部可能已重命名/删除）、
   * 当前文件夹被删时回根、文件夹在前排序、picker 目标标签。
   */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await invoke<BookmarkListRes>('bookmark.list', {});
      const all = res.bookmarks ?? [];

      // 面包屑标题刷新（外部可能已重命名/删除层级节点）
      let trail = trailRef.current.filter((seg) => all.some((b) => b.id === seg.id));
      trail = trail.map((seg) => {
        const node = all.find((b) => b.id === seg.id);
        return node?.title ? { ...seg, title: node.title } : seg;
      });
      let folderId = folderIdRef.current;
      if (folderId != null && !all.some((b) => b.id === folderId && b.type === 'folder')) {
        folderId = null;
        trail = [];
      }
      trailRef.current = trail;
      folderIdRef.current = folderId;

      const children = all
        .filter((b) => (b.parentId ?? null) === folderId)
        .sort((a, b) =>
          a.type === b.type ? a.position - b.position : a.type === 'folder' ? -1 : 1,
        );

      const curLabel =
        trail.length > 0 ? (trail[trail.length - 1]?.title ?? '当前文件夹') : '根目录';

      setError(null);
      setView({ trail, children, all, atRoot: folderId == null, pickerLabel: curLabel });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** 面包屑跳转：目标为 null 回根级；否则按轨迹截断或补占位段（原 jumpToFolder） */
  const jumpToFolder = useCallback(
    (id: string | null): void => {
      if (id == null) {
        folderIdRef.current = null;
        trailRef.current = [];
      } else {
        const idx = trailRef.current.findIndex((seg) => seg.id === id);
        if (idx >= 0) {
          trailRef.current = trailRef.current.slice(0, idx + 1);
        }
        // 轨迹中不存在的 id（不应发生，防御式）：补一个标题占位段
        if (!trailRef.current.some((seg) => seg.id === id)) {
          trailRef.current = [...trailRef.current, { id, title: '未命名文件夹' }];
        }
        folderIdRef.current = id;
      }
      void refresh();
    },
    [refresh],
  );

  /** 进入下级文件夹（原 bindBookmarkRows 的 folder-item 点击：轨迹追加后渲染） */
  const enterFolder = useCallback(
    (folder: Bookmark): void => {
      folderIdRef.current = folder.id;
      trailRef.current = [
        ...trailRef.current,
        { id: folder.id, title: folder.title || '未命名文件夹' },
      ];
      void refresh();
    },
    [refresh],
  );

  /** 星标取消收藏（删除失败保持现状，原 .star 点击逻辑） */
  const unstar = useCallback(
    async (id: string): Promise<void> => {
      try {
        await invoke('bookmark.delete', { id });
        await refresh();
      } catch {
        /* 忽略：删除失败保持现状 */
      }
    },
    [refresh],
  );

  /** 内联重命名提交（原 startInlineRename 的 finish：Esc 或空值/未变更仅重渲染） */
  const commitRename = useCallback(
    (id: string, save: boolean, next: string, original: string): void => {
      setRenamingId(null);
      if (save && next && next !== original) {
        invoke('bookmark.update', { id, title: next })
          .then(() => refresh())
          .catch(() => refresh());
      } else {
        void refresh();
      }
    },
    [refresh],
  );

  /**
   * 请求删除文件夹：弹面板内确认框二次确认。
   *
   * 为什么不用原生 window.confirm（2026-11-06 用户报告「文件夹无法删除」根因）：
   * 面板是「blur 即销毁」的独立子窗口（bookmark-panel.ts blur → close），原生确认
   * 对话框弹出时夺走窗口焦点触发 blur → 面板 destroy → 渲染进程死亡，bookmark.delete
   * 永远发不出去——书签行走星标（无 confirm）所以能删，文件夹行只有删除走 confirm
   * 所以不能删（E2E bookmark-folder-delete.spec.ts 复现实锤：对话框文案可见 + 紧随
   * page closed）。改用面板内 React 确认框：无焦点切换、无 blur。
   * 行内 ✕ 仅出现在文件夹行（书签行走星标取消收藏），故此处只处理文件夹。
   */
  const requestDeleteFolder = useCallback((folder: Bookmark): void => {
    setPendingDelete({ id: folder.id, title: folder.title || '未命名文件夹' });
  }, []);

  /** 确认删除执行：级联删除 + 所在层/祖先被删时回根目录（原 deleteBookmarkNode 后半段） */
  const confirmDeleteNode = useCallback(async (): Promise<void> => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      await invoke('bookmark.delete', { id: target.id });
      if (
        folderIdRef.current === target.id ||
        trailRef.current.some((seg) => seg.id === target.id)
      ) {
        jumpToFolder(null);
      } else {
        await refresh();
      }
    } catch {
      /* 忽略：删除失败保持现状 */
    }
  }, [pendingDelete, jumpToFolder, refresh]);

  // 确认框打开时 Esc 取消（对齐原生 confirm 的 Esc 语义）
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPendingDelete(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete]);

  // 切离收藏夹 tab 时取消未完成的确认（原 confirm 阻塞语义下不可能切 tab；非阻塞后须显式取消）
  useEffect(() => {
    if (!active) setPendingDelete(null);
  }, [active]);

  /** 新建文件夹提交（原 bindNewFolder 的 finish：空值仅重渲染） */
  const commitNewFolder = useCallback(
    (save: boolean, name: string): void => {
      setCreatingFolder(false);
      if (save && name) {
        invoke('bookmark.create', {
          title: name,
          parentId: folderIdRef.current ?? null,
          type: 'folder',
        })
          .then(() => refresh())
          .catch(() => refresh());
      } else {
        void refresh();
      }
    },
    [refresh],
  );

  /**
   * 保存当前页面到指定文件夹（picker 模式核心动作，原 saveBookmarkTo）。
   * parentId 为 null 时存根级；保存成功后关闭面板（主进程广播 bookmark:changed
   * → 主窗口星标亮起）。保存失败保持面板开启，用户可重试或取消。
   */
  const saveBookmarkTo = useCallback(
    async (parentId: string | null): Promise<void> => {
      if (!pickerContext?.url) {
        // 上下文缺失（不应发生）：直接关闭
        try {
          await invoke('ui.panel.close', {});
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        await invoke('bookmark.create', {
          url: pickerContext.url,
          title: pickerContext.title ?? pickerContext.url,
          parentId: parentId ?? null,
          type: 'bookmark',
        });
        await invoke('ui.panel.close', {});
      } catch {
        /* 保存失败：保持面板开启 */
      }
    },
    [pickerContext],
  );

  // 数据加载：切入本 tab 时拉取（原 loadTab 每次调用 renderBookmarks）；
  // picker 模式首次加载拉取待存页面上下文（原 `pickerMode && !pickerContext` 分支）。
  useEffect(() => {
    if (!active) return;
    void (async () => {
      if (pickerMode && !pickerCtxFetchedRef.current) {
        pickerCtxFetchedRef.current = true;
        try {
          const ctx = await invoke<UiPanelGetPickerContextRes>('ui.panel.getPickerContext', {});
          // 原 guard：(ctx && typeof ctx === 'object') ? ctx : null
          setPickerContext(ctx && typeof ctx === 'object' ? ctx : null);
        } catch {
          setPickerContext(null);
        }
      }
      await refresh();
    })();
  }, [active, pickerMode, refresh]);

  // ── 渲染 ──

  if (error) {
    return <div className="empty">加载失败：{error}</div>;
  }
  if (!view) {
    return <div className="empty">加载中…</div>;
  }

  const { trail, children, all, atRoot, pickerLabel } = view;

  /** 行内操作守卫（原 e.target.closest 判断的 React 等价） */
  const fromAction = (e: React.MouseEvent, selector: string): boolean =>
    (e.target as HTMLElement).closest(selector) !== null;

  const folderCount = (id: string): number => all.filter((x) => x.parentId === id).length;

  return (
    <>
      <div className="bm-toolbar">
        <div className="breadcrumb" id="bm-breadcrumb">
          <span className="crumb" data-id="" onClick={() => jumpToFolder(null)}>
            ⌂ 收藏夹
          </span>
          {trail.map((seg) => (
            <Fragment key={seg.id}>
              <span className="crumb-sep">›</span>
              <span className="crumb" data-id={seg.id} onClick={() => jumpToFolder(seg.id)}>
                {seg.title || '未命名文件夹'}
              </span>
            </Fragment>
          ))}
        </div>
        <button
          className="new-folder-btn"
          id="bm-new-folder"
          title="新建文件夹"
          onClick={(e) => {
            e.stopPropagation();
            setCreatingFolder(true);
          }}
        >
          ＋ 文件夹
        </button>
        {creatingFolder && (
          <InlineRenameInput
            initial=""
            placeholder="文件夹名称"
            className="rename-input new-folder-input"
            onFinish={commitNewFolder}
          />
        )}
      </div>

      {children.length === 0 ? (
        <div className="empty">{atRoot ? '暂无书签' : '此文件夹为空'}</div>
      ) : (
        children.map((b) => {
          if (b.type === 'folder') {
            return (
              <div
                key={b.id}
                className="item folder-item"
                data-folder={b.id}
                onClick={(e) => {
                  if (fromAction(e, '.row-act, .rename-input')) return;
                  enterFolder(b);
                }}
              >
                <span className="icon">{ICONS.folder}</span>
                <div className="main">
                  {renamingId === b.id ? (
                    <InlineRenameInput
                      initial={b.title || '未命名文件夹'}
                      className="rename-input"
                      onFinish={(save, value) =>
                        commitRename(b.id, save, value, b.title || '未命名文件夹')
                      }
                    />
                  ) : (
                    <div className="title">{b.title || '未命名文件夹'}</div>
                  )}
                  <div className="url">{folderCount(b.id)} 项</div>
                </div>
                <div className="row-actions">
                  {pickerMode && (
                    <button
                      className="row-act"
                      data-act="save-into"
                      data-id={b.id}
                      title="保存到此处"
                      onClick={(e) => {
                        e.stopPropagation();
                        void saveBookmarkTo(b.id);
                      }}
                    >
                      📥
                    </button>
                  )}
                  <button
                    className="row-act"
                    data-act="rename"
                    data-id={b.id}
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(b.id);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="row-act"
                    data-act="delete"
                    data-id={b.id}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDeleteFolder(b);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div
              key={b.id}
              className="item"
              data-url={b.url ?? ''}
              onClick={(e) => {
                // 原 guard：.row-act/.star/.rename-input 上的点击不打开 URL
                if (fromAction(e, '.row-act, .star, .rename-input')) return;
                if (!b.url) return;
                void openUrlInActiveTab(b.url);
              }}
            >
              <FaviconSlot src={b.favicon} fallback={ICONS.site} />
              <span
                className="icon star"
                data-id={b.id}
                title="取消收藏"
                onClick={(e) => {
                  e.stopPropagation();
                  void unstar(b.id);
                }}
              >
                {ICONS.bookmark}
              </span>
              <div className="main">
                {renamingId === b.id ? (
                  <InlineRenameInput
                    initial={b.title || (b.url ?? '')}
                    className="rename-input"
                    onFinish={(save, value) =>
                      commitRename(b.id, save, value, b.title || (b.url ?? ''))
                    }
                  />
                ) : (
                  <div className="title">{b.title || (b.url ?? '')}</div>
                )}
                <div className="url">{b.url ?? ''}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-act"
                  data-act="rename"
                  data-id={b.id}
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(b.id);
                  }}
                >
                  ✎
                </button>
              </div>
            </div>
          );
        })
      )}

      {pickerMode && (
        <div className="picker-footer">
          <span className="picker-target">保存到：{pickerLabel}</span>
          <button
            className="picker-save"
            data-act="save-here"
            onClick={(e) => {
              e.stopPropagation();
              void saveBookmarkTo(folderIdRef.current);
            }}
          >
            保存
          </button>
          <button
            className="picker-cancel"
            data-act="picker-cancel"
            onClick={(e) => {
              e.stopPropagation();
              invoke('ui.panel.close', {}).catch(() => {
                /* ignore */
              });
            }}
          >
            取消
          </button>
        </div>
      )}

      {/* 文件夹删除确认框（面板内实现，替代原生 window.confirm——见 requestDeleteFolder 注释） */}
      {pendingDelete && (
        <div
          className="confirm-overlay"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="confirm-dialog" role="alertdialog" aria-label="删除确认">
            <div className="confirm-text">删除文件夹「{pendingDelete.title}」及其全部内容？</div>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button className="confirm-ok" onClick={() => void confirmDeleteNode()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
