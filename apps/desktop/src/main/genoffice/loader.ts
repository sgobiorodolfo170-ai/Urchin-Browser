/**
 * GenOffice 嵌入包加载器（阶段 1/2）
 *
 * 职责：把 vendor 构建出的 @genoffice/urchin-embed 主进程 bundle 以运行时
 * CommonJS require 方式加载（不进 Urchin 自身打包——React 18/19、Tiptap 2/3
 * 等依赖树完全隔离），并把宿主缺失的 GenOffice 应用级通道补齐。
 *
 * 设计理由（agents.md §六 跨进程边界）：
 * - 嵌入包是自包含 CJS（仅 electron/node 内置外部依赖），加载失败必须降级：
 *   返回 null → 宿主回落到 Urchin 内置查看器，绝不阻塞浏览器启动。
 * - 仅暴露加载所需最小接口类型（不 import vendor 类型，保持构建边界干净）。
 */
import type { CustomScheme } from 'electron';
import { createRequire } from 'node:module';
import { resolveGenOfficeArtifacts, type GenOfficeArtifacts } from './paths';

/** vendor 嵌入包对外 API（与 apps/urchin-embed/src/main/index.ts 保持同步）。 */
export interface GenOfficeEmbedApi {
  readonly GENOFFICE_SCHEME_PRIVILEGES: readonly CustomScheme[];
  initGenOfficeEmbed(opts: {
    readonly rendererRoots: Partial<Record<string, string>>;
    readonly preloads: Partial<Record<string, string>>;
    readonly openGeneratedPath?: (path: string) => boolean;
  }): void;
  /** 阶段 3：注册 GenOffice 原生 AI（ai:*）与项目会话（project:*）通道。 */
  initGenOfficeAi?(): void;
  createGenOfficeView(kind: string, filePath: string | null): unknown;
  /** 阶段 4：docs 脏状态经 close-check 握手查询，故为异步。 */
  genOfficeIsDirty(kind: string, contents: unknown): Promise<boolean>;
  requestGenOfficeClose(kind: string, contents: unknown, parent?: unknown): Promise<boolean>;
}

/** 依赖注入（单测传 mock require，避免真实加载 vendor 产物）。 */
export interface GenOfficeLoaderDeps {
  readonly requireModule?: (id: string) => unknown;
  readonly resolveArtifacts?: () => GenOfficeArtifacts | null;
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

/**
 * 供 app ready 前注册特权 scheme 使用：返回嵌入包声明的 scheme 特权列表；
 * 产物缺失时返回空数组（不注册、不报错）。
 */
export function getGenOfficeSchemePrivileges(
  deps: GenOfficeLoaderDeps = {},
): readonly CustomScheme[] {
  const embed = loadGenOfficeEmbed(deps);
  return embed ? embed.GENOFFICE_SCHEME_PRIVILEGES : [];
}

/** 重置缓存（单测用）。 */
export function __resetGenOfficeEmbedCache(): void {
  cached = undefined;
}
