/**
 * M11 AI Orchestrator · Provider 注册表
 *
 * 依据：契约 A §6 / §7 / 契约 I §2 / IP2 / IP8
 *
 * 职责：
 * 1. 从 %APPDATA%/Urchin/providers/<id>/ 目录加载 Provider manifest
 * 2. 校验 apiVersion 兼容性（IP2 决策，硬匹配）+ manifest 字段（id/SemVer/capabilities/authMethod）
 * 3. 维护已注册 Provider 的清单与配置
 * 4. 支持第三方 Provider 安装（本地路径复制）/ 卸载（IP8 决策）
 *
 * 注意：本模块不负责 import Provider 实现代码——
 * 实际加载由 ProviderHost 通过 utilityProcess.fork 完成。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createLogger } from '@urchin/logger';
import {
  CURRENT_API_VERSION,
  isSupportedApiVersion,
  validateManifest,
  getManifestValidationError,
} from '@urchin/ai-provider-contract';

const log = createLogger('provider-registry');

/**
 * Provider 注册信息（不含 manifest，便于序列化）。
 */
export interface ProviderRegistration {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  /** 能力声明（从 manifest 读取，W5 修复：原 capabilities 字段缺失） */
  readonly capabilities: readonly string[];
  /** 鉴权方式（从 manifest 读取，W5 修复：原硬编码 'api_key'） */
  readonly authMethod: string;
  readonly entryPath: string;
  readonly manifestPath: string;
  readonly rateLimit?: { readonly requestsPerMin: number; readonly tokensPerMin?: number };
}

/**
 * 序列化的 manifest JSON（不含 zod schema，schema 在 Provider Child 端重建）。
 */
export interface SerializedManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly capabilities: readonly string[];
  readonly authMethod: string;
  readonly rateLimit?: { readonly requestsPerMin: number; readonly tokensPerMin?: number };
}

/**
 * Provider 安装结果。
 */
export interface ProviderInstallResult {
  readonly providerId: string;
  readonly source: string;
}

/**
 * Provider 注册表。
 *
 * 负责扫描 providers/ 目录、加载 manifest.json、校验 apiVersion，
 * 以及第三方 Provider 的安装/卸载（IP8）。
 */
export class ProviderRegistry {
  private readonly providersDir: string;
  private readonly registrations = new Map<string, ProviderRegistration>();

  constructor(providersDir: string) {
    this.providersDir = providersDir;
  }

