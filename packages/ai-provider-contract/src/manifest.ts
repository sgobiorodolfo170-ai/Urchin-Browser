/**
 * M12 Provider Contract · 能力声明（ProviderManifest）
 *
 * 依据：契约 A §3 / IP2 决策
 *
 * Provider 通过 manifest 声明自身 ID、版本、能力、配置 schema、鉴权方式和速率限制。
 * Orchestrator 加载时检查 apiVersion，按 capabilities 路由调用，按 rateLimit 做令牌桶节流。
 */

import type { z } from 'zod';
import type { ProviderConfig } from './context.js';

/** Provider 能力声明 */
export type ProviderCapability =
  | 'chat.completion' // 非流式补全
  | 'chat.completion.streaming' // 流式补全
  | 'embedding' // 向量化
  | 'tool_calling' // 工具调用
  | 'vision' // 图片输入
  | 'function_calling' // 函数调用
  | 'local_inference'; // 本地推理

/** 鉴权方式 */
export type AuthMethod = 'api_key' | 'oauth' | 'none' | 'local';

/** Provider 自报速率限制 */
export interface ProviderRateLimit {
  /** 每分钟最大请求数 */
  readonly requestsPerMin: number;
  /** 每分钟最大 token 数（可选） */
  readonly tokensPerMin?: number;
}

/**
 * Provider 元数据与能力声明。
 *
 * - id: 唯一标识，如 'openai' / 'anthropic' / 'ollama'
 * - version: Provider 实现自身版本（SemVer）
 * - apiVersion: 契约版本，硬匹配 'urchin-ai-provider/v1'（IP2 决策）
 * - configSchema: 用户配置表单的 zod schema，单一真源
 */
export interface ProviderManifest {
  /** 唯一标识 */
  readonly id: string;
  /** 展示名 */
  readonly name: string;
  /** Provider 实现自身版本（SemVer） */
  readonly version: string;
  /** 契约版本：'urchin-ai-provider/v1' — IP2 决策，硬匹配 */
  readonly apiVersion: string;
  /** 能力声明列表 */
  readonly capabilities: readonly ProviderCapability[];
  /** 用户配置表单的 schema（zod），单一真源 */
  readonly configSchema: z.ZodSchema<ProviderConfig>;
  /** 鉴权方式 */
  readonly authMethod: AuthMethod;
  /** 自报速率限制，Orchestrator 据此做令牌桶节流 */
  readonly rateLimit?: ProviderRateLimit;
}

/**
 * 检查 manifest 是否声明了指定能力。
 */
export function hasCapability(manifest: ProviderManifest, cap: ProviderCapability): boolean {
  return manifest.capabilities.includes(cap);
}

/** 合法的能力声明枚举（用于运行时校验） */
const VALID_CAPABILITIES: readonly string[] = [
  'chat.completion',
  'chat.completion.streaming',
  'embedding',
  'tool_calling',
  'vision',
  'function_calling',
  'local_inference',
] as const;

/** 合法的鉴权方式枚举（用于运行时校验） */
const VALID_AUTH_METHODS: readonly string[] = ['api_key', 'oauth', 'none', 'local'] as const;

/** Provider ID 格式：小写字母/数字/连字符，1-64 字符 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** SemVer 正则（简化版：MAJOR.MINOR.PATCH 可选预发布） */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

/**
 * 校验 manifest 基本字段。
 *
 * IP2 决策：版本协商失败必须给出清晰错误提示，
 * 因此本函数返回详细错误信息而非简单 boolean。
 *
 * 注意：configSchema 在序列化 manifest.json 中以 JSON Schema 形式存储，
 * 此处仅校验其存在性，深度校验由 Provider Child 端负责。
 */
export function validateManifest(manifest: unknown): manifest is ProviderManifest {
  return getManifestValidationError(manifest) === null;
}

/**
 * 获取 manifest 校验错误信息。
 * 返回 null 表示校验通过；否则返回首个错误描述（用于 UI 提示）。
 *
 * IP2 决策：版本协商失败有清晰错误提示。
 */
export function getManifestValidationError(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) {
    return 'manifest must be a non-null object';
  }
  const m = manifest as Record<string, unknown>;

  // id
  if (typeof m.id !== 'string' || m.id.length === 0) {
    return 'manifest.id must be a non-empty string';
  }
  if (!PROVIDER_ID_PATTERN.test(m.id)) {
    return `manifest.id "${m.id}" is invalid (expected: lowercase alphanumeric with hyphens, 1-64 chars)`;
  }

  // name
  if (typeof m.name !== 'string' || m.name.length === 0) {
    return 'manifest.name must be a non-empty string';
  }

  // version (SemVer)
  if (typeof m.version !== 'string' || m.version.length === 0) {
    return 'manifest.version must be a non-empty string';
  }
  if (!SEMVER_PATTERN.test(m.version)) {
    return `manifest.version "${m.version}" is not a valid SemVer (expected: MAJOR.MINOR.PATCH)`;
  }

  // apiVersion
  if (typeof m.apiVersion !== 'string' || m.apiVersion.length === 0) {
    return 'manifest.apiVersion must be a non-empty string';
  }

  // capabilities
  if (!Array.isArray(m.capabilities)) {
    return 'manifest.capabilities must be an array';
  }
  for (const cap of m.capabilities) {
    if (typeof cap !== 'string' || !VALID_CAPABILITIES.includes(cap)) {
      return `manifest.capabilities contains invalid value "${String(cap)}" (valid: ${VALID_CAPABILITIES.join(', ')})`;
    }
  }

  // authMethod
  if (typeof m.authMethod !== 'string') {
    return 'manifest.authMethod must be a string';
  }
  if (!VALID_AUTH_METHODS.includes(m.authMethod)) {
    return `manifest.authMethod "${m.authMethod}" is invalid (valid: ${VALID_AUTH_METHODS.join(', ')})`;
  }

  // rateLimit（可选）
  if (m.rateLimit !== undefined && m.rateLimit !== null) {
    if (typeof m.rateLimit !== 'object') {
      return 'manifest.rateLimit must be an object';
    }
    const rl = m.rateLimit as Record<string, unknown>;
    if (typeof rl.requestsPerMin !== 'number' || rl.requestsPerMin <= 0) {
      return 'manifest.rateLimit.requestsPerMin must be a positive number';
    }
    if (
      rl.tokensPerMin !== undefined &&
      (typeof rl.tokensPerMin !== 'number' || rl.tokensPerMin <= 0)
    ) {
      return 'manifest.rateLimit.tokensPerMin must be a positive number if present';
    }
  }

  return null;
}
