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

/** 当前支持的编辑器类型（阶段 4：md / pdf / html / docs(docx)；阶段 5：slides(pptx) / sheets(xlsx)）。 */
export const GENOFFICE_KINDS = ['markdown', 'pdf', 'html', 'docs', 'slides', 'sheets'] as const;
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
  /** sheets Rust xlsx-sidecar 二进制绝对路径（缺失则 sheets-sidecar 由 sheets-main 自行解析）。 */
  readonly sheetsSidecarPath?: string;
}

/** 解析产物根目录（不存在返回 null）。 */
export function resolveArtifactsRoot(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'genoffice')
    : resolve(app.getAppPath(), '..', '..', 'vendor', 'genoffice');
  return existsSync(root) ? root : null;
}

/**
 * 解析 GenOffice 特权 scheme 常量 JSON（启动优化，见 loader.ts 调用点）。
 *
 * 该文件由 `scripts/genoffice-extract-scheme-privileges.mjs` 在构建期从嵌入包
 * 抽取（genoffice-build.mjs 自动调用），供 app ready 前**轻量**读取：
 * - 开发态：vendor/genoffice/apps/urchin-embed/out/main/scheme-privileges.json
 * - 打包态：resources/genoffice/embed/scheme-privileges.json
 *
 * 不存在返回 null——宿主回退到「加载嵌入包取常量」的旧行为（慢但正确）。
 */
export function resolveGenOfficeSchemePrivilegesPath(): string | null {
  const root = resolveArtifactsRoot();
  if (!root) return null;
  const candidate = app.isPackaged
    ? join(root, 'embed', 'scheme-privileges.json')
    : join(root, 'apps', 'urchin-embed', 'out', 'main', 'scheme-privileges.json');
  return existsSync(candidate) ? candidate : null;
}

/**
 * 解析 sheets Rust xlsx-sidecar 二进制路径。
 *
 * - 开发态：`<vendor>/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar(.exe)`
 *   — 由 `pnpm genoffice:build`（含 cargo build）产出。
 * - 打包态：`process.resourcesPath/native/xlsx-sidecar(.exe)`
 *   — 由 electron-builder extraResources 复制（不进 asar）。
 *
 * 路径不存在返回 undefined（sheets 仍可加载，但读写 .xlsx 会失败——与 GenOffice
 * standalone 缺 sidecar 同款降级）。
 */
export function resolveSheetsSidecarPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
  const root = resolveArtifactsRoot();
  if (!root) return undefined;
  const devPath = join(root, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', exe);
  const packagedPath = join(process.resourcesPath, 'native', exe);
  const candidate = app.isPackaged ? packagedPath : devPath;
  return existsSync(candidate) ? candidate : undefined;
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

  return { embedPath, rendererRoots, preloads, sheetsSidecarPath: resolveSheetsSidecarPath() };
}