  /**
   * 扫描 providers 目录，加载所有合法 Provider。
   * 返回成功加载的 Provider 数量。
   */
  scan(): number {
    this.registrations.clear();
    if (!existsSync(this.providersDir)) {
      log.info('providers directory not found', { dir: this.providersDir });
      return 0;
    }

    let count = 0;
    for (const entry of readdirSync(this.providersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const providerId = entry.name;
      try {
        const reg = this.loadRegistration(providerId);
        if (reg) {
          this.registrations.set(providerId, reg);
          count++;
        }
      } catch (err) {
        log.warn(`Failed to load provider "${providerId}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('provider registry scan complete', { count });
    return count;
  }

  /** 重新扫描（reload）：清空并重新加载所有 Provider */
  reload(): number {
    return this.scan();
  }

  /**
   * 加载单个 Provider 注册信息。
   * 不存在或校验失败时返回 null（错误已记录到日志）。
   */
  private loadRegistration(providerId: string): ProviderRegistration | null {
    const providerDir = join(this.providersDir, providerId);
    const manifestPath = join(providerDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      log.warn(`manifest.json not found for provider "${providerId}"`, { manifestPath });
      return null;
    }

    const raw = readFileSync(manifestPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`manifest.json is not valid JSON for provider "${providerId}"`);
      return null;
    }

    // IP2 决策：版本协商失败有清晰错误提示
    const validationError = getManifestValidationError(parsed);
    if (validationError !== null) {
      log.warn(`manifest.json failed schema validation for provider "${providerId}"`, {
        error: validationError,
      });
      return null;
    }
    if (!validateManifest(parsed)) {
      log.warn(`manifest.json failed schema validation for provider "${providerId}"`);
      return null;
    }

    const manifest = parsed as SerializedManifest;
    if (!isSupportedApiVersion(manifest.apiVersion)) {
      log.warn(`Provider "${providerId}" has unsupported apiVersion "${manifest.apiVersion}"`, {
        currentApiVersion: CURRENT_API_VERSION,
        supportedVersions: ['urchin-ai-provider/v1'],
      });
      return null;
    }

    const entryPath = join(providerDir, 'index.js');
    if (!existsSync(entryPath)) {
      log.warn(`Provider entry not found for "${providerId}"`, { entryPath });
      return null;
    }

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      capabilities: manifest.capabilities,
      authMethod: manifest.authMethod,
      entryPath,
      manifestPath,
      rateLimit: manifest.rateLimit,
    };
  }

  /**
   * 安装第三方 Provider（IP8 决策）。
   *
   * v0.1 仅支持本地路径：将源目录复制到 providers/<id>/。
   * 源目录必须包含 manifest.json 和 index.js。
   *
   * @param source 本地绝对路径（指向包含 manifest.json 的目录）
   * @returns 安装结果（含 providerId）
   * @throws 若路径无效、manifest 校验失败、apiVersion 不支持、目标已存在
   */
  install(source: string): ProviderInstallResult {
    // v0.1 仅支持本地路径
    if (!isAbsolute(source)) {
      throw new Error(
        `provider.install: source must be an absolute local path (got: "${source}"). npm package install is not supported in v0.1.`,
      );
    }
    if (!existsSync(source)) {
      throw new Error(`provider.install: source path does not exist: ${source}`);
    }

    // 读取源目录的 manifest.json
    const sourceManifestPath = join(source, 'manifest.json');
    if (!existsSync(sourceManifestPath)) {
      throw new Error(`provider.install: manifest.json not found in source: ${sourceManifestPath}`);
    }

    const raw = readFileSync(sourceManifestPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`provider.install: manifest.json is not valid JSON`);
    }

    // 校验 manifest（IP2：清晰错误提示）
    const validationError = getManifestValidationError(parsed);
    if (validationError !== null) {
      throw new Error(`provider.install: manifest validation failed: ${validationError}`);
    }

    const manifest = parsed as SerializedManifest;
    if (!isSupportedApiVersion(manifest.apiVersion)) {
      throw new Error(
        `provider.install: unsupported apiVersion "${manifest.apiVersion}" (current: ${CURRENT_API_VERSION}). Please update the Provider to match the supported contract version.`,
      );
    }

    // 校验 index.js 存在
    const sourceEntryPath = join(source, 'index.js');
    if (!existsSync(sourceEntryPath)) {
      throw new Error(
        `provider.install: Provider entry index.js not found in source: ${sourceEntryPath}`,
      );
    }

    // 目标目录：providers/<id>/
    const targetDir = join(this.providersDir, manifest.id);
    if (existsSync(targetDir)) {
      throw new Error(
        `provider.install: provider "${manifest.id}" is already installed (target: ${targetDir}). Remove it first.`,
      );
    }

    // 确保 providers 目录存在
    mkdirSync(this.providersDir, { recursive: true });

    // 复制源目录到目标（含 index.js / manifest.json / package.json / node_modules 等）
    cpSync(source, targetDir, { recursive: true });

    // 加载注册
    const reg = this.loadRegistration(manifest.id);
    if (!reg) {
      // 复制后仍加载失败，清理
      rmSync(targetDir, { recursive: true, force: true });
      throw new Error(
        `provider.install: failed to load registration after copy (providerId: ${manifest.id})`,
      );
    }
    this.registrations.set(manifest.id, reg);

    log.info('provider installed', { providerId: manifest.id, source });
    return { providerId: manifest.id, source };
  }

  /**
   * 卸载 Provider（删除目录 + 移除注册）。
   * @throws 若 providerId 不存在
   */
  remove(providerId: string): void {
    const reg = this.registrations.get(providerId);
    if (!reg) {
      throw new Error(`provider.remove: provider "${providerId}" is not registered`);
    }

    const providerDir = join(this.providersDir, providerId);
    if (existsSync(providerDir)) {
      rmSync(providerDir, { recursive: true, force: true });
    }

    this.registrations.delete(providerId);
    log.info('provider removed', { providerId });
  }

  /** 获取 Provider 注册信息 */
  get(providerId: string): ProviderRegistration | undefined {
    return this.registrations.get(providerId);
  }

  /** 列出所有已注册 Provider */
  list(): readonly ProviderRegistration[] {
    return Array.from(this.registrations.values());
  }

  /** 是否已注册 */
  has(providerId: string): boolean {
    return this.registrations.has(providerId);
  }
}
