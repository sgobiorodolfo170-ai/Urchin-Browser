/**
 * M8 Storage Layer · Electron safeStorage 适配器
 *
 * 依据：契约 H §7 / ST5 决策
 * 职责：将 Electron 的 safeStorage 模块适配为 ISafeStorage 接口。
 *
 * 仅在生产环境（main 进程）使用，测试环境使用 Mock。
 */

import { safeStorage } from 'electron';
import type { ISafeStorage } from './types';

export class ElectronSafeStorage implements ISafeStorage {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encryptString(plainText: string): Buffer {
    return safeStorage.encryptString(plainText);
  }

  decryptString(encrypted: Buffer): string {
    return safeStorage.decryptString(encrypted);
  }
}
