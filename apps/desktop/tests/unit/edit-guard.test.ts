/**
 * 编辑离开守卫注册表（edit-guard）单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setEditGuardSession,
  getEditGuardSession,
  closeNeedsGuard,
  switchNeedsGuard,
  type EditGuardSession,
} from '../../src/renderer/lib/edit-guard';

function makeSession(tabId: number, dirty: boolean): EditGuardSession {
  return {
    tabId,
    isDirty: () => dirty,
    save: () => Promise.resolve(true),
    discard: () => Promise.resolve(),
  };
}

describe('edit-guard', () => {
  beforeEach(() => {
    setEditGuardSession(null);
  });

  it('should register and clear the active session', () => {
    const s = makeSession(1, true);
    setEditGuardSession(s);
    expect(getEditGuardSession()).toBe(s);
    setEditGuardSession(null);
    expect(getEditGuardSession()).toBeNull();
  });

  it('closeNeedsGuard: only when closing the dirty session tab', () => {
    setEditGuardSession(makeSession(1, true));
    expect(closeNeedsGuard(1)).toBe(true);
    expect(closeNeedsGuard(2)).toBe(false);

    setEditGuardSession(makeSession(1, false));
    expect(closeNeedsGuard(1)).toBe(false);
    expect(closeNeedsGuard(2)).toBe(false);

    setEditGuardSession(null);
    expect(closeNeedsGuard(1)).toBe(false);
  });

  it('switchNeedsGuard: only when leaving the dirty session tab', () => {
    setEditGuardSession(makeSession(1, true));
    // 切到别的标签 → 需要守卫；切到会话自身标签 → 不需要
    expect(switchNeedsGuard(2)).toBe(true);
    expect(switchNeedsGuard(1)).toBe(false);

    setEditGuardSession(makeSession(1, false));
    expect(switchNeedsGuard(2)).toBe(false);

    setEditGuardSession(null);
    expect(switchNeedsGuard(2)).toBe(false);
  });
});
