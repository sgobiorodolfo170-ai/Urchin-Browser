/** 标签快照类型（与主进程 TabSnapshot 对齐） */
export interface TabSnapshot {
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
  /** 所属工作区（TP7）：决定 session 分区；缺失时按 'default' 处理 */
  readonly workspaceId?: string;
}

/** 主进程 tab:event 推送载荷 */
export interface TabEventPayload {
  readonly type: 'created' | 'updated' | 'removed' | 'activated' | 'crashed';
  readonly snapshot: TabSnapshot;
}
