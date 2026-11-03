/**
 * M4 Omnibox · URL 安全校验（OM5 决策）
 *
 * 依据：契约 J §4
 * 使用协议白名单而非黑名单：仅允许 http/https/urchin/file/about 协议导航。
 * 剥离控制字符（TAB/CR/LF），防止 Chromium URL parser 剥离后绕过 startsWith 检测。
 */

/** 校验结果。 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly url: string;
  readonly error?: string;
}

/** 允许导航的协议白名单。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'urchin:', 'file:', 'about:']);

/**
 * 校验 URL 是否安全可导航。
 *
 * 安全策略：
 * 1. 剥离控制字符（TAB/CR/LF）——Chromium URL parser 会剥离这些字符，
 *    导致 `"ja\tvascript:alert(1)"` 绕过 startsWith 检测
 * 2. 用 new URL() 解析得到实际协议，再做白名单判定
 * 3. 仅检查协议，不检查 URL 中是否包含 "javascript:" 字符串
 *    （`https://example.com/javascript-tutorial` 是安全的 HTTPS URL）
 *
 * @param input 用户输入或解析后的 URL
 * @returns 校验结果
 */
export function validateUrlBeforeNavigation(input: string): ValidationResult {
  // 剥离控制字符（Chromium URL parser 会剥离 TAB/CR/LF）
  const cleaned = input.replace(/[\t\r\n]/g, '');

  // 用 new URL() 解析得到实际协议
  let protocol: string;
  try {
    const url = new URL(cleaned, 'http://placeholder/');
    protocol = url.protocol;
  } catch {
    // 非合法 URL（可能是搜索词），放行由 parseInput 决定
    return { valid: true, url: input };
  }

  // 协议白名单判定
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    return { valid: false, url: input, error: `禁止导航到 ${protocol} 协议` };
  }

  return { valid: true, url: cleaned };
}
