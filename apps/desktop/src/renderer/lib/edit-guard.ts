/**
 * 编辑离开守卫注册表（edit-guard）
 *
 * 背景：FileViewer 只在「激活标签为 file-viewer」时挂载，切换标签即卸载；
 * 而关闭/切换标签的全部入口都在渲染层（App.tsx handleCloseTab/handleSelectTab，
 * 拖出仅限 http/https 标签不涉及查看器），因此脏状态守卫做在渲染层：
 * 编辑会话（use-edit-session）在编辑期间把「保存/放弃」能力注册到这里，
 * App 在执行关闭/切换前查询并弹三键确认。
 * 同一时刻最多一个查看器挂载 → 单会话槽位（按 tabId 校验归属）。
 * 窗口整体关闭由 App 的 beforeunload 兜底（Electron 弹原生确认）。
 */
export interface EditGuardSession {
  /** 编辑会话所属标签。 */
  readonly tabId: number;
  isDirty: () => boolean;
  /** 覆盖原文件保存。resolve true = 已保存（失败由会话 toast 提示）。 */
  save: () => Promise<boolean>;
  /** 放弃更改（清理草稿、还原内容）。 */
  discard: () => Promise<void>;
}

let active: EditGuardSession | null = null;

/** 注册/清除当前编辑会话（脏状态守卫用）。 */
export function setEditGuardSession(session: EditGuardSession | null): void {
  active = session;
}

export function getEditGuardSession(): EditGuardSession | null {
  return active;
}

/** 关闭 tabId 前是否需要守卫（该标签正处于脏编辑会话）。 */
export function closeNeedsGuard(tabId: number): boolean {
  return active !== null && active.tabId === tabId && active.isDirty();
}

/** 切换到 targetTabId 前是否需要守卫（将离开脏编辑会话所在标签）。 */
export function switchNeedsGuard(targetTabId: number): boolean {
  return active !== null && active.tabId !== targetTabId && active.isDirty();
}
