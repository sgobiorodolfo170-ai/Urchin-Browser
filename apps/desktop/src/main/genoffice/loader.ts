/**
 * GenOffice 嵌入包加载器（阶段 1/2）
 *
 * 职责：把 vendor 构建出的 @genoffice/urchin-embed 主进程 bundle 以运行时
 * CommonJS require 方式加载（不进 Urchin 自身打包——React 18/19、Tiptap 2/3
 * 等依赖树完全隔离），并把宿主缺失的 GenOffice 应用级通道补齐。
 *
 * 设计理由（AGENTS.md §六 跨进程边界）：
 * - 嵌入包是自包含 CJS（仅 electron/node 内置外部依赖），加载失败必须降级：
 *   返回 null → 宿主回落到 Urchin 内置查看器，绝不阻塞浏览器启动。
 * - 仅暴露加载所需最小接口类型（不 import vendor 类型，保持构建边界干净）。
 */
import type { CustomScheme } from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  resolveGenOfficeArtifacts,
  resolveGenOfficeSchemePrivilegesPath,
  type GenOfficeArtifacts,
} from './paths';

/** vendor 嵌入包对外 API（与 apps/urchin-embed/src/main/index.ts 保持同步）。 */
export interface GenOfficeEmbedApi {
  readonly GENOFFICE_SCHEME_PRIVILEGES: readonly CustomScheme[];
  initGenOfficeEmbed(opts: {
    readonly rendererRoots: Partial<Record<string, string>>;
    readonly preloads: Partial<Record<string, string>>;
    readonly openGeneratedPath?: (path: string) => boolean;
    readonly extraRendererRoots?: Record<string, string>;
  }): void;
  /** 阶段 3：注册 GenOffice 原生 AI（ai:*）与项目会话（project:*）通道。 */
  initGenOfficeAi?(): void;
  createGenOfficeView(kind: string, filePath: string | null): unknown;
  /** 阶段 4.6：新建空白文档视图（Home「新建」动作）。 */
  createGenOfficeBlankView?(kind: string): unknown;
  /** 阶段 5：停掉 Rust XLSX sidecar 子进程（宿主 before-quit 调用，防孤儿进程）。 */
  stopGenOfficeSidecars?(): void;
  /** 阶段 4.6：写空白 PDF（Home「新建 PDF」动作）。 */
  writeBlankPdfFile?(filePath: string): Promise<void>;
  /** 阶段 4.6：切换 GenOffice UI 语言（Home 语言设置）。 */
  setGenOfficeLanguage?(lang: string): void;
  /** 阶段 4：docs 脏状态经 close-check 握手查询，故为异步。 */
  genOfficeIsDirty(kind: string, contents: unknown): Promise<boolean>;
  requestGenOfficeClose(kind: string, contents: unknown, parent?: unknown): Promise<boolean>;
}

/** 依赖注入（单测传 mock require，避免真实加载 vendor 产物）。 */
export interface GenOfficeLoaderDeps {
  readonly requireModule?: (id: string) => unknown;
  readonly resolveArtifacts?: () => GenOfficeArtifacts | null;
  /** scheme 常量 JSON 路径解析（默认真实 vendor/打包产物；单测注入）。 */
  readonly resolveSchemePrivilegesPath?: () => string | null;
  /** JSON 文本读取（默认 fs 同步读 UTF-8；单测注入）。 */
  readonly readTextFile?: (path: string) => string;
}

let cached: GenOfficeEmbedApi | null | undefined;

/**
 * 加载嵌入包（带缓存；产物缺失/加载异常返回 null）。
 */
export function loadGenOfficeEmbed(deps: GenOfficeLoaderDeps = {}): GenOfficeEmbedApi | null {
  // 缓存权威：进程内只加载一次（单测经 __resetGenOfficeEmbedCache 显式重置）
  if (cached !== undefined) return cached;

  const resolveArtifacts = deps.resolveArtifacts ?? resolveGenOfficeArtifacts;
  const artifacts = resolveArtifacts();
  if (!artifacts) {
    cached = null;
    return null;
  }

  try {
    // 主进程产物为 CommonJS：CJS 构建里 __filename 为真实路径；vitest（ESM）下
    // 默认加载路径不会被走到（单测经 requireModule 注入），故兼容性无虞
    const load =
      deps.requireModule ?? ((id: string): unknown => createRequire(__filename)(id) as unknown);
    const mod = load(artifacts.embedPath) as GenOfficeEmbedApi;
    if (typeof mod?.createGenOfficeView !== 'function') {
      throw new Error('embed bundle missing createGenOfficeView');
    }
    cached = mod;
    return mod;
  } catch (e) {
    console.error('[genoffice] embed load failed:', e);
    cached = null;
    return null;
  }
}

/** scheme 常量 JSON 条目形状校验（宽松：只认宿主注册所需的最小字段）。 */
function isSchemePrivilegeLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { scheme?: unknown; privileges?: unknown };
  return (
    typeof v.scheme === 'string' &&
    v.scheme.length > 0 &&
    typeof v.privileges === 'object' &&
    v.privileges !== null
  );
}

let cachedPrivileges: readonly CustomScheme[] | undefined;

/**
 * 供 app ready 前注册特权 scheme 使用：优先读取构建期抽出的轻量常量 JSON
 * （scheme-privileges.json，由 scripts/genoffice-extract-scheme-privileges.mjs
 * 生成）——避免在 ready 前为 4 条静态配置 require 整个嵌入包（慢盘上省约
 * 7.76MB 冷读，Urchin 启动优化）。
 *
 * 降级链：JSON 缺失/损坏 → 回退加载嵌入包取常量（旧行为，仅慢）→ 嵌入包也
 * 不可用 → 空数组（不注册、不报错，验收策略：启动绝不阻塞）。
 */
export function getGenOfficeSchemePrivileges(
  deps: GenOfficeLoaderDeps = {},
): readonly CustomScheme[] {
  // 缓存权威：同 loadGenOfficeEmbed（__resetGenOfficeEmbedCache 一并重置）
  if (cachedPrivileges !== undefined) return cachedPrivileges;

  const resolvePath = deps.resolveSchemePrivilegesPath ?? resolveGenOfficeSchemePrivilegesPath;
  const readText = deps.readTextFile ?? ((path: string): string => readFileSync(path, 'utf8'));
  try {
    const privilegesPath = resolvePath();
    if (privilegesPath) {
      const parsed: unknown = JSON.parse(readText(privilegesPath));
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isSchemePrivilegeLike)) {
        cachedPrivileges = parsed as readonly CustomScheme[];
        return cachedPrivileges;
      }
      console.error('[genoffice] scheme-privileges.json 形状异常，回退加载嵌入包取常量');
    }
  } catch (e) {
    console.error('[genoffice] scheme-privileges.json 读取失败，回退加载嵌入包取常量:', e);
  }

  const embed = loadGenOfficeEmbed(deps);
  cachedPrivileges = embed ? embed.GENOFFICE_SCHEME_PRIVILEGES : [];
  return cachedPrivileges;
}

/** 重置缓存（单测用）。 */
export function __resetGenOfficeEmbedCache(): void {
  cached = undefined;
  cachedPrivileges = undefined;
}
