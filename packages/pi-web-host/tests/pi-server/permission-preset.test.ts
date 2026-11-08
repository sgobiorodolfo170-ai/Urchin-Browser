/**
 * permission-preset.ts 单元测试
 *
 * 上游 permission-persistence.test.ts / plan-state.test.ts 依赖真实
 * SessionManager（vendored pi-coding-agent，vitest 无法解析），这里改为
 * 直接喂 `getEntries()` 形状的桩对象，覆盖四个读取函数的「取最后一条」
 * 「类型门槛」「坏数据/异常降级」语义。
 */
import { describe, expect, it } from 'vitest';
import {
  readDelegateModeFromSession,
  readPermissionFromSession,
  readPlanFromSession,
  readPlanModeFromSession,
} from '../../src/pi-server/permission-preset.js';

function sessionWith(entries: unknown[]) {
  return { getEntries: () => entries };
}

describe('readPlanModeFromSession', () => {
  it('should return false when the session manager has no getEntries', () => {
    expect(readPlanModeFromSession(undefined)).toBe(false);
    expect(readPlanModeFromSession({})).toBe(false);
    expect(readPlanModeFromSession(null)).toBe(false);
  });

  it('should return false when there is no plan/mode entry', () => {
    expect(readPlanModeFromSession(sessionWith([]))).toBe(false);
    expect(readPlanModeFromSession(sessionWith([{ type: 'message' }]))).toBe(false);
  });

  it('should return the enabled flag of the latest plan/mode entry', () => {
    const sm = sessionWith([
      { customType: 'plan/mode', data: { enabled: true } },
      { customType: 'other', data: { enabled: false } },
      { customType: 'plan/mode', data: { enabled: false } },
    ]);
    expect(readPlanModeFromSession(sm)).toBe(false);
    expect(
      readPlanModeFromSession(
        sessionWith([
          { customType: 'plan/mode', data: { enabled: false } },
          { customType: 'plan/mode', data: { enabled: true } },
        ]),
      ),
    ).toBe(true);
  });

  it('should ignore entries whose enabled flag is not a boolean', () => {
    const sm = sessionWith([
      { customType: 'plan/mode', data: { enabled: true } },
      { customType: 'plan/mode', data: { enabled: 'yes' } },
    ]);
    expect(readPlanModeFromSession(sm)).toBe(true);
  });

  it('should fall back to false when getEntries throws', () => {
    const sm = {
      getEntries: () => {
        throw new Error('broken');
      },
    };
    expect(readPlanModeFromSession(sm)).toBe(false);
  });
});

describe('readDelegateModeFromSession', () => {
  it('should return false when there is no delegate/mode entry', () => {
    expect(readDelegateModeFromSession(undefined)).toBe(false);
    expect(readDelegateModeFromSession(sessionWith([]))).toBe(false);
  });

  it('should return the enabled flag of the latest delegate/mode entry', () => {
    expect(
      readDelegateModeFromSession(
        sessionWith([
          { customType: 'delegate/mode', data: { enabled: true } },
          { customType: 'delegate/mode', data: { enabled: false } },
        ]),
      ),
    ).toBe(false);
    expect(
      readDelegateModeFromSession(
        sessionWith([{ customType: 'plan/mode', data: { enabled: true } }]),
      ),
    ).toBe(false);
  });

  it('should survive a throwing session manager', () => {
    expect(
      readDelegateModeFromSession({
        getEntries: () => {
          throw new Error('broken');
        },
      }),
    ).toBe(false);
  });
});

describe('readPermissionFromSession', () => {
  it('should return undefined when there is no permission entry', () => {
    expect(readPermissionFromSession(undefined)).toBeUndefined();
    expect(readPermissionFromSession(sessionWith([]))).toBeUndefined();
  });

  it('should return the latest custom permission/preset', () => {
    const sm = sessionWith([
      { type: 'custom', customType: 'permission/preset', data: { preset: 'read-only' } },
      { type: 'custom', customType: 'permission/preset', data: { preset: 'danger-full-access' } },
    ]);
    expect(readPermissionFromSession(sm)).toBe('danger-full-access');
  });

  it('should require type "custom" and a string preset', () => {
    expect(
      readPermissionFromSession(
        sessionWith([{ customType: 'permission/preset', data: { preset: 'read-only' } }]),
      ),
    ).toBeUndefined();
    expect(
      readPermissionFromSession(
        sessionWith([{ type: 'custom', customType: 'permission/preset', data: { preset: 42 } }]),
      ),
    ).toBeUndefined();
  });

  it('should ignore entries with a different customType', () => {
    expect(
      readPermissionFromSession(
        sessionWith([{ type: 'custom', customType: 'plan/mode', data: { preset: 'read-only' } }]),
      ),
    ).toBeUndefined();
  });

  it('should return undefined when getEntries throws', () => {
    expect(
      readPermissionFromSession({
        getEntries: () => {
          throw new Error('broken');
        },
      }),
    ).toBeUndefined();
  });
});

describe('readPlanFromSession', () => {
  const plan = {
    steps: [{ id: '1', title: '历史步骤', status: 'done' }],
    activeStepId: null,
    updatedAt: 123456,
  };

  it('should return null when there is no plan entry', () => {
    expect(readPlanFromSession(undefined)).toBeNull();
    expect(readPlanFromSession(sessionWith([]))).toBeNull();
  });

  it('should restore a plan from customType plan/update', () => {
    const restored = readPlanFromSession(
      sessionWith([
        { type: 'message', role: 'user' },
        { type: 'custom', customType: 'plan/update', data: { plan } },
      ]),
    );
    expect(restored?.steps[0]?.title).toBe('历史步骤');
    expect(restored?.updatedAt).toBe(123456);
  });

  it('should also accept the legacy pi-web-ui/plan customType', () => {
    const restored = readPlanFromSession(
      sessionWith([{ type: 'custom', customType: 'pi-web-ui/plan', data: { plan } }]),
    );
    expect(restored?.steps).toHaveLength(1);
  });

  it('should return the latest valid plan', () => {
    const newer = {
      steps: [{ id: '2', title: '新步骤', status: 'pending' }],
      activeStepId: '2',
      updatedAt: 2,
    };
    const restored = readPlanFromSession(
      sessionWith([
        { type: 'custom', customType: 'plan/update', data: { plan } },
        { type: 'custom', customType: 'plan/update', data: { plan: newer } },
      ]),
    );
    expect(restored?.steps[0]?.id).toBe('2');
  });

  it('should skip entries whose plan steps are not an array', () => {
    expect(
      readPlanFromSession(
        sessionWith([
          { type: 'custom', customType: 'plan/update', data: { plan: { steps: 'nope' } } },
          { type: 'custom', customType: 'plan/update', data: { plan: null } },
        ]),
      ),
    ).toBeNull();
  });

  it('should require type "custom"', () => {
    expect(
      readPlanFromSession(sessionWith([{ customType: 'plan/update', data: { plan } }])),
    ).toBeNull();
  });

  it('should return null when getEntries throws', () => {
    expect(
      readPlanFromSession({
        getEntries: () => {
          throw new Error('broken');
        },
      }),
    ).toBeNull();
  });
});
