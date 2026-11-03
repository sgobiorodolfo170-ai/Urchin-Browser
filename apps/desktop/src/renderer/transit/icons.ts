/**
 * 中转区 · 类型 → 图标映射
 *
 * 根据 TransitItemKind 与 mimeType 选择合适的 lucide-react 图标。
 */
import {
  FileText,
  Image as ImageIcon,
  Video,
  Link as LinkIcon,
  StickyNote,
  Music,
  File as FileIcon,
  type LucideIcon,
} from 'lucide-react';
import type { TransitItem, TransitItemKind } from './types';

/** 按 kind 选择基础图标 */
const KIND_ICONS: Record<TransitItemKind, LucideIcon> = {
  file: FileIcon,
  text: StickyNote,
  screenshot: ImageIcon,
  video: Video,
  link: LinkIcon,
};

/** 根据 mimeType 细分 file 类型的图标（无匹配回落 FileIcon） */
function fileIconByMime(mimeType?: string): LucideIcon {
  if (!mimeType) return FileIcon;
  if (mimeType.startsWith('image/')) return ImageIcon;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.startsWith('text/')) return FileText;
  return FileIcon;
}

/** 获取项目对应图标 */
export function getTransitItemIcon(item: TransitItem): LucideIcon {
  if (item.kind === 'file') return fileIconByMime(item.mimeType);
  return KIND_ICONS[item.kind] ?? FileIcon;
}
