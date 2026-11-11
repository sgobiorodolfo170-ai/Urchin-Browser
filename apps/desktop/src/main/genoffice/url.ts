/**
 * GenOffice 编辑器标签伪地址（纯函数，可单测）
 *
 * 阶段 2：GenOffice 编辑器以 WebContentsView 形式挂在 Urchin 标签体系下，
 * 标签 URL 使用 `urchin://genoffice/?kind=<app>&path=<绝对路径>` 伪地址——
 * 该地址不会被任何视图导航（编辑器页面由 genoffice-app:// 协议加载），
 * 仅用于标签快照的可序列化标识与路由判定（与 urchin://file-viewer 同思路）。
 */
import { pathToFileURL } from 'node:url';
import {
  buildFileViewerUrl as buildFileViewerUrlShared,
  buildGenOfficeUrl as buildGenOfficeUrlShared,
} from '../../shared/file-routing';

/** 伪地址前缀（协议 + host）。 */
export const GENOFFICE_URL_PREFIX = 'urchin://genoffice';

/** 解析结果：编辑器类型 + 文件绝对路径。 */
export interface GenOfficeTarget {
  readonly kind: string;
  readonly path: string;
}

/**
 * 构造 GenOffice 编辑器标签伪地址。
 *
 * 实际拼接在 `shared/file-routing.ts`（路由单一真源，渲染层也用它），
 * 此处仅保留既有导出名，避免调用点与单测大范围改名。
 */
export function buildGenOfficeUrl(kind: string, filePath: string): string {
  return buildGenOfficeUrlShared(kind, filePath);
}

/** 解析伪地址；非 GenOffice 地址或参数缺失返回 null（不抛异常）。 */
export function parseGenOfficeUrl(url: string): GenOfficeTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'urchin:' || parsed.hostname !== 'genoffice') return null;
    const kind = parsed.searchParams.get('kind');
    const path = parsed.searchParams.get('path');
    if (!kind || !path) return null;
    return { kind, path };
  } catch {
    return null;
  }
}

/** GenOffice 产物缺失时的保底地址：Urchin 内置文件查看器（用户既定策略）。 */
export function buildFileViewerUrl(filePath: string): string {
  return buildFileViewerUrlShared(filePath);
}

/**
 * HTML 保底地址：file:// 直开（与融合前的既有行为一致；HTML 经查看器内嵌
 * iframe 相对资源解析有问题，故不进查看器）。
 *
 * 用 pathToFileURL 而非 encodeURI 手工拼接：encodeURI 不转义 `#` / `?`，
 * 文件名含这两个字符时 URL 会被截断（Chromium 打开错误路径）。
 */
export function buildFileUrl(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

/**
 * 降级改写（URCHIN_DISABLE_GENOFFICE=1 或集成缺省时由 tab.create 调用）：
 * 带路径的 GenOffice 伪地址 → 内置查看器地址；其余地址原样返回。
 * 纯函数，便于单测；避免降级模式下「打开文件」落到无法渲染的伪地址。
 */
export function fallbackGenOfficeUrl(url: string): string {
  const target = parseGenOfficeUrl(url);
  if (!target) return url;
  return target.kind === 'html' ? buildFileUrl(target.path) : buildFileViewerUrl(target.path);
}
