/**
 * M27 笔记 · 状态规范化单测
 *
 * 覆盖：首次运行种子、脏数据过滤、失联 id 收敛、active/expanded/viewports/layout 兜底。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultState, normalizeNotebookState } from '../../src/renderer/notebook/normalize';
import { NOTEBOOK_STATE_VERSION } from '../../src/renderer/notebook/types';

describe('normalizeNotebookState', () => {
  it('should seed a default notebook and welcome note for empty input', () => {
    const state = normalizeNotebookState(null, 1000);

    expect(state.version).toBe(NOTEBOOK_STATE_VERSION);
    expect(state.notebooks).toHaveLength(1);
    expect(state.notebooks[0]?.name).toBe('我的笔记本');
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.notebookId).toBe(state.notebooks[0]?.id);
    expect(state.activeNotebookId).toBe(state.notebooks[0]?.id);
    expect(state.middleMode).toBe('notes');
    expect(state.layout).toBeNull();
  });

  it('should drop invalid notebooks and keep first valid as active fallback', () => {
    const state = normalizeNotebookState(
      {
        notebooks: [
          null,
          { id: '', name: 'bad' },
          { id: 'nb-1', name: '  工作  ', createdAt: 10 },
          { id: 'nb-1', name: 'duplicate' },
        ],
        activeNotebookId: 'missing',
      },
      2000,
    );

    expect(state.notebooks).toEqual([{ id: 'nb-1', name: '工作', createdAt: 10 }]);
    expect(state.activeNotebookId).toBe('nb-1');
    expect(state.expandedNotebookIds).toContain('nb-1');
  });

  it('should filter notes/tasks/stickies with missing or unknown notebook ids', () => {
    const state = normalizeNotebookState(
      {
        notebooks: [{ id: 'nb-1', name: 'A', createdAt: 1 }],
        notes: [
          { id: 'n1', notebookId: 'nb-1', title: 'ok', content: 'x' },
          { id: 'n2', notebookId: 'nb-2', title: 'orphan' },
          { id: 'n1', notebookId: 'nb-1', title: 'duplicate' },
          { id: '', notebookId: 'nb-1' },
        ],
        tasks: [
          { id: 't1', notebookId: 'nb-1', text: 'task', done: true },
          { id: 't2', notebookId: 'nb-1', text: '   ' },
          { id: 't3', notebookId: 'nb-2', text: 'orphan' },
        ],
        stickies: [
          {
            id: 's1',
            notebookId: 'nb-1',
            text: 'hi',
            x: 10,
            y: 20,
            width: 9999,
            height: 1,
            color: 'not-a-color',
          },
          { id: 's2', notebookId: 'nb-2', text: 'orphan' },
        ],
      },
      5000,
    );

    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.title).toBe('ok');
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.done).toBe(true);
    expect(state.stickies).toHaveLength(1);
    expect(state.stickies[0]).toMatchObject({
      id: 's1',
      width: 1200,
      height: 80,
      color: 'amber',
    });
  });

  it('should keep active note only when it belongs to the active notebook', () => {
    const state = normalizeNotebookState(
      {
        notebooks: [
          { id: 'nb-1', name: 'A', createdAt: 1 },
          { id: 'nb-2', name: 'B', createdAt: 2 },
        ],
        notes: [
          { id: 'n1', notebookId: 'nb-1', title: 'A note' },
          { id: 'n2', notebookId: 'nb-2', title: 'B note' },
        ],
        activeNotebookId: 'nb-2',
        activeNoteId: 'n1',
      },
      3000,
    );

    expect(state.activeNoteId).toBeNull();
  });

  it('should normalize viewports and layout, clamping zoom and ignoring invalid entries', () => {
    const state = normalizeNotebookState(
      {
        notebooks: [{ id: 'nb-1', name: 'A', createdAt: 1 }],
        viewports: {
          'nb-1': { panX: 12, panY: -8, zoom: 99 },
          'nb-2': { panX: 0, panY: 0, zoom: 1 },
          bad: 'nope',
        },
        layout: { left: 300, middle: 0, right: 500, custom: true },
      },
      1000,
    );

    expect(state.viewports['nb-1']).toEqual({ panX: 12, panY: -8, zoom: 2.5 });
    expect(state.viewports['nb-2']).toBeUndefined();
    expect(state.layout).toBeNull();
  });

  it('should accept a valid persisted layout and version', () => {
    const state = normalizeNotebookState(
      {
        version: 99,
        notebooks: [{ id: 'nb-1', name: 'A', createdAt: 1 }],
        layout: { left: 200, middle: 400, right: 400, custom: true },
      },
      1000,
    );

    expect(state.version).toBe(NOTEBOOK_STATE_VERSION);
    expect(state.layout).toEqual({
      left: 0.2,
      middle: 0.4,
      right: 0.4,
      custom: true,
    });
  });

  it('should produce a serializable default state', () => {
    const state = createDefaultState(1234);
    expect(() => JSON.stringify(state)).not.toThrow();
    expect(state.notes[0]?.content).toContain('任务清单');
  });
});
