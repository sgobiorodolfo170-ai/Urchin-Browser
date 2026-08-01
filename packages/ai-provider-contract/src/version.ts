/**
 * M12 Provider Contract · API 版本常量
 *
 * 依据：契约 A §3 / IP2 决策
 *
 * Orchestrator 加载 Provider 时检查 apiVersion 是否在支持列表内，
 * 不匹配直接拒载并报错给用户。
 */

/** v0.1 支持的契约版本（IP2 决策，硬匹配） */
export const SUPPORTED_API_VERSIONS = ['urchin-ai-provider/v1'] as const;

/** 当前默认契约版本 */
export const CURRENT_API_VERSION = 'urchin-ai-provider/v1' as const;

/** 检查 apiVersion 是否在支持列表内 */
export function isSupportedApiVersion(version: string): boolean {
  return (SUPPORTED_API_VERSIONS as readonly string[]).includes(version);
}
