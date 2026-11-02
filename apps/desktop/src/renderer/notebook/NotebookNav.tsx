/**
 * 笔记页 · 左区导航（笔记本 + 页面树）
 *
 * 结构：
 * - 一级：笔记本（可折叠 / 新建 / 重命名 / 删除）
 * - 二级：固定「任务清单」节点 + 该笔记本下的笔记页面
 *
 * 交互：单击选中，双击 / 铅笔按钮重命名，垃圾桶删除；删除均二次确认。
 */
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  ListTodo,
  Notebook as NotebookIcon,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { cn } from '../lib/utils';
import { makeNotebookId } from './normalize';
import type { NotebookMeta, NotebookState } from './types';

export interface NotebookNavProps {
  readonly state: NotebookState;
  readonly update: (updater: (prev: NotebookState) => NotebookState) => void;
}

interface EditTarget {
  readonly kind: 'notebook' | 'note';
  readonly id: string;
}
interface DeleteTarget {
  readonly kind: 'notebook' | 'note';
  readonly id: string;
  readonly name: string;
}

const ICON_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface hover:text-text';

function notebookNotes(state: NotebookState, notebookId: string) {
  return state.notes
    .filter((note) => note.notebookId === notebookId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function notebookTodoCount(state: NotebookState, notebookId: string): number {
  return state.tasks.filter((task) => task.notebookId === notebookId && !task.done).length;
}

export function NotebookNav({ state, update }: NotebookNavProps) {
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  const startEdit = (kind: EditTarget['kind'], id: string, value: string) => {
    setEditing({ kind, id });
    setDraft(value);
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };

  const commitEdit = () => {
    if (!editing) return;
    const value = draft.trim();
    if (editing.kind === 'notebook') {
      if (!value) {
        cancelEdit();
        return;
      }
      update((prev) => ({
        ...prev,
        notebooks: prev.notebooks.map((nb) => (nb.id === editing.id ? { ...nb, name: value } : nb)),
      }));
    } else {
      update((prev) => ({
        ...prev,
        notes: prev.notes.map((note) =>
          note.id === editing.id ? { ...note, title: value, updatedAt: Date.now() } : note,
        ),
      }));
    }
    cancelEdit();
  };

  const addNotebook = () => {
    const now = Date.now();
    const notebook: NotebookMeta = {
      id: makeNotebookId('nb'),
      name: '新建笔记本',
      createdAt: now,
    };
    update((prev) => ({
      ...prev,
      notebooks: [...prev.notebooks, notebook],
      activeNotebookId: notebook.id,
      activeNoteId: null,
      middleMode: 'notes',
      expandedNotebookIds: prev.expandedNotebookIds.includes(notebook.id)
        ? prev.expandedNotebookIds
        : [...prev.expandedNotebookIds, notebook.id],
    }));
    startEdit('notebook', notebook.id, notebook.name);
  };

  const addPage = (notebookId: string) => {
    const now = Date.now();
    const note = {
      id: makeNotebookId('note'),
      notebookId,
      title: '',
      content: '',
      createdAt: now,
      updatedAt: now,
    };
    update((prev) => ({
      ...prev,
      notes: [...prev.notes, note],
      activeNotebookId: notebookId,
      activeNoteId: note.id,
      middleMode: 'notes',
      expandedNotebookIds: prev.expandedNotebookIds.includes(notebookId)
        ? prev.expandedNotebookIds
        : [...prev.expandedNotebookIds, notebookId],
    }));
    startEdit('note', note.id, '');
  };

  const deleteNotebook = (notebookId: string) => {
    update((prev) => {
      if (prev.notebooks.length <= 1) return prev;
      const notebooks = prev.notebooks.filter((nb) => nb.id !== notebookId);
      const nextNotebook = notebooks[0];
      if (!nextNotebook) return prev;
      const notes = prev.notes.filter((note) => note.notebookId !== notebookId);
      const viewports = { ...prev.viewports };
      delete viewports[notebookId];
      const activeNoteStillExists = notes.some((note) => note.id === prev.activeNoteId);
      return {
        ...prev,
        notebooks,
        notes,
        tasks: prev.tasks.filter((task) => task.notebookId !== notebookId),
        stickies: prev.stickies.filter((sticky) => sticky.notebookId !== notebookId),
        viewports,
        activeNotebookId:
          prev.activeNotebookId === notebookId ? nextNotebook.id : prev.activeNotebookId,
        activeNoteId: activeNoteStillExists ? prev.activeNoteId : null,
        expandedNotebookIds: prev.expandedNotebookIds.filter((id) => id !== notebookId),
      };
    });
  };

  const deleteNote = (noteId: string) => {
    update((prev) => ({
      ...prev,
      notes: prev.notes.filter((note) => note.id !== noteId),
      activeNoteId: prev.activeNoteId === noteId ? null : prev.activeNoteId,
    }));
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'notebook') deleteNotebook(pendingDelete.id);
    else deleteNote(pendingDelete.id);
    setPendingDelete(null);
  };

  const selectNotebook = (notebookId: string) => {
    update((prev) => ({
      ...prev,
      activeNotebookId: notebookId,
      activeNoteId: null,
      expandedNotebookIds: prev.expandedNotebookIds.includes(notebookId)
        ? prev.expandedNotebookIds
        : [...prev.expandedNotebookIds, notebookId],
    }));
  };

  const toggleNotebook = (notebookId: string) => {
    update((prev) => ({
      ...prev,
      expandedNotebookIds: prev.expandedNotebookIds.includes(notebookId)
        ? prev.expandedNotebookIds.filter((id) => id !== notebookId)
        : [...prev.expandedNotebookIds, notebookId],
    }));
  };

  return (
    <aside
      className="flex h-full min-w-0 flex-col border-r border-border bg-surface"
      aria-label="笔记导航"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          笔记本
        </span>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={addNotebook}
          aria-label="新建笔记本"
          title="新建笔记本"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {state.notebooks.map((notebook) => {
          const expanded = state.expandedNotebookIds.includes(notebook.id);
          const isActive = state.activeNotebookId === notebook.id;
          const notes = notebookNotes(state, notebook.id);
          const todoCount = notebookTodoCount(state, notebook.id);
          const editingNotebook = editing?.kind === 'notebook' && editing.id === notebook.id;

          return (
            <div key={notebook.id} className="mb-1">
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-md px-1 py-1',
                  isActive ? 'bg-surface-secondary' : 'hover:bg-surface-secondary',
                )}
              >
                <button
                  type="button"
                  className="flex h-6 w-5 shrink-0 items-center justify-center text-text-secondary hover:text-text"
                  onClick={() => toggleNotebook(notebook.id)}
                  aria-label={expanded ? '折叠笔记本' : '展开笔记本'}
                >
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
                <NotebookIcon className="h-4 w-4 shrink-0 text-text-secondary" />
                {editingNotebook ? (
                  <input
                    className="min-w-0 flex-1 rounded border border-primary bg-surface px-1.5 py-0.5 text-sm text-text outline-none"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit();
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    aria-label="笔记本名称"
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm text-text"
                    onClick={() => selectNotebook(notebook.id)}
                    onDoubleClick={() => startEdit('notebook', notebook.id, notebook.name)}
                    title={notebook.name}
                  >
                    {notebook.name}
                  </button>
                )}
                <span className="shrink-0 text-xs text-text-secondary">{notes.length}</span>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, 'opacity-0 group-hover:opacity-100')}
                  onClick={() => startEdit('notebook', notebook.id, notebook.name)}
                  aria-label="重命名笔记本"
                  title="重命名笔记本"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className={cn(
                    ICON_BUTTON,
                    'text-error/70 opacity-0 hover:text-error group-hover:opacity-100 disabled:opacity-0',
                  )}
                  onClick={() =>
                    setPendingDelete({ kind: 'notebook', id: notebook.id, name: notebook.name })
                  }
                  disabled={state.notebooks.length <= 1}
                  aria-label="删除笔记本"
                  title={state.notebooks.length <= 1 ? '至少保留一个笔记本' : '删除笔记本'}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {expanded && (
                <div className="mt-1 pl-5">
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm',
                      isActive && state.middleMode === 'tasks'
                        ? 'bg-primary/10 text-primary'
                        : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
                    )}
                    onClick={() =>
                      update((prev) => ({
                        ...prev,
                        activeNotebookId: notebook.id,
                        activeNoteId: null,
                        middleMode: 'tasks',
                      }))
                    }
                  >
                    <ListTodo className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">任务清单</span>
                    {todoCount > 0 && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">
                        {todoCount}
                      </span>
                    )}
                  </button>

                  {notes.map((note) => {
                    const selected = isActive && state.activeNoteId === note.id;
                    const editingNote = editing?.kind === 'note' && editing.id === note.id;
                    return (
                      <div
                        key={note.id}
                        className={cn(
                          'group flex items-center gap-1.5 rounded-md px-2 py-1',
                          selected
                            ? 'bg-primary/10 text-primary'
                            : 'text-text-secondary hover:bg-surface-secondary hover:text-text',
                        )}
                      >
                        <FileText className="h-4 w-4 shrink-0" />
                        {editingNote ? (
                          <input
                            className="min-w-0 flex-1 rounded border border-primary bg-surface px-1.5 py-0.5 text-sm text-text outline-none"
                            value={draft}
                            autoFocus
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            aria-label="笔记标题"
                          />
                        ) : (
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-sm"
                            onClick={() =>
                              update((prev) => ({
                                ...prev,
                                activeNotebookId: notebook.id,
                                activeNoteId: note.id,
                                middleMode: 'notes',
                              }))
                            }
                            onDoubleClick={() => startEdit('note', note.id, note.title)}
                            title={note.title || '无标题笔记'}
                          >
                            {note.title || '无标题笔记'}
                          </button>
                        )}
                        <button
                          type="button"
                          className={cn(ICON_BUTTON, 'opacity-0 group-hover:opacity-100')}
                          onClick={() => startEdit('note', note.id, note.title)}
                          aria-label="重命名笔记"
                          title="重命名笔记"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className={cn(
                            ICON_BUTTON,
                            'text-error/70 opacity-0 hover:text-error group-hover:opacity-100',
                          )}
                          onClick={() =>
                            setPendingDelete({
                              kind: 'note',
                              id: note.id,
                              name: note.title || '无标题笔记',
                            })
                          }
                          aria-label="删除笔记"
                          title="删除笔记"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-secondary hover:bg-surface-secondary hover:text-text"
                    onClick={() => addPage(notebook.id)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新建页面
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'notebook' ? '删除笔记本？' : '删除笔记？'}
        message={
          pendingDelete ? `「${pendingDelete.name}」及其内容将被删除，此操作不可撤销。` : undefined
        }
        onDismiss={() => setPendingDelete(null)}
        actions={[
          { label: '取消', onClick: () => setPendingDelete(null), variant: 'secondary' },
          { label: '删除', onClick: confirmDelete, variant: 'danger' },
        ]}
      />
    </aside>
  );
}
