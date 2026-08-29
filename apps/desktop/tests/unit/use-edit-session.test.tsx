/**
 * 编辑会话 hook（use-edit-session）单元测试
 *
 * 验证：进入编辑重读原文 / 脏判定与草稿防抖 / requestExit 三键分支 /
 * 覆盖保存失败转另存为 / 守卫注册与清理。
 * mock 策略：window.urchin.invoke 直接 mock（jsdom，与 file-viewer 测试一致）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditSession } from '../../src/renderer/files/editor/use-edit-session';
import { getEditGuardSession } from '../../src/renderer/lib/edit-guard';

const mockInvoke = vi.fn();
beforeEach(() => {
  mockInvoke.mockReset();
  Object.defineProperty(window, 'urchin', {
    value: { invoke: mockInvoke, platform: 'win32', versions: { electron: '32.0.0' } },
    writable: true,
    configurable: true,
  });
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === 'file.read')
      return Promise.resolve({
        content: 'raw content',
        truncated: false,
        totalSize: 11,
        readBytes: 11,
      });
    if (channel === 'file.write') return Promise.resolve({ bytesWritten: 11 });
    if (channel === 'editor.saveDraft') return Promise.resolve({ draftPath: 'C:\\d\\k' });
    if (channel === 'editor.cleanupDraft') return Promise.resolve({ removed: true });
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(overrides?: { tabId?: number; onToast?: (m: string) => void }) {
  return renderHook(() =>
    useEditSession({
      path: 'C:\\docs\\notes.md',
      maxBytes: 2 * 1024 * 1024,
      tabId: overrides?.tabId,
      onToast: overrides?.onToast ?? (() => undefined),
    }),
  );
}

describe('useEditSession', () => {
  it('startEdit re-reads raw content and enters edit mode', async () => {
    const { result } = setup();
    expect(result.current.mode).toBe('read');

    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.mode).toBe('edit');
    expect(result.current.value).toBe('raw content');
    expect(result.current.dirty).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('file.read', {
      path: 'C:\\docs\\notes.md',
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it('setValue marks dirty and schedules draft autosave (2s debounce)', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.setValue('raw content v2'));
    expect(result.current.dirty).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const draftCalls = mockInvoke.mock.calls.filter((c) => c[0] === 'editor.saveDraft');
    expect(draftCalls).toHaveLength(1);
    expect(String((draftCalls[0]?.[1] as { key: string }).key)).toMatch(/^notes-md-/);
    expect((draftCalls[0]?.[1] as { content: string }).content).toBe('raw content v2');
  });

  it('reverting to saved content turns clean and cancels draft', async () => {
    vi.useFakeTimers();
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.setValue('changed'));
    act(() => result.current.setValue('raw content'));
    expect(result.current.dirty).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mockInvoke.mock.calls.some((c) => c[0] === 'editor.saveDraft')).toBe(false);
  });

  it('requestExit clean: resolves true immediately without dialog', async () => {
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });

    let ok = false;
    await act(async () => {
      ok = await result.current.requestExit();
    });
    expect(ok).toBe(true);
    expect(result.current.confirm).toBeNull();
    expect(result.current.mode).toBe('read');
  });

  it('requestExit dirty: save writes file, cleans draft, exits edit', async () => {
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setValue('v2'));

    let ok = false;
    let pending: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      pending = result.current.requestExit();
      await Promise.resolve();
    });
    expect(result.current.confirm).not.toBeNull();
    await act(async () => {
      result.current.confirm?.onSave();
      ok = await pending;
    });
    expect(ok).toBe(true);
    expect(result.current.mode).toBe('read');
    expect(mockInvoke).toHaveBeenCalledWith('file.write', {
      path: 'C:\\docs\\notes.md',
      content: 'v2',
    });
    expect(mockInvoke.mock.calls.some((c) => c[0] === 'editor.cleanupDraft')).toBe(true);
  });

  it('requestExit dirty: cancel keeps editing and resolves false', async () => {
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setValue('v2'));

    let ok = true;
    let pending: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      pending = result.current.requestExit();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.confirm?.onCancel();
      ok = await pending;
    });
    expect(ok).toBe(false);
    expect(result.current.mode).toBe('edit');
    expect(result.current.dirty).toBe(true);
  });

  it('requestExit dirty: discard restores saved content and cleans draft', async () => {
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setValue('v2'));

    let ok = false;
    let pending: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      pending = result.current.requestExit();
      await Promise.resolve();
    });
    await act(async () => {
      result.current.confirm?.onDiscard();
      ok = await pending;
    });
    expect(ok).toBe(true);
    expect(result.current.value).toBe('raw content');
    expect(result.current.dirty).toBe(false);
  });

  it('save failure falls back to saveAs in saveWithFallback', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'file.read')
        return Promise.resolve({ content: 'raw', truncated: false, totalSize: 3, readBytes: 3 });
      if (channel === 'file.write') return Promise.reject(new Error('EACCES'));
      if (channel === 'file.saveAs') return Promise.resolve({ path: 'C:\\docs\\copy.md' });
      if (channel === 'editor.cleanupDraft') return Promise.resolve({ removed: true });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });
    const { result } = setup();
    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setValue('v2'));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveWithFallback();
    });
    expect(saved).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      'file.saveAs',
      expect.objectContaining({ defaultName: 'notes.md', defaultDir: 'C:\\docs' }),
    );
  });

  it('registers guard session while editing (tabId) and clears on unmount', async () => {
    const { result, unmount } = setup({ tabId: 7 });
    expect(getEditGuardSession()).toBeNull();

    act(() => result.current.startEdit());
    await act(async () => {
      await Promise.resolve();
    });

    const guard = getEditGuardSession();
    expect(guard?.tabId).toBe(7);

    unmount();
    expect(getEditGuardSession()).toBeNull();
  });
});
