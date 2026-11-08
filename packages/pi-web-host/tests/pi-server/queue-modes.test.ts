/**
 * queue-modes.ts 单元测试
 *
 * 覆盖排队投递模式（all / one-at-a-time）落到 settingsManager 与 agent 两处的
 * 默认值、独立性与重载后重放。
 *
 * 为何要同时写 settingsManager 和 agent：agent 上的模式决定本轮实际消费方式，
 * settingsManager 的 overrides 决定重载/快照时看到的值；只写一处会出现
 * 「UI 显示 all、实际一次只发一条」的错位。
 */
import { describe, expect, it, vi } from 'vitest';
import { applyQueueModesToSession } from '../../src/pi-server/queue-modes.js';

type Mode = 'all' | 'one-at-a-time';

function session() {
  return {
    settingsManager: { applyOverrides: vi.fn() },
    agent: {
      steeringMode: 'one-at-a-time' as Mode,
      followUpMode: 'one-at-a-time' as Mode,
    },
  };
}

describe('applyQueueModesToSession', () => {
  it('should default both live queues and the reload settings view to all', () => {
    const target = session();
    applyQueueModesToSession(target, {});
    expect(target.agent).toEqual({ steeringMode: 'all', followUpMode: 'all' });
    expect(target.settingsManager.applyOverrides).toHaveBeenCalledTimes(1);
    expect(target.settingsManager.applyOverrides).toHaveBeenCalledWith({
      steeringMode: 'all',
      followUpMode: 'all',
    });
  });

  it('should change each queue independently and reapply preferences after reload', () => {
    const target = session();
    applyQueueModesToSession(target, { steeringMode: 'one-at-a-time', followUpMode: 'all' });
    expect(target.agent).toEqual({ steeringMode: 'one-at-a-time', followUpMode: 'all' });
    expect(target.settingsManager.applyOverrides).toHaveBeenLastCalledWith({
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
    });

    target.agent.followUpMode = 'one-at-a-time';
    applyQueueModesToSession(target, { steeringMode: 'all', followUpMode: 'one-at-a-time' });
    expect(target.agent).toEqual({ steeringMode: 'all', followUpMode: 'one-at-a-time' });
    expect(target.settingsManager.applyOverrides).toHaveBeenLastCalledWith({
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
    });
  });

  it('should fill a partially specified settings object with defaults', () => {
    const target = session();
    applyQueueModesToSession(target, { followUpMode: 'all' });
    expect(target.agent.steeringMode).toBe('all');
    expect(target.agent.followUpMode).toBe('all');
  });

  it('should leave unrelated settings manager calls untouched between invocations', () => {
    const target = session();
    applyQueueModesToSession(target, { steeringMode: 'one-at-a-time' });
    applyQueueModesToSession(target, { steeringMode: 'all' });
    expect(target.settingsManager.applyOverrides).toHaveBeenNthCalledWith(1, {
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
    });
    expect(target.settingsManager.applyOverrides).toHaveBeenNthCalledWith(2, {
      steeringMode: 'all',
      followUpMode: 'all',
    });
  });
});
