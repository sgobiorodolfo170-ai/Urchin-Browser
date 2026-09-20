/**
 * GenOffice 嵌入产物路径解析（阶段 1/2）
 *
 * 产物由 `scripts/genoffice-build.mjs` 生成（vendor/genoffice 内构建）：
 * - 开发态：vendor/genoffice/apps/{urchin-embed,<app>}/out/**
 * - 打包态：electron-builder extraResources → resources/genoffice/**
 *   （embed 统一改名 embed/index.js；各编辑器产物去掉 out/ 层）
 *
 * 任一 kind 的 renderer/preload 缺失时该 kind 不进入可用清单——宿主据此
 * 回落到 Urchin 内置查看器（用户策略：GenOffice 为主，Urchin 保底）。
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 当前支持的编辑器类型（阶段 4 全量：md / pdf / html / docs(docx)）。 */
export const GENOFFICE_KINDS = ['markdown', 'pdf', 'html', 'docs'] as const;
export type GenOfficeKind = (typeof GENOFFICE_KINDS)[number];

/** GenOffice Home 伪地址（侧栏文档入口目标；主进程决定用 shell Home 视图还是 React 保底页）。 */
export const GENOFFICE_HOME_URL = 'urchin://genoffice-home';

/**
 * GenOffice shell Home 渲染产物根（apps/shell/out/renderer）。
 *
 * 与编辑器 kinds 分开解析：Home 视图由宿主用**自己的 preload**（window.aiOffice
 * 适配层）承载，故只校验 renderer 产物存在。
 */
export function resolveShellRendererRoot(): string | null {
  const root = resolveArtifactsRoot();
  if (!root) return null;
  const renderer = app.isPackaged
    ? join(root, 'apps', 'shell', 'renderer')
    : join(root, 'apps', 'shell', 'out', 'renderer');
  return existsSync(join(renderer, 'index.html')) ? renderer : null;
}

export interface GenOfficeArtifacts {
  /** 宿主运行时唯一入口（urchin-embed 主进程包）。 */
  readonly embedPath: string;
  /** kind → 编辑器 renderer 根目录（genoffice-app://<kind>/index.html 的根）。 */
  readonly rendererRoots: Partial<Record<GenOfficeKind, string>>;
  /** kind → 编辑器 preload 绝对路径。 */
  readonly preloads: Partial<Record<GenOfficeKind, string>>;
}

/** 解析产物根目录（不存在返回 null）。 */
export function resolveArtifactsRoot(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'genoffice')
    : resolve(app.getAppPath(), '..', '..', 'vendor', 'genoffice');
  return existsSync(root) ? root : null;
}

/**
 * 解析嵌入产物清单；embed 缺失（未构建 vendor）返回 null。
 * 各 kind 独立校验，允许「只构建了 markdown」的阶段性产物。
 */
export function resolveGenOfficeArtifacts(): GenOfficeArtifacts | null {
  const root = resolveArtifactsRoot();
  if (!root) return null;

  const embedPath = app.isPackaged
    ? join(root, 'embed', 'index.js')
    : join(root, 'apps', 'urchin-embed', 'out', 'main', 'index.js');
  if (!existsSync(embedPath)) return null;

  const rendererRoots: Partial<Record<GenOfficeKind, string>> = {};
  const preloads: Partial<Record<GenOfficeKind, string>> = {};
  for (const kind of GENOFFICE_KINDS) {
    const rendererRoot = app.isPackaged
      ? join(root, 'apps', kind, 'renderer')
      : join(root, 'apps', kind, 'out', 'renderer');
    const preloadPath = app.isPackaged
      ? join(root, 'apps', kind, 'preload', 'index.js')
      : join(root, 'apps', kind, 'out', 'preload', 'index.js');
    if (existsSync(join(rendererRoot, 'index.html')) && existsSync(preloadPath)) {
      rendererRoots[kind] = rendererRoot;
      preloads[kind] = preloadPath;
    }
  }

  return { embedPath, rendererRoots, preloads };
}
