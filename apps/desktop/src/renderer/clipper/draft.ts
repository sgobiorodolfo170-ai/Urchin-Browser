/**
 * M26 剪藏 · 模板与落盘内容构建（纯函数）
 *
 * 负责把页面变量渲染为：
 * - 文件名
 * - 属性行（key/value）
 * - YAML frontmatter
 * - 最终 Markdown
 *
 * 保持纯函数便于单测；真正的文件名净化与写盘由主进程 ClipperStore 负责。
 */

/** 模板变量集合（值一律为字符串，空值用空串表达） */
export type ClipperVariables = Readonly<Record<string, string>>;

/** 一条可编辑属性 */
export interface ClipperPropertyRow {
  readonly key: string;
  readonly value: string;
}

/**
 * 常见页面属性 key 的中文名（面板属性区展示用）。
 *
 * 只做展示，不改变 frontmatter 的真实 key；未知字段回退显示原始 key，
 * 避免用户自定义属性被覆盖或误翻译。
 */
const PROPERTY_LABELS: Readonly<Record<string, string>> = {
  title: '标题',
  source: '来源链接',
  url: '链接',
  author: '作者',
  published: '发布日期',
  created: '创建日期',
  date: '日期',
  description: '描述',
  tags: '标签',
  site: '站点',
  domain: '域名',
  language: '语言',
  words: '字数',
  image: '封面图',
  favicon: '站点图标',
};

/** 返回属性 key 的中文名；未知 key 返回 undefined（调用方回退显示 key） */
export function propertyLabel(key: string): string | undefined {
  return PROPERTY_LABELS[key.trim().toLowerCase()];
}

/** 支持的变量正则：只替换 {{name}}，不解析复杂表达式（首版保持可预测） */
const VARIABLE_RE = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g;

/** 渲染模板：未命中的变量保留原样，便于用户发现拼写错误 */
export function renderTemplate(template: string, variables: ClipperVariables): string {
  return template.replace(VARIABLE_RE, (match, name: string) => variables[name] ?? match);
}

/** 把换行/多余空白压成单行（文件名模板用） */
export function renderNoteName(format: string, variables: ClipperVariables): string {
  return renderTemplate(format, variables).replace(/\s+/g, ' ').trim();
}

/**
 * 解析属性模板：每行 `key: valueTemplate`。
 * - 空行、以 # 开头的注释行忽略；
 * - 冒号取第一个，允许 value 内含冒号（如 URL）；
 * - value 按变量表渲染。
 */
export function parsePropertyTemplate(
  template: string,
  variables: ClipperVariables,
): readonly ClipperPropertyRow[] {
  const rows: ClipperPropertyRow[] = [];
  for (const rawLine of template.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const value = renderTemplate(line.slice(colon + 1).trim(), variables);
    rows.push({ key, value });
  }
  return rows;
}

/** YAML 键是否需要引号（含空白/特殊字符或以数字开头） */
function needsQuotedKey(key: string): boolean {
  return /[:\s{}[\],&*#?|<>=!%@\\-]/.test(key) || /^\d/.test(key);
}

function quoteKey(key: string): string {
  return needsQuotedKey(key) ? `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : key;
}

/** YAML 字符串值转义：统一使用双引号，避免冒号/井号等歧义 */
function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

/**
 * 生成 frontmatter；无有效属性时返回空串。
 * 空值也写成 `key: ""`，让用户在 Obsidian/编辑器中能看到该字段。
 */
export function buildFrontmatter(rows: readonly ClipperPropertyRow[]): string {
  const valid = rows.filter((row) => row.key.trim().length > 0);
  if (valid.length === 0) return '';
  const lines = ['---'];
  for (const row of valid) {
    lines.push(`${quoteKey(row.key.trim())}: ${quoteValue(row.value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** 合并 frontmatter 与正文（正文去尾部空白后保留一个换行） */
export function composeMarkdown(rows: readonly ClipperPropertyRow[], body: string): string {
  const frontmatter = buildFrontmatter(rows);
  const trimmed = body.trimEnd();
  return frontmatter.length === 0 ? `${trimmed}\n` : `${frontmatter}${trimmed}\n`;
}

/**
 * 构建模板变量。
 *
 * 元数据来自 Defuddle；content / selection 是 Markdown 正文。
 * noteName 变量使用净化前的标题，最终文件名仍由主进程净化。
 */
export function buildVariables(input: {
  readonly title: string;
  readonly url: string;
  readonly author?: string;
  readonly published?: string;
  readonly description?: string;
  readonly site?: string;
  readonly domain?: string;
  readonly language?: string;
  readonly words?: number;
  readonly favicon?: string;
  readonly image?: string;
  readonly content: string;
  readonly selection: string;
  readonly now?: Date;
}): ClipperVariables {
  const now = input.now ?? new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const datetime = `${date}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return {
    title: input.title.trim(),
    url: input.url.trim(),
    author: (input.author ?? '').trim(),
    published: (input.published ?? '').trim(),
    description: (input.description ?? '').trim(),
    site: (input.site ?? '').trim(),
    domain: (input.domain ?? '').trim(),
    language: (input.language ?? '').trim(),
    words: String(input.words ?? 0),
    favicon: input.favicon ?? '',
    image: input.image ?? '',
    content: input.content,
    selection: input.selection,
    date,
    datetime,
    noteName: input.title.trim(),
  };
}
