/**
 * W5-D4 Provider 状态 store 单元测试
 *
 * 依据：契约 I §2 OR7 决策 / W5-D4
 *
 * 覆盖：
 * - handleEvent 处理 crashed / state-changed 事件
 * - isProviderCrashed 查询
 * - clearCrash 清除 crash 状态
 * - OR7：Provider 恢复后状态从 crashed → ready
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useProviderStatusStore } from '@urchin/ai-extension';

describe('ProviderStatusStore', () => {
  beforeEach(() => {
    // 重置 store
    useProviderStatusStore.setState({ statuses: new Map() });
  });

  it('初始状态为空', () => {
    const { statuses } = useProviderStatusStore.getState();
    expect(statuses.size).toBe(0);
  });

  it('handleEvent 处理 crashed 事件', () => {
    const { handleEvent } = useProviderStatusStore.getState();
    handleEvent({
      type: 'crashed',
      providerId: 'test-provider',
      reason: 'heartbeat timeout (16000ms)',
    });

    const { statuses } = useProviderStatusStore.getState();
    const entry = statuses.get('test-provider');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('crashed');
    expect(entry!.crashReason).toBe('heartbeat timeout (16000ms)');
  });

  it('handleEvent 处理 state-changed 事件', () => {
    const { handleEvent } = useProviderStatusStore.getState();
    handleEvent({
      type: 'state-changed',
      providerId: 'test-provider',
      state: 'ready',
    });

    const { statuses } = useProviderStatusStore.getState();
    const entry = statuses.get('test-provider');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('ready');
    expect(entry!.crashReason).toBeUndefined();
  });

  it('isProviderCrashed 返回 true 当 Provider 已 crash', () => {
    const store = useProviderStatusStore.getState();
    store.handleEvent({
      type: 'crashed',
      providerId: 'crashed-provider',
      reason: 'unexpected exit code=1',
    });

    expect(useProviderStatusStore.getState().isProviderCrashed('crashed-provider')).toBe(true);
    expect(useProviderStatusStore.getState().isProviderCrashed('other-provider')).toBe(false);
  });

  it('isProviderCrashed 返回 false 当 Provider ready', () => {
    const store = useProviderStatusStore.getState();
    store.handleEvent({
      type: 'state-changed',
      providerId: 'ready-provider',
      state: 'ready',
    });

    expect(useProviderStatusStore.getState().isProviderCrashed('ready-provider')).toBe(false);
  });

  it('clearCrash 清除 Provider 的 crash 状态', () => {
    const store = useProviderStatusStore.getState();
    store.handleEvent({
      type: 'crashed',
      providerId: 'test-provider',
      reason: 'heartbeat timeout',
    });

    expect(useProviderStatusStore.getState().isProviderCrashed('test-provider')).toBe(true);

    useProviderStatusStore.getState().clearCrash('test-provider');

    expect(useProviderStatusStore.getState().isProviderCrashed('test-provider')).toBe(false);
    expect(useProviderStatusStore.getState().getProviderStatus('test-provider')).toBeUndefined();
  });

  it('OR7：crash 后收到 ready 状态变更，crashReason 被清除', () => {
    const store = useProviderStatusStore.getState();

    // 1. Provider crash
    store.handleEvent({
      type: 'crashed',
      providerId: 'test-provider',
      reason: 'heartbeat timeout',
    });
    expect(useProviderStatusStore.getState().isProviderCrashed('test-provider')).toBe(true);

    // 2. OR7 自动恢复：ensureProviderLoaded 重建后 state → ready
    useProviderStatusStore.getState().handleEvent({
      type: 'state-changed',
      providerId: 'test-provider',
      state: 'ready',
    });

    const entry = useProviderStatusStore.getState().getProviderStatus('test-provider');
    expect(entry!.status).toBe('ready');
    expect(entry!.crashReason).toBeUndefined();
    expect(useProviderStatusStore.getState().isProviderCrashed('test-provider')).toBe(false);
  });

  it('OR7：crash 后收到 initializing 状态，crashReason 保留', () => {
    const store = useProviderStatusStore.getState();

    // 1. Provider crash
    store.handleEvent({
      type: 'crashed',
      providerId: 'test-provider',
      reason: 'heartbeat timeout',
    });

    // 2. OR7 自动恢复：开始重建，state → initializing
    useProviderStatusStore.getState().handleEvent({
      type: 'state-changed',
      providerId: 'test-provider',
      state: 'initializing',
    });

    const entry = useProviderStatusStore.getState().getProviderStatus('test-provider');
    expect(entry!.status).toBe('initializing');
    // crashReason 保留（只有 ready 时才清除）
    expect(entry!.crashReason).toBe('heartbeat timeout');
  });

  it('getProviderStatus 返回 undefined 当 Provider 不存在', () => {
    expect(useProviderStatusStore.getState().getProviderStatus('non-existent')).toBeUndefined();
  });
});
