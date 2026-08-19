/**
 * M4 Omnibox · 输入类型识别（OM1 决策）
 *
 * 依据：契约 J §2
 * 判断链：
 *   1. http:// / https:// / ftp:// 开头 → URL
 *   2. about: / urchin: / file: 开头 → 内部资源
 *   3. Windows 盘符路径（C:\x.mp4 / C:/x.mp4 / \x.mp4 等）→ 补 file:// 前缀的本地文件 URL
 *   4. 包含空格 → 搜索词
 *   5. 包含点（.）且无空格 → 尝试 URL（http 前缀自动补全）
 *   6. 非空且无点 → 搜索词
 *   7. 空 → 新标签页
 *
 * 设计理由（OM1 决策）：输入识别在渲染进程本地执行（纯字符串匹配），无需 IPC 调用，避免延迟。
 * 搜索引擎（OM6 决策）：搜索 URL 由 SEARCH_ENGINE_TEMPLATES 表按 searchEngine 设置生成
 * （见设置页 searchEngine 字段），未知引擎回退 Google——保证设置与行为一致。
 * 本地路径识别（本地文件网页化打开）：Windows 绝对路径输入直接以 file:// URL 打开，
 * 与 file: 显式前缀、拖放、Ctrl+O 共用同一套文件打开机制。
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

/** 搜索引擎标识（与设置页 searchEngine options 的 value 一致）。 */
export type SearchEngineId = 'google' | 'bing' | 'baidu' | 'duckduckgo' | 'sogou' | 'so360';

/** 搜索引擎 → 搜索 URL 模板（{query} 占位，构建时 encodeURIComponent 替换）。 */
const SEARCH_ENGINE_TEMPLATES: Readonly<Record<SearchEngineId, string>> = {
  google: 'https://www.google.com/search?q={query}',
  bing: 'https://www.bing.com/search?q={query}',
  baidu: 'https://www.baidu.com/s?wd={query}',
  duckduckgo: 'https://duckduckgo.com/?q={query}',
  sogou: 'https://www.sogou.com/web?query={query}',
  so360: 'https://www.so.com/s?q={query}',
};

/** 默认搜索引擎。 */
const DEFAULT_ENGINE: SearchEngineId = 'google';

/** URL 协议前缀列表。 */
const URL_PROTOCOLS = ['http://', 'https://', 'ftp://'];

/** 内部资源协议前缀列表。 */
const INTERNAL_PROTOCOLS = ['about:', 'urchin:', 'file:'];

/** Windows 本地路径模式：
 *  - C:\xxx / C:/xxx（盘符绝对路径）
 *  - \\server\share\xxx / \\?\C:\xxx（UNC 路径）
 *  - \xxx（当前盘符根路径）——需带反斜杠，避免误伤普通单斜杠输入 */
const WINDOWS_PATH_PATTERNS: readonly RegExp[] = [/^[a-zA-Z]:[\\/]/, /^\\\\[^\\]+\\/, /^\\[^\\]/];

/** 判断输入是否为 Windows 本地路径（盘符/UNC/根路径），是则补 file:// 前缀。
 *  UNC 路径（\\server\share）转 file://server/share（主机形式），
 *  其余转 file:/// 前缀（Chromium 文件 URL 规范）。
 *  路径可能含中文/空格/特殊字符，须 encodeURI 才能被 Chromium 正确解析
 *  （encodeURI 保留 : / 与逗号，编码中文/空格/单引号等）。 */
function toFileUrl(input: string): string | null {
  for (const pattern of WINDOWS_PATH_PATTERNS) {
    if (pattern.test(input)) {
      const normalized = input.replace(/\\/g, '/');
      // UNC：\\server\share → file://server/share
      if (normalized.startsWith('//')) {
        return `file://${encodeURI(normalized.replace(/^\/\//, ''))}`;
      }
      return `file:///${encodeURI(normalized)}`;
    }
  }
  return null;
}

/**
 * 识别用户输入类型并生成导航 URL。
 *
 * @param input 用户输入的原始文本
 * @param searchEngine 当前搜索引擎（来自 searchEngine 设置；未知值回退 google）
 * @returns 解析结果，包含类型和规范化 URL
 */
export function parseInput(input: string, searchEngine?: string): ParseResult {
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

  // 3. Windows 本地路径（C:\x.mp4 / \\server\share / \root）→ 补 file:// 前缀
  //    放在「包含点」判断之前：C:\x.mp4 含点，若不先识别会被当 https://C:/x.mp4 补全
  const fileUrl = toFileUrl(trimmed);
  if (fileUrl) {
    return { type: 'internal', url: fileUrl, input: trimmed };
  }

  // 4. 包含空格 → 搜索词
  if (trimmed.includes(' ')) {
    return { type: 'search', url: buildSearchUrl(trimmed, searchEngine), input: trimmed };
  }

  // 5. 包含点（.）且无空格 → 尝试 URL（http 前缀自动补全）
  if (trimmed.includes('.')) {
    return { type: 'url', url: `https://${trimmed}`, input: trimmed };
  }

  // 6. 非空且无点 → 搜索词
  return { type: 'search', url: buildSearchUrl(trimmed, searchEngine), input: trimmed };
}

/**
 * 构建搜索引擎 URL。
 *
 * @param query 搜索词
 * @param engine 搜索引擎标识（未知值回退 google）
 * @returns 编码后的搜索引擎 URL
 */
export function buildSearchUrl(query: string, engine?: string): string {
  const id = (engine ?? '') as SearchEngineId;
  const template = SEARCH_ENGINE_TEMPLATES[id] ?? SEARCH_ENGINE_TEMPLATES[DEFAULT_ENGINE];
  return template.replace('{query}', encodeURIComponent(query));
}
