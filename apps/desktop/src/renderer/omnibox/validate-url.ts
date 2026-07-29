/**
 * M4 Omnibox · URL 安全校验（OM5 决策）
 *
 * 依据：契约 J §4
 * 禁止危险协议直接执行：javascript: / data: / vbscript:
 * 禁止未经转义的 URL 中携带危险协议。
 *
 * 设计理由（OM5 决策）：导航前校验危险协议，不做校验有安全风险。
 */

/** 校验结果。 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly url: string;
  readonly error?: string;
}

/** 危险协议前缀列表。 */
const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:'];

/**
 * 校验 URL 是否安全可导航。
 *
 * @param input 用户输入或解析后的 URL
 * @returns 校验结果
 */
export function validateUrlBeforeNavigation(input: string): ValidationResult {
  const lower = input.toLowerCase();

  // 禁止危险协议直接执行
  for (const proto of DANGEROUS_PROTOCOLS) {
    if (lower.startsWith(proto)) {
      return { valid: false, url: input, error: `禁止导航到 ${proto} 协议` };
    }
  }

  // 禁止未经转义的 URL 中携带危险协议
  if (lower.includes('javascript:') || lower.includes('data:')) {
    return { valid: false, url: input, error: 'URL 中包含非法协议' };
  }

  // 正常 URL 或搜索词放行
  return { valid: true, url: input };
}
