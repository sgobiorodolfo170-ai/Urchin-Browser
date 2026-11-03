/**
 * 笔记 / 便利贴模块 · 类型定义（M27，urchin://notebook）
 *
 * 数据模型分三层：
 * - 笔记本（NotebookMeta）：左区页面树的根节点
 * - 页面（NotePage）：笔记本下的笔记页；任务清单为每笔记本固定视图，不单独建页面
 * - 便利贴（StickyNote）：右区无限画布上的绝对定位卡片
 *
 * 持久化：整体作为一个版本化 JSON 写入 settings 键 `notebook.state`，
 * 与右侧栏宽度等 UI 状态使用同一套 settings.* IPC，不新增 IPC 通道。
 */

/** 中区视图模式：笔记 / 任务清单互相切换 */
export type NotebookMiddleMode = 'notes' | 'tasks';

/** 便利贴颜色（与 StickyCanvas 的静态 Tailwind class 映射一一对应） */
export type StickyColor = 'amber' | 'pink' | 'sky' | 'emerald' | 'violet';

/** 笔记本元数据 */
export interface NotebookMeta {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

/** 笔记页面 */
export interface NotePage {
  readonly id: string;
  readonly notebookId: string;
  readonly title: string;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 任务项（每个笔记本一份任务清单） */
export interface TaskItem {
  readonly id: string;
  readonly notebookId: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
}

/** 无限画布便利贴：x/y 为世界坐标，与视口平移/缩放解耦 */
export interface StickyNote {
  readonly id: string;
  readonly notebookId: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: StickyColor;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 图片便利贴：本地图片文件绝对路径（有值时渲染 <img> 代替 <textarea>） */
  readonly imagePath?: string;
}

/** 每个笔记本独立保存的画布视口 */
export interface CanvasViewport {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

/**
 * 三区分割位置（持久化的是比例，left/middle/right 归一化到和为 1）。
 * 渲染时乘以容器可用宽度得到像素，确保三区始终铺满并随窗口自动伸缩。
 * custom=true 表示用户已手动拖拽过。
 */
export interface NotebookLayout {
  readonly left: number;
  readonly middle: number;
  readonly right: number;
  readonly custom: boolean;
}

/** 笔记页完整持久化状态 */
export interface NotebookState {
  readonly version: number;
  readonly notebooks: readonly NotebookMeta[];
  readonly notes: readonly NotePage[];
  readonly tasks: readonly TaskItem[];
  readonly stickies: readonly StickyNote[];
  readonly activeNotebookId: string;
  readonly activeNoteId: string | null;
  readonly middleMode: NotebookMiddleMode;
  readonly expandedNotebookIds: readonly string[];
  /** notebookId → 视口；缺省使用 DEFAULT_CANVAS_VIEWPORT */
  readonly viewports: Readonly<Record<string, CanvasViewport>>;
  /** 三区分割位置；null = 尚未手动拖拽，按 1:2:2 动态计算 */
  readonly layout: NotebookLayout | null;
}

/** 默认画布视口（原点居中区域由组件在首次渲染时决定，这里用 0/0/1 即可） */
export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = {
  panX: 0,
  panY: 0,
  zoom: 1,
};

/** 持久化设置键（单一真源，主进程 DEFAULT_SETTINGS 同步登记） */
export const NOTEBOOK_STATE_KEY = 'notebook.state';

/** 当前状态版本（未来 schema 演进时据此迁移） */
export const NOTEBOOK_STATE_VERSION = 1;

/** 笔记/便利贴文本长度上限（防御异常大值，避免 settings 值失控） */
export const NOTEBOOK_TEXT_MAX = 200_000;
