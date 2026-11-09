/**
 * M8 Storage Layer · Electron safeStorage 适配器
 *
 * 依据：契约 H §7 / ST5 决策
 * 职责：将 Electron 的 safeStorage 模块适配为 ISafeStorage 接口。
 *
 * 仅在生产环境（main 进程）使用，测试环境使用 Mock。
 *
 * 为何用异步 API（2026-11-09）：
 * Electron 45 起同步 safeStorage 三件套 deprecated、46 起移除；异步 API 在 43 已可用，
 * 且非阻塞（macOS/Linux 同步实现可能阻塞主线程等待钥匙串）。数据格式兼容：
 * 同步 encryptString 的产物可用 decryptStringAsync 解开，无需迁移既有 .enc 文件。
 */

import { safeStorage } from 'electron';
import type { ISafeStorage } from './types';

export class ElectronSafeStorage implements ISafeStorage {
  async isEncryptionAvailable(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }

  async encryptString(plainText: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plainText);
  }

  /**
   * decryptStringAsync 返回 { result, shouldReEncrypt }：shouldReEncrypt 表示系统密钥已轮换，
   * 建议用新密钥重新加密落盘。当前实现只取明文（数据可正常读取），未做自动重加密——
   * 与同步 API 的行为等价；若后续需要密钥轮换能力，在 SecretStore 读写路径上补触发即可。
   */
  async decryptString(encrypted: Buffer): Promise<string> {
    const { result } = await safeStorage.decryptStringAsync(encrypted);
    return result;
  }
}
