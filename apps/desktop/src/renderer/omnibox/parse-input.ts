/**
 * M4 Omnibox · 输入类型识别（OM1 决策）
 *
 * 依据：契约 J §2
 * 判断链：
 *   1. http:// / https:// / ftp:// 开头 → URL
 *   2. about: / urchin: / file: 开头 → 内部资源
 *   3. 包含空格 → 搜索词
 *   4. 包含点（.）且无空格 → 尝试 URL（http 前缀自动补全）
 *   5. 非空且无点 → 搜索词
 *   6. 空 → 新标签页
 *
 * 设计理由（OM1 决策）：输入识别在渲染进程本地执行（纯字符串匹配），无需 IPC 调用，避免延迟。
 */

/** 输入类型。 */
export type InputType = 'url' | 'search' | 'internal' | 'empty';

/** 输入识别结果。 */
export interface ParseResult {
  readonly type: InputType;
  /** 规范化后的 URL（URL 类型时补全 http://，搜索词类型时为搜索引擎 URL）。 */
  readonly url: string;
  /** 原始输入。 */
  readonly input: string;
}

/** 默认搜索引擎模板（OM6 决策：v0.1 硬编码 Google）。 */
const SEARCH_ENGINE_TEMPLATE = 'https://www.google.com/search?q={query}';

/** URL 协议前缀列表。 */
const URL_PROTOCOLS = ['http://', 'https://', 'ftp://'];

/** 内部资源协议前缀列表。 */
const INTERNAL_PROTOCOLS = ['about:', 'urchin:', 'file:'];

/**
 * 识别用户输入类型并生成导航 URL。
 *
 * @param input 用户输入的原始文本
 * @returns 解析结果，包含类型和规范化 URL
 */
export function parseInput(input: string): ParseResult {
  const trimmed = input.trim();

  // 6. 空 → 新标签页
  if (trimmed === '') {
    return { type: 'empty', url: 'urchin://newtab', input: trimmed };
  }

  const lower = trimmed.toLowerCase();

  // 1. 以 http:// / https:// / ftp:// 开头 → URL
  for (const proto of URL_PROTOCOLS) {
    if (lower.startsWith(proto)) {
      return { type: 'url', url: trimmed, input: trimmed };
    }
  }

  // 2. 以 about: / urchin: / file: 开头 → 内部资源
  for (const proto of INTERNAL_PROTOCOLS) {
    if (lower.startsWith(proto)) {
      return { type: 'internal', url: trimmed, input: trimmed };
    }
  }

  // 3. 包含空格 → 搜索词
  if (trimmed.includes(' ')) {
    return { type: 'search', url: buildSearchUrl(trimmed), input: trimmed };
  }

  // 4. 包含点（.）且无空格 → 尝试 URL（http 前缀自动补全）
  if (trimmed.includes('.')) {
    return { type: 'url', url: `https://${trimmed}`, input: trimmed };
  }

  // 5. 非空且无点 → 搜索词
  return { type: 'search', url: buildSearchUrl(trimmed), input: trimmed };
}

/**
 * 构建搜索引擎 URL。
 *
 * @param query 搜索词
 * @returns 编码后的搜索引擎 URL
 */
function buildSearchUrl(query: string): string {
  return SEARCH_ENGINE_TEMPLATE.replace('{query}', encodeURIComponent(query));
}
