/**
 * M8 Storage Layer · 敏感数据存储
 *
 * 依据：契约 H §7 / ST5 + ST6 决策
 * 职责：
 * 1. 通过 safeStorage 加密 API key 等敏感数据
 * 2. 写入文件系统 secrets/<providerId>/<keyName>.enc
 * 3. 严格白名单字符校验，拒绝路径穿越（ST6 决策）
 *
 * ST5 决策：使用 Electron safeStorage（Windows 上为 DPAPI）。
 * ST6 决策：name 格式 <providerId>/<keyName>，仅允许字母数字/下划线/连字符/斜杠。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ISafeStorage, SecretStore } from './types';

/** ST6 决策：严格白名单字符正则 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9/_-]+$/;

export class SecretStoreImpl implements SecretStore {
  constructor(
    private readonly dataDir: string,
    private readonly safeStorage: ISafeStorage,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- sync I/O per contract, async signature for future keytar migration
  async get(name: string): Promise<string | null> {
    const file = this.pathFor(name);
    if (!existsSync(file)) return null;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage not available on this platform');
    }
    const encrypted = readFileSync(file);
    return this.safeStorage.decryptString(encrypted);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync I/O per contract, async signature for future keytar migration
  async set(name: string, value: string): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage not available');
    }
    const encrypted = this.safeStorage.encryptString(value);
    const file = this.pathFor(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, encrypted, { mode: 0o600 });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- sync I/O per contract, async signature for future keytar migration
  async delete(name: string): Promise<void> {
    const file = this.pathFor(name);
    if (existsSync(file)) unlinkSync(file);
  }

  /**
   * ST6 决策：严格白名单字符，拒绝路径穿越。
   * name 格式: <providerId>/<keyName>，仅允许字母数字/下划线/连字符/斜杠
   */
  private pathFor(name: string): string {
    if (!VALID_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid secret name: ${name}`);
    }
    return join(this.dataDir, 'secrets', `${name}.enc`);
  }
}
