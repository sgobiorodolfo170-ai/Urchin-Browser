/**
 * M27 笔记 · 无限画布便利贴单测
 *
 * 覆盖：新建按钮、Ctrl+V 粘贴文本生成便利贴、编辑文本、切换颜色、删除。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StickyCanvas } from '../../src/renderer/notebook/StickyCanvas';
import { normalizeNotebookState } from '../../src/renderer/notebook/normalize';
import type { NotebookState, StickyNote } from '../../src/renderer/notebook/types';

type Update = (updater: (prev: NotebookState) => NotebookState) => void;

function baseState(): NotebookState {
  return normalizeNotebookState(
    {
      notebooks: [{ id: 'nb-1', name: 'A', createdAt: 1 }],
      activeNotebookId: 'nb-1',
    },
    1000,
  );
}

function sticky(overrides: Partial<StickyNote> = {}): StickyNote {
  return {
    id: 's1',
    notebookId: 'nb-1',
    text: 'hello',
    x: 10,
    y: 20,
    width: 220,
    height: 160,
    color: 'amber',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('StickyCanvas', () => {
  it('should add a sticky from the toolbar button', () => {
    const state = baseState();
    const update = vi.fn<Update>();
    render(<StickyCanvas state={state} notebookId="nb-1" update={update} />);

    fireEvent.click(screen.getByLabelText('新建便利贴'));

    expect(update).toHaveBeenCalledTimes(1);
    const updater = update.mock.calls[0]![0];
    const next = updater(state);
    expect(next.stickies).toHaveLength(1);
    expect(next.stickies[0]?.notebookId).toBe('nb-1');
  });

  it('should create a sticky from pasted plain text', () => {
    const state = baseState();
    const update = vi.fn<Update>();
    render(<StickyCanvas state={state} notebookId="nb-1" update={update} />);

    fireEvent.paste(screen.getByLabelText('便利贴画布'), {
      clipboardData: { getData: () => '粘贴的文本' },
    });

    expect(update).toHaveBeenCalledTimes(1);
    const next = update.mock.calls[0]![0](state);
    expect(next.stickies[0]?.text).toBe('粘贴的文本');
  });

  it('should edit text, change color, and delete an existing sticky', () => {
    const state = { ...baseState(), stickies: [sticky()] };
    const update = vi.fn<Update>();
    render(<StickyCanvas state={state} notebookId="nb-1" update={update} />);

    const textarea = screen.getByLabelText('便利贴内容');
    fireEvent.change(textarea, { target: { value: '更新内容' } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0](state).stickies[0]?.text).toBe('更新内容');

    fireEvent.click(screen.getByLabelText('切换为 pink 色'));
    expect(update.mock.calls[1]![0](state).stickies[0]?.color).toBe('pink');

    fireEvent.click(screen.getByLabelText('删除便利贴'));
    expect(update.mock.calls[2]![0](state).stickies).toHaveLength(0);
  });

  it('should show an empty hint when there are no stickies', () => {
    render(<StickyCanvas state={baseState()} notebookId="nb-1" update={vi.fn()} />);
    expect(screen.getByText(/添加第一张便利贴/)).toBeInTheDocument();
  });

  it('should support zoom controls and reset', () => {
    const state = baseState();
    const update = vi.fn<Update>();
    render(<StickyCanvas state={state} notebookId="nb-1" update={update} />);

    fireEvent.click(screen.getByLabelText('放大画布'));
    expect(update).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('重置画布视图'));
    const last = update.mock.calls[update.mock.calls.length - 1]![0];
    expect(last(state).viewports['nb-1']).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });
});
