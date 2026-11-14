import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  StatusBarOverlay,
  DEFAULT_STATUS_BAR_STATE,
} from '../../src/main/status-bar/status-bar-overlay';
import {
  syncStatusBarState,
  replayStatusBarState,
  type StatusBarSyncTarget,
} from '../../src/main/status-bar/sync-state';

describe('首帧状态栏同步', () => {
  it('replays the latest state if sync arrives before the overlay exists', () => {
    const target: StatusBarSyncTarget = { statusBarOverlay: null };
    syncStatusBarState(target, { ...DEFAULT_STATUS_BAR_STATE, url: 'urchin://newtab' });
    syncStatusBarState(target, { ...DEFAULT_STATUS_BAR_STATE, url: 'urchin://mail' });
    const handleSync = vi.fn();
    target.statusBarOverlay = { handleSync };
    replayStatusBarState(target);
    expect(handleSync).toHaveBeenCalledOnce();
    expect(handleSync).toHaveBeenCalledWith(expect.objectContaining({ url: 'urchin://mail' }));
  });

  it('forwards normal updates immediately and tolerates no initial state', () => {
    const handleSync = vi.fn();
    const target: StatusBarSyncTarget = { statusBarOverlay: { handleSync } };
    replayStatusBarState(target);
    expect(handleSync).not.toHaveBeenCalled();
    syncStatusBarState(target, DEFAULT_STATUS_BAR_STATE);
    expect(handleSync).toHaveBeenCalledWith(DEFAULT_STATUS_BAR_STATE);
  });
});

it('opens on parent show when the first sync arrived while the parent was hidden', () => {
  let visible = false;
  const parent = Object.assign(new EventEmitter(), {
    isVisible: () => visible,
    focus: () => undefined,
    close: () => undefined,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
  });
  const overlay = new StatusBarOverlay({
    getParentWindow: () => parent,
    preloadPath: '',
    getLayout: () => ({ leftWidth: 44, rightWidth: 44, bottomHeight: 48 }),
    onLoad: () => Promise.resolve(),
    onAction: () => undefined,
  });
  const open = vi.spyOn(overlay, 'open').mockImplementation(() => undefined);
  overlay.handleSync({ ...DEFAULT_STATUS_BAR_STATE, visible: true });
  expect(open).not.toHaveBeenCalled();
  expect(parent.listenerCount('show')).toBe(1);
  visible = true;
  parent.emit('show');
  expect(open).toHaveBeenCalledOnce();
  overlay.destroy();
  expect(parent.listenerCount('show')).toBe(0);
});
