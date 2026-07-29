/**
 * M10 Extension Loader · 扩展加载器
 *
 * 依据：04-模块全景 M10 v0.1 lite
 * 职责：
 * 1. 从解压目录加载 manifest.json
 * 2. 解析并校验 manifest
 * 3. 生成扩展 ID（基于路径 hash）
 * 4. 管理 loaded extensions 集合
 * 5. enable/disable/remove 扩展
 *
 * v0.1 lite 限制：
 * - 仅支持解压目录加载（不支持 .crx）
 * - 无权限审批 UI
 * - 无扩展更新机制
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '@urchin/logger';
import { parseManifest } from './manifest-validator';
import type { LoadedExtension, ManifestV3 } from './types';

const log = createLogger('extension-loader');

/**
 * 从扩展路径生成确定性 ID。
 *
 * @param extPath 扩展目录绝对路径
 * @returns 32 字符 hex ID
 */
function generateExtensionId(extPath: string): string {
  return createHash('sha256').update(extPath).digest('hex').substring(0, 32);
}

export class ExtensionLoader {
  private readonly extensions = new Map<string, LoadedExtension>();

  /**
   * 从解压目录加载扩展。
   *
   * @param extPath 扩展目录路径（包含 manifest.json）
   * @returns 加载的扩展信息
   * @throws 如果 manifest.json 不存在或校验失败
   */
  loadFromPath(extPath: string): LoadedExtension {
    const manifestPath = join(extPath, 'manifest.json');

    if (!existsSync(manifestPath)) {
      throw new Error(`manifest.json not found at: ${manifestPath}`);
    }

    let jsonStr: string;
    try {
      jsonStr = readFileSync(manifestPath, 'utf-8');
    } catch (e) {
      throw new Error(
        `Failed to read manifest.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const result = parseManifest(jsonStr);
    if (!result.valid || !result.manifest) {
      throw new Error(`Invalid manifest: ${result.errors.join('; ')}`);
    }

    const manifest: ManifestV3 = result.manifest;
    const id = generateExtensionId(extPath);

    // 如果已加载，先卸载
    if (this.extensions.has(id)) {
      this.extensions.delete(id);
    }

    const loaded: LoadedExtension = {
      id,
      name: manifest.name,
      version: manifest.version,
      path: extPath,
      manifest,
      enabled: true,
      loadedAt: Date.now(),
    };

    this.extensions.set(id, loaded);
    log.info('extension loaded', { id, name: manifest.name, version: manifest.version });

    return loaded;
  }

  /** 获取已加载的扩展。 */
  get(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  /** 列出所有已加载扩展。 */
  list(): LoadedExtension[] {
    return Array.from(this.extensions.values());
  }

  /** 启用扩展。 */
  enable(id: string): void {
    const ext = this.extensions.get(id);
    if (!ext) {
      throw new Error(`Extension not found: ${id}`);
    }
    if (ext.enabled) return;

    const updated: LoadedExtension = { ...ext, enabled: true };
    this.extensions.set(id, updated);
    log.info('extension enabled', { id, name: ext.name });
  }

  /** 禁用扩展。 */
  disable(id: string): void {
    const ext = this.extensions.get(id);
    if (!ext) {
      throw new Error(`Extension not found: ${id}`);
    }
    if (!ext.enabled) return;

    const updated: LoadedExtension = { ...ext, enabled: false };
    this.extensions.set(id, updated);
    log.info('extension disabled', { id, name: ext.name });
  }

  /** 卸载扩展。 */
  remove(id: string): void {
    const ext = this.extensions.get(id);
    if (!ext) {
      throw new Error(`Extension not found: ${id}`);
    }
    this.extensions.delete(id);
    log.info('extension removed', { id, name: ext.name });
  }

  /** 获取已加载扩展数量。 */
  getCount(): number {
    return this.extensions.size;
  }
}
