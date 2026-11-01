/**
 * M26 剪藏 · 清洗快照 HTML 构建
 *
 * 输入 Defuddle 正文 HTML，输出可交给隐藏窗口导出 MHTML/PDF/截图的完整文档：
 * - <base> 指向原页面，保留图片/链接相对地址；
 * - 移除脚本、iframe、表单、事件属性等非正文/不安全内容；
 * - 阅读模式 CSS，去掉广告/导航/侧栏（这些本来就不在 Defuddle 正文里）。
 *
 * 注意：这是“正文清洗”模式，版式与阅读模式一致，不追求与原页逐像素一致。
 */

/** 危险元素：清洗快照中一律移除 */
const DANGEROUS_ELEMENTS = [
  'script',
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

/** 危险属性：事件处理器与内联脚本 */
const DANGEROUS_ATTR_RE = /^on/i;
const JS_URL_RE = /^\s*javascript:/i;

const READER_CSS = `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2328; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.75;
}
article { max-width: 820px; margin: 0 auto; padding: 40px 28px 64px; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.9em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
p { margin: 0.8em 0; }
img, video { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 12px; background: #f6f8fa; border-radius: 6px; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; max-width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; }
a { color: #0969da; text-decoration: none; }
@page { margin: 16mm; }
@media print { article { max-width: none; padding: 0; } }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 移除危险节点/属性，保留正文结构 */
function sanitizeContentHtml(contentHtml: string): string {
  const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
  for (const selector of DANGEROUS_ELEMENTS) {
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
 * 构建清洗后的完整 HTML。
 *
 * @param contentHtml Defuddle 正文 HTML
 * @param pageUrl 原页面 URL（用于 <base>）
 * @param title 文档标题
 */
export function buildCleanedHtml(contentHtml: string, pageUrl: string, title: string): string {
  const body = sanitizeContentHtml(contentHtml);
  const safeTitle = escapeHtml(title.trim() || '剪藏');
  const base = escapeHtml(pageUrl);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${base}">
<title>${safeTitle}</title>
<style>${READER_CSS}</style>
</head>
<body><article>${body}</article></body>
</html>`;
}

/** 正文质量判定（面板提示用） */
export type ClipperQuality = 'good' | 'low' | 'unavailable';

export function assessQuality(input: {
  readonly textLength: number;
  readonly markdownLength: number;
  readonly imageCount: number;
  readonly hasCanvas: boolean;
}): ClipperQuality {
  if (input.markdownLength >= 400) return 'good';
  if (input.markdownLength >= 100) return 'low';
  // 图片/canvas 页面：正文文本少但可能有可视内容，提示用快照而不是直接判定不可用
  if (input.imageCount >= 3 || input.hasCanvas) return 'low';
  return input.textLength >= 200 ? 'low' : 'unavailable';
}
