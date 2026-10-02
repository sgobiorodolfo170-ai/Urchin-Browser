/**
 * DeepSeek Harness · 标签关闭→停止后端绑定
 *
 * 与 piWeb 不同（piWeb 的启动器标签保持打开作控制面板，关网页标签不停后端），
 * dsh 要求「web 前端关闭后，deepseek-harness 项目关闭」。
 *
 * 实现：在 tabManager 'removed' 事件上挂监听，被关标签的 URL 匹配当前 dsh
 * 服务地址（http://127.0.0.1:<port> 前缀）时调 launcher.stop()。
 *
 * 参照 genoffice/integration.ts:108 的 tabManager.on('removed') 模式。
 */

/** Tab 快照最小接口（与 TabManager 的 TabSnapshot 对齐） */
export interface TabSnapshotLike {
  readonly id: number;
  readonly url: string;
  readonly active: boolean;
}

/** TabManager 最小接口（仅需 on + off，与 TabManager 结构兼容） */
export interface TabManagerLike {
  on(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown;
  off(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown;
}

/** Launcher 最小接口（仅需 status + stop） */
export interface DshLauncherLike {
  status(): { state: string; url?: string };
  stop(): Promise<void>;
}

/**
 * 绑定标签关闭→停止。
 *
 * @returns unbind 函数（供 app 退出时清理监听）
 */
export function bindTabCloseToStop(
  tabManager: TabManagerLike,
  launcher: DshLauncherLike,
): () => void {
  const onRemoved = (snapshot: TabSnapshotLike): void => {
    const status = launcher.status();
    if (status.state !== 'running' || !status.url) return;
    // 被关标签的 URL 以 dsh 服务地址为前缀 → 它是 dsh 前端标签
    if (!snapshot.url.startsWith(status.url)) return;
    void launcher.stop().catch(() => {
      // 停止失败静默（已退出/进程已死）
    });
  };

  tabManager.on('removed', onRemoved);

  return () => {
    tabManager.off('removed', onRemoved);
  };
}
