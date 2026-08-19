/**
 * 当前渲染进程所属窗口 id 获取（多窗口支持）。
 *
 * 背景（2026-08-19）：标签/书签可拖出到新窗口后，新窗口是 windowId=2+。
 * 渲染层此前到处硬编码 windowId=1（tab.list / tab.create），导致新窗口
 * 的 UI 组件全部操作原窗口的标签——功能失效。
 *
 * 方案：首次调用经 window.getCurrent IPC 让主进程按 sender 反查所属窗口，
 * 结果模块级缓存（每个窗口的渲染进程有独立 JS 上下文，缓存天然隔离）。
 * 异常/测试环境（返回值无 windowId）回退 1，保证既有行为不破坏。
 */

let cachedWindowId: number | null = null;

/** 获取当前窗口 id（首次调用走 IPC，之后同步缓存）。 */
export async function getCurrentWindowId(): Promise<number> {
  if (cachedWindowId !== null) return cachedWindowId;
  try {
    const res = (await window.urchin.invoke('window.getCurrent', {})) as {
      windowId?: number;
    };
    cachedWindowId = res && typeof res.windowId === 'number' && res.windowId > 0 ? res.windowId : 1;
  } catch {
    cachedWindowId = 1;
  }
  return cachedWindowId;
}
