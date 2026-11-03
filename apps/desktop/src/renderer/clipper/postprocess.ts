/**
 * M26 剪藏 · 正文后处理
 *
 * 两件事：
 * 1. sanitizeFragmentHtml：对选区 HTML 做与快照清洗一致的安全净化（移除脚本/
 *    样式/表单/事件属性等），避免「选中优先」把页面交互块或样式带进 Markdown。
 * 2. trimTrailingBoilerplate：从正文末尾倒序剪除连续的中文信息栏短行（来源：/
 *    作者：/评论：等），只剪「末尾连续短行」，不动正文中间的合法引用。
 *
 * 设计理由：Defuddle 按结构/class/id 清理，不识别中文文案；选区路径此前完全
 * 没有净化。两者都是「来源：/作者：/评论：」脏数据残留的根因。剪除规则保守：
 * 必须同时满足「位于正文尾部」「连续短行」「命中关键词」三个条件，且整体可
 * 通过设置开关关闭，避免误删正文中合法的「来源：」引用。
 */

/** 选区净化中一律移除的元素（比快照清洗多 style/noscript/template） */
const FRAGMENT_DROP_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'link',
  'meta',
  'base',
];

const DANGEROUS_ATTR_RE = /^on/i;
const JS_URL_RE = /^\s*javascript:/i;

/**
 * 净化选区 HTML 片段：移除危险元素与事件属性，返回可安全转 Markdown 的 HTML。
 *
 * 与 clean-html.ts 的 sanitizeContentHtml 共享思路，但额外剥离 style/noscript/
 * template——选区是用户框选的可见片段，这些节点对正文无意义且会污染 Markdown。
 */
export function sanitizeFragmentHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const selector of FRAGMENT_DROP_ELEMENTS) {
    doc.querySelectorAll(selector).forEach((el) => el.remove());
  }
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (DANGEROUS_ATTR_RE.test(attr.name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((attr.name === 'href' || attr.name === 'src') && JS_URL_RE.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body?.innerHTML ?? '';
}

/**
 * 命中尾部信息栏的关键词。匹配「关键词 + 全角/半角冒号」开头的短行。
 * 列表保守：只收中文文章末尾常见的元信息行，不收「声明/标签」等歧义词。
 */
const BOILERPLATE_KEYWORDS = [
  '来源',
  '作者',
  '评论',
  '编辑',
  '责编',
  '责任编辑',
  '原标题',
  '本文来自',
  '版权声明',
  '转载请注明',
  '转载自',
  '稿件来源',
  '关键字',
] as const;

/** 关键词行正则：允许行首空白、引用标记（>），关键词后跟全角/半角冒号 */
const BOILERPLATE_LINE_RE = new RegExp(`^\\s*>?\\s*(?:${BOILERPLATE_KEYWORDS.join('|')})\\s*[:：]`);

/** 行被视为「短行」的最大字符数（CJK 每字算 1） */
const MAX_BOILERPLATE_LINE_CHARS = 80;

/** 从 Markdown 正文末尾倒序剪除连续的中文信息栏短行 */
export function trimTrailingBoilerplate(markdown: string): string {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  let end = lines.length;

  // 先吞掉尾部纯空白行
  while (end > 0 && lines[end - 1]?.trim() === '') {
    end -= 1;
  }
  if (end === 0) return '';

  // 倒序吞掉命中关键词的连续短行
  while (end > 0) {
    const line = lines[end - 1];
    if (!line) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) break;
    if (trimmed.length > MAX_BOILERPLATE_LINE_CHARS) break;
    if (!BOILERPLATE_LINE_RE.test(trimmed)) break;
    end -= 1;
  }

  // 再次吞掉剪除后暴露出的尾部空白行
  while (end > 0 && lines[end - 1]?.trim() === '') {
    end -= 1;
  }

  if (end === 0) return '';
  if (end === lines.length) return markdown;
  return lines.slice(0, end).join('\n').trimEnd();
}
