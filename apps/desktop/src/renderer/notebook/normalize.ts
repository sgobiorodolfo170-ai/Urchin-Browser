/**
 * 笔记 / 便利贴模块 · 状态规范化
 *
 * 职责：把 settings 中读到的未知值防御性还原为 NotebookState。
 * 设计理由：
 * - settings 值是 unknown，可能来自旧版本 / 手工修改 / 损坏记录；直接信任会导致
 *   渲染层在 `notes.find` 等位置抛错，故统一在这里做一次边界收敛。
 * - 规范化为纯函数，便于单测覆盖脏数据与版本迁移，不依赖 Electron。
 */
import {
  DEFAULT_CANVAS_VIEWPORT,
  NOTEBOOK_STATE_VERSION,
  NOTEBOOK_TEXT_MAX,
  type CanvasViewport,
  type NotePage,
  type NotebookLayout,
  type NotebookMeta,
  type NotebookState,
  type StickyColor,
  type StickyNote,
  type TaskItem,
} from './types';

const STICKY_COLORS: readonly StickyColor[] = ['amber', 'pink', 'sky', 'emerald', 'violet'];
const MAX_TEXT = NOTEBOOK_TEXT_MAX;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : fallback;
}

function asFinite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asPositive(value: unknown, fallback: number): number {
  const n = asFinite(value, fallback);
  return n > 0 ? n : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  return Math.trunc(asFinite(value, fallback));
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 生成唯一 id（优先 crypto.randomUUID；测试/旧环境回落随机串） */
export function makeNotebookId(prefix: string): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 创建一个默认笔记本（用于首次运行 / 记录损坏兜底） */
export function createDefaultNotebook(now = Date.now()): NotebookMeta {
  return { id: makeNotebookId('nb'), name: '我的笔记本', createdAt: now };
}

/**
 * 首次运行种子：一个笔记本 + 一篇欢迎笔记。
 * 欢迎笔记只是普通 NotePage，用户可删除，不参与任何特殊逻辑。
 */
export function createDefaultState(now = Date.now()): NotebookState {
  const notebook = createDefaultNotebook(now);
  const note: NotePage = {
    id: makeNotebookId('note'),
    notebookId: notebook.id,
    title: '欢迎使用笔记',
    content: [
      '这里可以记录零散想法、任务清单与便利贴。',
      '',
      '· 左区：笔记本 → 页面树，可新建 / 重命名 / 删除',
      '· 中区：右上角切换「笔记 / 任务清单」',
      '· 右区：无限画布；双击空白、点击 + 或 Ctrl+V 粘贴文本即可添加便利贴',
      '',
      '提示：拖动三区之间的分割线可自由调整宽度，位置会自动保存。',
    ].join('\n'),
    createdAt: now,
    updatedAt: now,
  };
  return {
    version: NOTEBOOK_STATE_VERSION,
    notebooks: [notebook],
    notes: [note],
    tasks: [],
    stickies: [],
    activeNotebookId: notebook.id,
    activeNoteId: null,
    middleMode: 'notes',
    expandedNotebookIds: [notebook.id],
    viewports: {},
    layout: null,
  };
}

/** 规范化 viewports：只保留仍存在的笔记本，数值收敛到合理范围 */
function normalizeViewports(
  raw: unknown,
  notebookIds: ReadonlySet<string>,
): Record<string, CanvasViewport> {
  const result: Record<string, CanvasViewport> = {};
  if (!isRecord(raw)) return result;
  for (const [id, value] of Object.entries(raw)) {
    if (!notebookIds.has(id) || !isRecord(value)) continue;
    result[id] = {
      panX: asFinite(value.panX, DEFAULT_CANVAS_VIEWPORT.panX),
      panY: asFinite(value.panY, DEFAULT_CANVAS_VIEWPORT.panY),
      zoom: clamp(asFinite(value.zoom, DEFAULT_CANVAS_VIEWPORT.zoom), 0.25, 2.5),
    };
  }
  return result;
}

/** 规范化 layout：三值必须为正数，归一化为比例（和为 1）；否则返回 null（回落到 1:2:2） */
function normalizeLayout(raw: unknown): NotebookLayout | null {
  if (!isRecord(raw)) return null;
  const left = asFinite(raw.left, 0);
  const middle = asFinite(raw.middle, 0);
  const right = asFinite(raw.right, 0);
  if (left <= 0 || middle <= 0 || right <= 0) return null;
  const sum = left + middle + right;
  return {
    left: left / sum,
    middle: middle / sum,
    right: right / sum,
    custom: asBoolean(raw.custom, true),
  };
}

/**
 * 把任意 settings 值还原为可用状态。
 *
 * 处理顺序：
 * 1. 笔记本列表去重；为空则种子默认笔记本
 * 2. 页面/任务/便利贴只保留挂在有效笔记本上的条目，并去重
 * 3. active / expanded / viewports / layout 收敛到当前有效集合
 */
export function normalizeNotebookState(raw: unknown, now = Date.now()): NotebookState {
  const obj = isRecord(raw) ? raw : {};
  const fallback = createDefaultState(now);

  // 1. 笔记本
  const notebooks: NotebookMeta[] = [];
  const notebookIds = new Set<string>();
  const rawNotebooks = Array.isArray(obj.notebooks) ? obj.notebooks : [];
  for (const item of rawNotebooks) {
    if (!isRecord(item)) continue;
    const id = asString(item.id).trim();
    if (!id || notebookIds.has(id)) continue;
    notebookIds.add(id);
    notebooks.push({
      id,
      name: asString(item.name).trim() || '未命名笔记本',
      createdAt: asInt(item.createdAt, now),
    });
  }
  let seededDefault = false;
  if (notebooks.length === 0) {
    seededDefault = true;
    notebooks.push(...fallback.notebooks);
    notebookIds.add(fallback.notebooks[0]!.id);
  }
  const firstNotebook = notebooks[0]!;

  // 2. 笔记页
  const notes: NotePage[] = [];
  const noteIds = new Set<string>();
  const rawNotes = Array.isArray(obj.notes) ? obj.notes : [];
  for (const item of rawNotes) {
    if (!isRecord(item)) continue;
    const id = asString(item.id).trim();
    const notebookId = asString(item.notebookId).trim();
    if (!id || noteIds.has(id) || !notebookIds.has(notebookId)) continue;
    noteIds.add(id);
    const createdAt = asInt(item.createdAt, now);
    notes.push({
      id,
      notebookId,
      title: asString(item.title),
      content: asString(item.content),
      createdAt,
      updatedAt: asInt(item.updatedAt, createdAt),
    });
  }
  // 首次运行 / 记录损坏时，除默认笔记本外补一篇欢迎笔记（与 createDefaultState 一致）
  if (seededDefault && notes.length === 0) {
    for (const note of fallback.notes) {
      if (noteIds.has(note.id)) continue;
      noteIds.add(note.id);
      notes.push(note);
    }
  }

  // 任务项
  const tasks: TaskItem[] = [];
  const taskIds = new Set<string>();
  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : [];
  for (const item of rawTasks) {
    if (!isRecord(item)) continue;
    const id = asString(item.id).trim();
    const notebookId = asString(item.notebookId).trim();
    const text = asString(item.text).trim();
    if (!id || taskIds.has(id) || !notebookIds.has(notebookId) || !text) continue;
    taskIds.add(id);
    tasks.push({
      id,
      notebookId,
      text: text.slice(0, 2000),
      done: asBoolean(item.done, false),
      createdAt: asInt(item.createdAt, now),
    });
  }

  // 便利贴
  const stickies: StickyNote[] = [];
  const stickyIds = new Set<string>();
  const rawStickies = Array.isArray(obj.stickies) ? obj.stickies : [];
  for (const item of rawStickies) {
    if (!isRecord(item)) continue;
    const id = asString(item.id).trim();
    const notebookId = asString(item.notebookId).trim();
    if (!id || stickyIds.has(id) || !notebookIds.has(notebookId)) continue;
    stickyIds.add(id);
    const color = asString(item.color, 'amber');
    const createdAt = asInt(item.createdAt, now);
    stickies.push({
      id,
      notebookId,
      text: asString(item.text),
      x: asFinite(item.x, 0),
      y: asFinite(item.y, 0),
      width: clamp(asPositive(item.width, 220), 120, 1200),
      height: clamp(asPositive(item.height, 160), 80, 1200),
      color: STICKY_COLORS.includes(color as StickyColor) ? (color as StickyColor) : 'amber',
      createdAt,
      updatedAt: asInt(item.updatedAt, createdAt),
      ...(typeof item.imagePath === 'string' && item.imagePath
        ? { imagePath: item.imagePath }
        : {}),
    });
  }

  // 3. UI 选择状态
  const activeNotebookId = notebookIds.has(asString(obj.activeNotebookId))
    ? asString(obj.activeNotebookId)
    : firstNotebook.id;
  const rawActiveNote = asString(obj.activeNoteId);
  const activeNote = notes.find((n) => n.id === rawActiveNote && n.notebookId === activeNotebookId);
  const middleMode =
    obj.middleMode === 'tasks' || obj.middleMode === 'notes' ? obj.middleMode : 'notes';

  const expanded: string[] = [];
  const expandedSet = new Set<string>();
  const rawExpanded = Array.isArray(obj.expandedNotebookIds) ? obj.expandedNotebookIds : [];
  for (const item of rawExpanded) {
    const id = asString(item);
    if (notebookIds.has(id) && !expandedSet.has(id)) {
      expandedSet.add(id);
      expanded.push(id);
    }
  }
  if (!expandedSet.has(activeNotebookId)) expanded.push(activeNotebookId);

  return {
    version: NOTEBOOK_STATE_VERSION,
    notebooks,
    notes,
    tasks,
    stickies,
    activeNotebookId,
    activeNoteId: activeNote?.id ?? null,
    middleMode,
    expandedNotebookIds: expanded,
    viewports: normalizeViewports(obj.viewports, notebookIds),
    layout: normalizeLayout(obj.layout),
  };
}
