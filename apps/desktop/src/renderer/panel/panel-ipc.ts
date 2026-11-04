/**
 * 收藏夹面板 · IPC 访问层（P2 Session 4 迁移）
 *
 * 子窗口复用主窗口 preload：file:/urchin: 协议下暴露 window.urchin.invoke，
 * 全部通道沿用 bookmark-panel.ts 内联脚本的原始调用（zod 契约见 @urchin/ipc-contract）。
 */

/** window.urchin.invoke 的面板侧薄封装（req 缺省传 {}，与原脚本 invoke(ch, req||{}) 一致） */
export function invoke<T>(channel: string, req?: unknown): Promise<T> {
  return window.urchin.invoke(channel, req ?? {}) as Promise<T>;
}

/** 拉取活动标签列表（面板打开 URL 的目标查询用，windowId 固定 1 = 主窗口） */
interface TabListRes {
  tabs?: readonly { id: number; active?: boolean }[];
}

/**
 * 在当前活跃标签页打开 URL（原内联脚本 loadTab 行点击逻辑）。
 * 无活跃标签时静默忽略；IPC 失败不抛出（保持面板现状）。
 */
export async function openUrlInActiveTab(url: string): Promise<void> {
  try {
    const res = await invoke<TabListRes>('tab.list', { windowId: 1 });
    const active = (res.tabs ?? []).find((t) => t.active);
    if (active) await invoke('tab.loadUrl', { tabId: active.id, url });
  } catch {
    /* ignore */
  }
}
