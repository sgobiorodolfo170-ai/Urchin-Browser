/**
 * DeepSeek Harness · 标签关闭→停止后端绑定
 *
 * ADR-014：仅 dsh 使用本绑定——dsh 要求「web 前端关闭后，deepseek-harness 项目关闭」。
 * pi 托管服务（piWebHost）已改为应用级常驻：关 pi 标签不停后端，服务活到应用退出
 * （performCleanup 调 piWebHostLauncher.dispose()）。
 *
 * 实现：在 tabManager 'removed' 事件上挂监听，被关标签的 URL 与当前 dsh 服务
 * 地址做 origin 匹配（http://127.0.0.1:<port>）时——且关闭它之后不再有任何
 * dsh 前端标签存活——才调 launcher.stop()。
 *
 * 为什么是 origin 匹配而非「认证 URL 前缀 startsWith」（§7.1 修复，2026-11-06）：
 * dsh web 认证 URL 带 ?token= 首访后 303 重定向为干净 URL（vendor
 * browser-auth.ts:279-293），tab.url 随之变为干净 URL；startsWith(认证URL)
 * 从此必然落空 → 关标签不停后端。匹配基准改为 origin（sameServiceOrigin），
 * 与 pinner（bootstrap/handlers.ts piIconPinner）已愈路径同型。
 *
 * 为什么「最后一个才停」语义（用户裁决 Q3 = A2，2026-11-06）：
 * origin 匹配会同时命中 window.open 派生的 dsh 子标签；用户关掉派生标签
 * （或切场的后台标签）时若立即停后端，会误杀仍在前台使用的另一个 dsh 标签。
 * 因此先查剩余存活标签（'removed' 发出时该标签已从 TabManager 集合删除，
 * tab-manager.ts:313 delete 早于 :325 emit，query() 返回的即存活剩余集），
 * 仅当没有任何 dsh origin 标签剩余时才停。
 *
 * 参照 genoffice/integration.ts:108 的 tabManager.on('removed') 模式。
 */

import { sameServiceOrigin } from '../../shared/dsh-url';

/** Tab 快照最小接口（与 TabManager 的 TabSnapshot 对齐） */
export interface TabSnapshotLike {
  readonly id: number;
  readonly url: string;
  readonly active: boolean;
}

/** TabManager 最小接口（on/off + query——A2 语义需要查询剩余存活标签） */
export interface TabManagerLike {
  on(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown;
  off(event: 'removed', listener: (snapshot: TabSnapshotLike) => void): unknown;
  /**
   * 查询存活标签快照（与 TabManager.query 同构）。'removed' 事件发出时，
   * 被移除的标签已不在返回值中——直接沿用 TabManager 的删除时序。
   */
  query(info: { windowId?: number }): readonly TabSnapshotLike[];
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
    // 窄化提前固化：some() 回调闭包不继承 status.url 的非空判断
    const serviceUrl = status.url;
    // 被关标签与 dsh 服务 origin 相同 → 它是 dsh 前端标签（认证阶段/重定向后都命中）
    if (!sameServiceOrigin(snapshot.url, serviceUrl)) return;
    // A2「最后一个才停」：仍有 dsh origin 标签存活（含 window.open 派生标签）
    // 时不停后端，避免关掉派生标签误杀正在使用中的服务。
    const hasRemainingDshTab = tabManager
      .query({})
      .some((tab) => sameServiceOrigin(tab.url, serviceUrl));
    if (hasRemainingDshTab) return;
    void launcher.stop().catch(() => {
      // 停止失败静默（已退出/进程已死）
    });
  };

  tabManager.on('removed', onRemoved);

  return () => {
    tabManager.off('removed', onRemoved);
  };
}
