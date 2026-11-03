/**
 * 中转区 · 类型定义
 *
 * 中转区是左侧栏（折叠按钮下方）的临时内容暂存区，存放的是文件索引（不改变
 * 文件原位置）。支持多种来源拖入（OS 文件、网页选中文字、截图、视频、链接）
 * 与拖出到多个目标（pi 输入框、笔记、genoffice、邮箱、主页常用标签、网页区）。
 *
 * 持久化：items 数组整体写入 settings 键 `transit.items`（与 notebook.state 同模式）。
 * 启动时校验 filePath 指向的文件是否仍存在，不存在则标 missing。
 */

/** 中转区项目类型 */
export type TransitItemKind = 'file' | 'text' | 'screenshot' | 'video' | 'link';

/** 中转区项目（文件索引，不复制原文件） */
export interface TransitItem {
  readonly id: string;
  readonly kind: TransitItemKind;
  /** 显示名：文件名 / 域名 / 文本前 20 字 / 时间戳 */
  readonly title: string;
  /** file / screenshot：原文件绝对路径（索引，不复制） */
  readonly filePath?: string;
  /** video / link：网址 */
  readonly url?: string;
  /** text：完整文本内容 */
  readonly text?: string;
  /** text：生成的 md 文档路径（documents/ 下，若由网页选中文字拖入生成） */
  readonly mdDocPath?: string;
  /** file：MIME 类型（影响图标） */
  readonly mimeType?: string;
  /** file：文件大小（字节） */
  readonly sizeBytes?: number;
  /** screenshot / video：缩略图 dataURI（可选，用于展示） */
  readonly thumbnailDataUri?: string;
  /** 来源标识 */
  readonly sourceApp?: 'browser' | 'desktop' | 'explorer' | 'webview';
  /** 拖入时间戳 */
  readonly addedAt: number;
  /** 启动校验：原文件已不存在 */
  readonly missing?: boolean;
}

/** 持久化设置键 */
export const TRANSIT_ITEMS_KEY = 'transit.items';

/** 拖拽传递的自定义 MIME 类型（中转区项目拖出时使用） */
export const TRANSIT_DRAG_MIME = 'application/x-urchin-transit';

/** 标题最大长度（超出截断加省略号） */
export const TRANSIT_TITLE_MAX = 40;

/** 文本类项目保存的文本最大长度（防御异常大值） */
export const TRANSIT_TEXT_MAX = 500_000;

/** items 数组最大容量（防止无限增长） */
export const TRANSIT_ITEMS_MAX = 200;

/** 从任意值归一化为 TransitItem（持久化加载时校验） */
export function normalizeItem(raw: unknown): TransitItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (
    kind !== 'file' &&
    kind !== 'text' &&
    kind !== 'screenshot' &&
    kind !== 'video' &&
    kind !== 'link'
  ) {
    return null;
  }
  const id = typeof obj.id === 'string' ? obj.id : '';
  const title = typeof obj.title === 'string' ? obj.title : '';
  const addedAt = typeof obj.addedAt === 'number' ? obj.addedAt : Date.now();
  if (!id || !title) return null;

  const filePath = typeof obj.filePath === 'string' ? obj.filePath : undefined;
  const url = typeof obj.url === 'string' ? obj.url : undefined;
  const textRaw = typeof obj.text === 'string' ? obj.text : undefined;
  const text = textRaw ? textRaw.slice(0, TRANSIT_TEXT_MAX) : undefined;
  const mdDocPath = typeof obj.mdDocPath === 'string' ? obj.mdDocPath : undefined;
  const mimeType = typeof obj.mimeType === 'string' ? obj.mimeType : undefined;
  const sizeBytes = typeof obj.sizeBytes === 'number' ? obj.sizeBytes : undefined;
  const thumbnailDataUri =
    typeof obj.thumbnailDataUri === 'string' ? obj.thumbnailDataUri : undefined;
  const sourceAppRaw = obj.sourceApp;
  const sourceApp =
    sourceAppRaw === 'browser' ||
    sourceAppRaw === 'desktop' ||
    sourceAppRaw === 'explorer' ||
    sourceAppRaw === 'webview'
      ? sourceAppRaw
      : undefined;
  const missing = obj.missing === true ? true : undefined;

  const item: TransitItem = {
    id,
    kind,
    title: title.slice(0, TRANSIT_TITLE_MAX + 10),
    addedAt,
    ...(filePath ? { filePath } : {}),
    ...(url ? { url } : {}),
    ...(text ? { text } : {}),
    ...(mdDocPath ? { mdDocPath } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(thumbnailDataUri ? { thumbnailDataUri } : {}),
    ...(sourceApp ? { sourceApp } : {}),
    ...(missing ? { missing } : {}),
  };
  return item;
}

/** 归一化 items 数组（过滤无效项，限制容量） */
export function normalizeItems(raw: unknown): readonly TransitItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TransitItem[] = [];
  for (const entry of raw) {
    const item = normalizeItem(entry);
    if (item) items.push(item);
    if (items.length >= TRANSIT_ITEMS_MAX) break;
  }
  return items;
}

/** 生成唯一 id（优先 crypto.randomUUID） */
export function makeTransitId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return `transit-${cryptoApi.randomUUID()}`;
  return `transit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 截断标题并加省略号 */
export function truncateTitle(title: string, max = TRANSIT_TITLE_MAX): string {
  if (title.length <= max) return title;
  return title.slice(0, max) + '…';
}
