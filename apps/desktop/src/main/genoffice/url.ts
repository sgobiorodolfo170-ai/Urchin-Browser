/**
 * GenOffice 编辑器标签伪地址（纯函数，可单测）
 *
 * 阶段 2：GenOffice 编辑器以 WebContentsView 形式挂在 Urchin 标签体系下，
 * 标签 URL 使用 `urchin://genoffice/?kind=<app>&path=<绝对路径>` 伪地址——
 * 该地址不会被任何视图导航（编辑器页面由 genoffice-app:// 协议加载），
 * 仅用于标签快照的可序列化标识与路由判定（与 urchin://file-viewer 同思路）。
 */

/** 伪地址前缀（协议 + host）。 */
export const GENOFFICE_URL_PREFIX = 'urchin://genoffice';

/** 解析结果：编辑器类型 + 文件绝对路径。 */
export interface GenOfficeTarget {
  readonly kind: string;
  readonly path: string;
}

/** 构造 GenOffice 编辑器标签伪地址。 */
export function buildGenOfficeUrl(kind: string, filePath: string): string {
  return `${GENOFFICE_URL_PREFIX}/?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(filePath)}`;
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
  return `urchin://file-viewer/?path=${encodeURIComponent(filePath)}`;
}

/**
 * HTML 保底地址：file:// 直开（与融合前的既有行为一致；HTML 经查看器内嵌
 * iframe 相对资源解析有问题，故不进查看器）。
 */
export function buildFileUrl(filePath: string): string {
  return `file:///${encodeURI(filePath.replace(/\\/g, '/'))}`;
}
