/**
 * 笔记页 · 中区（笔记 / 任务清单）
 *
 * 右上角分段按钮在两种模式间切换：
 * - 笔记：列表 → 单篇全屏编辑（左上角返回列表）
 * - 任务清单：当前笔记本的待办列表
 */
import { useState } from 'react';
import { ArrowLeft, Check, ListTodo, NotebookPen, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { cn } from '../lib/utils';
import { makeNotebookId } from './normalize';
import { parseTransitDrag } from '../transit/drag-utils';
import type { NotePage, NotebookMeta, NotebookState, TaskItem } from './types';

export interface NotesTasksPaneProps {
  readonly state: NotebookState;
  readonly notebook: NotebookMeta;
  readonly update: (updater: (prev: NotebookState) => NotebookState) => void;
}

const ICON_BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-secondary hover:text-text';

function notesOf(state: NotebookState, notebookId: string): NotePage[] {
  return state.notes
    .filter((note) => note.notebookId === notebookId)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function tasksOf(state: NotebookState, notebookId: string): TaskItem[] {
  return state.tasks
    .filter((task) => task.notebookId === notebookId)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
}

function previewOf(note: NotePage): string {
  const text = note.content.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function NotesTasksPane({ state, notebook, update }: NotesTasksPaneProps) {
  const [taskDraft, setTaskDraft] = useState('');
  const [pendingDeleteNote, setPendingDeleteNote] = useState<NotePage | null>(null);

  const notes = notesOf(state, notebook.id);
  const tasks = tasksOf(state, notebook.id);
  const activeNote = notes.find((note) => note.id === state.activeNoteId) ?? null;
  const mode = state.middleMode;

  const setMode = (middleMode: NotebookState['middleMode']) => {
    update((prev) => ({ ...prev, middleMode }));
  };

  const addNote = () => {
    const now = Date.now();
    const note: NotePage = {
      id: makeNotebookId('note'),
      notebookId: notebook.id,
      title: '',
      content: '',
      createdAt: now,
      updatedAt: now,
    };
    update((prev) => ({
      ...prev,
      notes: [...prev.notes, note],
      activeNoteId: note.id,
      middleMode: 'notes',
    }));
  };

  const updateNote = (noteId: string, patch: Partial<Pick<NotePage, 'title' | 'content'>>) => {
    update((prev) => ({
      ...prev,
      notes: prev.notes.map((note) =>
        note.id === noteId ? { ...note, ...patch, updatedAt: Date.now() } : note,
      ),
    }));
  };

  const deleteNote = (noteId: string) => {
    update((prev) => ({
      ...prev,
      notes: prev.notes.filter((note) => note.id !== noteId),
      activeNoteId: prev.activeNoteId === noteId ? null : prev.activeNoteId,
    }));
  };

  const addTask = () => {
    const text = taskDraft.trim();
    if (!text) return;
    const task: TaskItem = {
      id: makeNotebookId('task'),
      notebookId: notebook.id,
      text: text.slice(0, 2000),
      done: false,
      createdAt: Date.now(),
    };
    update((prev) => ({ ...prev, tasks: [...prev.tasks, task] }));
    setTaskDraft('');
  };

  const toggleTask = (taskId: string) => {
    update((prev) => ({
      ...prev,
      tasks: prev.tasks.map((task) => (task.id === taskId ? { ...task, done: !task.done } : task)),
    }));
  };

  const deleteTask = (taskId: string) => {
    update((prev) => ({ ...prev, tasks: prev.tasks.filter((task) => task.id !== taskId) }));
  };

  /** 中转区拖入：任务模式→新建任务，笔记模式→新建笔记 */
  const handleTransitDrop = (e: React.DragEvent) => {
    const transitItem = parseTransitDrag(e.dataTransfer);
    if (!transitItem) return;
    e.preventDefault();
    const content =
      transitItem.text ?? transitItem.url ?? transitItem.filePath ?? transitItem.title;
    if (mode === 'tasks') {
      const task: TaskItem = {
        id: makeNotebookId('task'),
        notebookId: notebook.id,
        text: content.slice(0, 2000),
        done: false,
        createdAt: Date.now(),
      };
      update((prev) => ({ ...prev, tasks: [...prev.tasks, task] }));
    } else {
      const now = Date.now();
      const note: NotePage = {
        id: makeNotebookId('note'),
        notebookId: notebook.id,
        title: transitItem.title.slice(0, 200),
        content: content.slice(0, 200000),
        createdAt: now,
        updatedAt: now,
      };
      update((prev) => ({
        ...prev,
        notes: [...prev.notes, note],
        activeNoteId: note.id,
      }));
    }
  };

  return (
    <section
      className="flex h-full min-w-0 flex-col bg-surface"
      aria-label="笔记内容"
      onDrop={handleTransitDrop}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-urchin-transit')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {activeNote && mode === 'notes' && (
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => update((prev) => ({ ...prev, activeNoteId: null }))}
              aria-label="返回笔记列表"
              title="返回笔记列表"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <span className="min-w-0 truncate text-sm font-medium text-text">
            {activeNote && mode === 'notes'
              ? activeNote.title || '无标题笔记'
              : mode === 'notes'
                ? '笔记'
                : '任务清单'}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center rounded-md border border-border bg-surface-secondary p-0.5">
            <button
              type="button"
              className={cn(
                'flex h-6 w-7 items-center justify-center rounded',
                mode === 'notes'
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => setMode('notes')}
              aria-label="切换到笔记"
              aria-pressed={mode === 'notes'}
              title="笔记"
            >
              <NotebookPen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                'flex h-6 w-7 items-center justify-center rounded',
                mode === 'tasks'
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text',
              )}
              onClick={() => setMode('tasks')}
              aria-label="切换到任务清单"
              aria-pressed={mode === 'tasks'}
              title="任务清单"
            >
              <ListTodo className="h-3.5 w-3.5" />
            </button>
          </div>

          {mode === 'notes' && !activeNote && (
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={addNote}
              aria-label="新建笔记"
              title="新建笔记"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          {mode === 'notes' && activeNote && (
            <button
              type="button"
              className={cn(ICON_BUTTON, 'text-error/70 hover:text-error')}
              onClick={() => setPendingDeleteNote(activeNote)}
              aria-label="删除当前笔记"
              title="删除当前笔记"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {mode === 'notes' ? (
        activeNote ? (
          <NoteEditor
            key={activeNote.id}
            note={activeNote}
            onChange={(patch) => updateNote(activeNote.id, patch)}
          />
        ) : (
          <div className="flex-1 overflow-y-auto p-2">
            {notes.length === 0 ? (
              <EmptyHint text="还没有笔记，点击右上角 + 新建一篇。" />
            ) : (
              notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData(
                      'text/plain',
                      `${note.title || '无标题笔记'}\n\n${note.content}`,
                    );
                  }}
                  className="mb-1 block w-full cursor-grab rounded-md border border-transparent px-3 py-2 text-left hover:border-border hover:bg-surface-secondary"
                  onClick={() =>
                    update((prev) => ({
                      ...prev,
                      activeNoteId: note.id,
                      middleMode: 'notes',
                    }))
                  }
                >
                  <div className="truncate text-sm font-medium text-text">
                    {note.title || '无标题笔记'}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-text-secondary">
                    {previewOf(note) || '空白笔记'}
                  </div>
                </button>
              ))
            )}
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border p-2">
            <input
              className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-text outline-none focus:border-primary"
              placeholder="添加任务后按 Enter"
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTask();
                }
              }}
              aria-label="新任务"
            />
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {tasks.length === 0 ? (
              <EmptyHint text="暂无任务，在上方输入框添加。" />
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', task.text);
                  }}
                  className="group flex cursor-grab items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-secondary"
                >
                  <button
                    type="button"
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      task.done
                        ? 'border-primary bg-primary text-white'
                        : 'border-border text-transparent hover:border-primary',
                    )}
                    onClick={() => toggleTask(task.id)}
                    aria-label={task.done ? '标记为未完成' : '标记为已完成'}
                    aria-pressed={task.done}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <span
                    className={cn(
                      'min-w-0 flex-1 break-words text-sm',
                      task.done ? 'text-text-secondary line-through' : 'text-text',
                    )}
                  >
                    {task.text}
                  </span>
                  <button
                    type="button"
                    className={cn(
                      ICON_BUTTON,
                      'h-6 w-6 text-error/70 opacity-0 hover:text-error group-hover:opacity-100',
                    )}
                    onClick={() => deleteTask(task.id)}
                    aria-label="删除任务"
                    title="删除任务"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteNote !== null}
        title="删除笔记？"
        message={
          pendingDeleteNote
            ? `「${pendingDeleteNote.title || '无标题笔记'}」将被删除，此操作不可撤销。`
            : undefined
        }
        onDismiss={() => setPendingDeleteNote(null)}
        actions={[
          { label: '取消', onClick: () => setPendingDeleteNote(null), variant: 'secondary' },
          {
            label: '删除',
            variant: 'danger',
            onClick: () => {
              if (pendingDeleteNote) deleteNote(pendingDeleteNote.id);
              setPendingDeleteNote(null);
            },
          },
        ]}
      />
    </section>
  );
}

function NoteEditor({
  note,
  onChange,
}: {
  readonly note: NotePage;
  readonly onChange: (patch: Partial<Pick<NotePage, 'title' | 'content'>>) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input
        className="border-b border-border bg-transparent px-4 py-3 text-lg font-medium text-text outline-none"
        placeholder="笔记标题"
        value={note.title}
        autoFocus
        onChange={(e) => onChange({ title: e.target.value })}
        aria-label="笔记标题"
      />
      <textarea
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-text outline-none"
        placeholder="开始记录…"
        value={note.content}
        onChange={(e) => onChange({ content: e.target.value })}
        aria-label="笔记正文"
      />
    </div>
  );
}

function EmptyHint({ text }: { readonly text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-text-secondary">
      {text}
    </div>
  );
}
