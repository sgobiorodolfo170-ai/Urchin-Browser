/**
 * 中转区 · 图钉定住 / 拖出移除单测
 *
 * 覆盖：
 * - normalizeItem 正确保留/丢弃 pinned 字段
 * - store.togglePin / setPinned 修改 pinned 状态并持久化
 * - store.remove 在拖出落盘后被调用（非 pinned 项）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTransitStore } from '../../src/renderer/transit/store';
import {
  normalizeItem,
  TRANSIT_ITEMS_KEY,
  type TransitItem,
} from '../../src/renderer/transit/types';

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

function makeRawItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'transit-test-1',
    kind: 'file',
    title: 'test.pdf',
    addedAt: 1000,
    ...overrides,
  };
}

describe('normalizeItem · pinned', () => {
  it('should preserve pinned=true', () => {
    const item = normalizeItem(makeRawItem({ pinned: true }));
    expect(item?.pinned).toBe(true);
  });

  it('should omit pinned when false', () => {
    const item = normalizeItem(makeRawItem({ pinned: false }));
    expect(item?.pinned).toBeUndefined();
  });

  it('should omit pinned when absent', () => {
    const item = normalizeItem(makeRawItem());
    expect(item?.pinned).toBeUndefined();
  });

  it('should ignore non-boolean pinned', () => {
    const item = normalizeItem(makeRawItem({ pinned: 'yes' }));
    expect(item?.pinned).toBeUndefined();
  });
});

describe('useTransitStore · togglePin / setPinned', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'settings.get') {
        return Promise.resolve({
          value: [
            { id: 't-1', kind: 'file', title: 'a.pdf', addedAt: 1 },
            { id: 't-2', kind: 'text', title: 'note', addedAt: 2, pinned: true },
            { id: 't-3', kind: 'link', title: 'url', addedAt: 3 },
          ],
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    installUrchin(invoke as Invoke);
  });

  it('should load pinned state from persisted items', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const items = result.current.items;
    expect(items[0]?.pinned).toBeUndefined();
    expect(items[1]?.pinned).toBe(true);
    expect(items[2]?.pinned).toBeUndefined();
  });

  it('should toggle pin on an item', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.togglePin('t-1'));
    expect(result.current.items[0]?.pinned).toBe(true);

    act(() => result.current.togglePin('t-1'));
    expect(result.current.items[0]?.pinned).toBeUndefined();
  });

  it('should unpin a pinned item via togglePin', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.togglePin('t-2'));
    expect(result.current.items[1]?.pinned).toBeUndefined();
  });

  it('should setPinned for multiple items at once', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setPinned(['t-1', 't-3'], true));
    expect(result.current.items[0]?.pinned).toBe(true);
    expect(result.current.items[1]?.pinned).toBe(true);
    expect(result.current.items[2]?.pinned).toBe(true);
  });

  it('should setPinned=false to unpin items', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.setPinned(['t-2'], false));
    expect(result.current.items[1]?.pinned).toBeUndefined();
  });

  it('should persist pinned state to settings', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.togglePin('t-1'));
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith(
          'settings.set',
          expect.objectContaining({ key: TRANSIT_ITEMS_KEY }) as unknown,
        );
      },
      { timeout: 1500 },
    );

    const lastCall = invoke.mock.calls.find((c) => c[0] === 'settings.set');
    expect(lastCall).toBeDefined();
    const value = (lastCall![1] as { value: TransitItem[] }).value;
    expect(value[0]?.pinned).toBe(true);
  });
});

describe('useTransitStore · remove after drag-out (pinned exemption)', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invoke = vi.fn((channel: string) => {
      if (channel === 'settings.get') {
        return Promise.resolve({
          value: [
            { id: 't-free', kind: 'file', title: 'free.pdf', addedAt: 1 },
            { id: 't-pinned', kind: 'file', title: 'pinned.pdf', addedAt: 2, pinned: true },
          ],
        });
      }
      if (channel === 'settings.set') return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    installUrchin(invoke as Invoke);
  });

  it('should allow removing non-pinned item', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.remove('t-free'));
    expect(result.current.items.map((it) => it.id)).toEqual(['t-pinned']);
  });

  it('should allow removing pinned item via explicit remove', async () => {
    const { result } = renderHook(() => useTransitStore());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.remove('t-pinned'));
    expect(result.current.items.map((it) => it.id)).toEqual(['t-free']);
  });
});
