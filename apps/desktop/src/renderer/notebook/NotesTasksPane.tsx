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
import { NoteEditor } from './NoteEditor';
import { parseTransitDrag } from '../transit/drag-utils';
import type { NotePage, NotebookMeta, NotebookState, TaskItem } from './types';

export interface NotesTasksPaneProps {
  readonly state: NotebookState;
  readonly notebook: NotebookMeta;
  readonly update: (updater: (prev: NotebookState) => NotebookState) => void;
}

const ICON_BUTTON =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

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
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface"
      aria-label="笔记内容"
      onDrop={handleTransitDrop}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-urchin-transit')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
    >
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-secondary/30 px-4 py-3">
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
          {!(activeNote && mode === 'notes') && (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {mode === 'notes' ? (
                <NotebookPen className="h-4 w-4" />
              ) : (
                <ListTodo className="h-4 w-4" />
              )}
            </span>
          )}
          <span className="min-w-0 truncate text-sm font-semibold text-text">
            {activeNote && mode === 'notes'
              ? activeNote.title || '无标题笔记'
              : mode === 'notes'
                ? '笔记'
                : '任务清单'}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center gap-1 rounded-xl border border-border bg-surface-secondary p-1">
            <button
              type="button"
              className={cn(
                'flex h-7 w-8 items-center justify-center rounded-lg transition-colors',
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
                'flex h-7 w-8 items-center justify-center rounded-lg transition-colors',
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
          <div className="min-h-0 flex-1 overflow-y-auto bg-surface-secondary/20 p-3">
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
                  className="mb-3 block w-full cursor-grab rounded-xl border border-border bg-surface px-4 py-4 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
                  <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                    {previewOf(note) || '空白笔记'}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[10px] text-text-secondary">
                    <span>笔记</span>
                    <time dateTime={new Date(note.updatedAt).toISOString()}>
                      {new Date(note.updatedAt).toLocaleDateString('zh-CN', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                  </div>
                </button>
              ))
            )}
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border p-3">
            <div className="mb-3 flex items-center justify-between text-xs text-text-secondary">
              <span>完成进度</span>
              <span className="tabular-nums">
                {tasks.filter((task) => task.done).length} / {tasks.length}
              </span>
            </div>
            <progress
              aria-label="任务完成进度"
              className="mb-3 block h-1.5 w-full overflow-hidden rounded-full accent-primary [&::-webkit-progress-bar]:bg-surface-secondary [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
              max={tasks.length || 1}
              value={tasks.filter((task) => task.done).length}
            />
            <input
              className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-text shadow-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
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
          <div className="min-h-0 flex-1 overflow-y-auto bg-surface-secondary/20 p-3">
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
                  className="group mb-2 flex cursor-grab items-start gap-3 rounded-xl border border-border bg-surface px-3 py-3 shadow-sm transition-colors hover:border-primary/30"
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
                      'h-6 w-6 text-error/70 opacity-0 hover:text-error group-hover:opacity-100 group-focus-within:opacity-100',
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

function EmptyHint({ text }: { readonly text: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 py-8 text-center text-xs leading-relaxed text-text-secondary">
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
        <NotebookPen className="h-6 w-6" />
      </span>
      {text}
    </div>
  );
}
