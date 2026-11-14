import type { StatusBarState } from '@urchin/ipc-contract';

export interface StatusBarSyncTarget {
  statusBarOverlay: { handleSync(state: StatusBarState): void } | null;
  pendingStatusBarState?: StatusBarState;
}

/** 首帧同步可能早于悬浮层构造，保留最后一份快照供构造完成后重放。 */
export function syncStatusBarState(target: StatusBarSyncTarget, state: StatusBarState): void {
  target.pendingStatusBarState = state;
  target.statusBarOverlay?.handleSync(state);
}

export function replayStatusBarState(target: StatusBarSyncTarget): void {
  if (target.pendingStatusBarState)
    target.statusBarOverlay?.handleSync(target.pendingStatusBarState);
}
