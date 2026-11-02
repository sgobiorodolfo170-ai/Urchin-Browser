/**
 * M27 笔记 · 状态加载 / 防抖持久化单测
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useNotebookStore } from '../../src/renderer/notebook/store';
import { NOTEBOOK_STATE_KEY } from '../../src/renderer/notebook/types';

type Invoke = (channel: string, req: unknown) => Promise<unknown>;

function installUrchin(invoke: Invoke): void {
  Object.defineProperty(window, 'urchin', {
    configurable: true,
    value: {
      invoke,
      on: () => () => undefined,
      onMessagePort: () => () => undefined,
      platform: 'win32',
      versions: { electron: '0', chrome: '0', node: '0' },
    },
  });
}

describe('useNotebookStore', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'settings.get') {
        return Promise.resolve({
          value: {
            notebooks: [{ id: 'nb-1', name: '已保存笔记本', createdAt: 1 }],
            activeNotebookId: 'nb-1',
            middleMode: 'tasks',
          },
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    installUrchin(invoke as Invoke);
  });

  it('should load and normalize persisted state', async () => {
    const { result } = renderHook(() => useNotebookStore());

    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state?.notebooks[0]?.name).toBe('已保存笔记本');
    expect(result.current.state?.middleMode).toBe('tasks');
  });

  it('should persist updates after the debounce window', async () => {
    const { result } = renderHook(() => useNotebookStore());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => {
      result.current.update((prev) => ({ ...prev, middleMode: 'notes' }));
    });

    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith('settings.set', {
          key: NOTEBOOK_STATE_KEY,
          value: expect.objectContaining({ middleMode: 'notes' }) as unknown,
        });
      },
      { timeout: 1500 },
    );
  });

  it('should flush pending state on unmount', async () => {
    const { result, unmount } = renderHook(() => useNotebookStore());
    await waitFor(() => expect(result.current.state).not.toBeNull());

    act(() => {
      result.current.update((prev) => ({ ...prev, middleMode: 'notes' }));
    });
    unmount();

    expect(invoke).toHaveBeenCalledWith('settings.set', {
      key: NOTEBOOK_STATE_KEY,
      value: expect.objectContaining({ middleMode: 'notes' }) as unknown,
    });
  });

  it('should fall back to a default state when loading fails', async () => {
    invoke.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useNotebookStore());

    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state?.notebooks).toHaveLength(1);
    expect(result.current.state?.notebooks[0]?.name).toBe('我的笔记本');
  });
});
