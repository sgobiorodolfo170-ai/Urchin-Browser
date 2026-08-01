/**
 * M12 Provider Contract · 生命周期与上下文
 *
 * 依据：契约 A §4
 *
 * ProviderContext 是 Provider initialize() 时收到的上下文对象，
 * 包含配置、密钥访问、日志、取消信号和私有存储。
 *
 * 关键设计：
 * - secrets 不直接暴露 Electron safeStorage，抽象一层便于以后切换
 * - abort 用标准 AbortSignal，Provider 必须监听
 * - storage 是 Provider 私有命名空间，通过 SQLite 隔离
 */

import type { Logger } from '@urchin/logger';

/**
 * Provider 配置（用户在 Settings UI 填写，经 configSchema 校验后的对象）。
 * 具体字段由各 Provider 的 configSchema 定义，此处为宽松类型。
 */
export type ProviderConfig = Record<string, unknown>;

/**
 * 密钥安全访问接口。
 *
 * 从 Main 的 safeStorage 取回加密值，仅该 Provider 可见。
 * Main 端 handler 校验 providerId 与 caller 一致。
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/**
 * Provider 私有存储接口。
 *
 * 通过 SQLite 表名前缀隔离，不与其他 Provider 共享。
 * 实现由 Orchestrator 通过 IPC 反向调用 Main 的 StorageLayer.providerStore() 完成。
 */
export interface ProviderStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  query<T>(prefix: string): Promise<readonly { readonly key: string; readonly value: T }[]>;
}

/**
 * Provider 初始化时收到的上下文。
 */
export interface ProviderContext {
  /** Provider 自己的配置（已校验过 configSchema） */
  readonly config: ProviderConfig;

  /** API key 安全访问（从 Main 的 safeStorage 取回，仅该 Provider 可见） */
  readonly secrets: SecretStore;

  /** 结构化日志（utility 进程日志，转发到 Main 再落盘） */
  readonly log: Logger;

  /** 取消信号（用户中止生成时触发）— 强制监听 */
  readonly abort: AbortSignal;

  /** Provider 私有 SQLite 命名空间，不与其他 Provider 共享 */
  readonly storage: ProviderStorage;
}
