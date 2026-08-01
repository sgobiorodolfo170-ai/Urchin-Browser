/**
 * @urchin/summary-agent · HTML 文档格式化器
 *
 * 参考 web-extractor (Python) 的 formatter.py，移植为 TypeScript 实现。
 * 将提取并清洗后的正文 HTML 包装为完整的自包含 HTML 文档。
 *
 * 设计要点：
 * - 加上 <!DOCTYPE html>、<head>、元信息
 * - 阅读友好排版：字体、行高、最大宽度
 * - 文档头部展示来源、作者、日期、原文链接
 * - 深色模式支持、打印优化、响应式
 */

import type { ExtractionResult } from './extractor';

/** HTML 转义 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 构造元数据行 */
function buildMetaRows(extraction: ExtractionResult): [string, string][] {
  const rows: [string, string][] = [];
  rows.push([
    '原文链接',
    `<a href="${escapeHtml(extraction.finalUrl)}" target="_blank" rel="noopener">${escapeHtml(extraction.finalUrl)}</a>`,
  ]);
  if (extraction.author) rows.push(['作者', escapeHtml(extraction.author)]);
  if (extraction.publishDate) rows.push(['发布日期', escapeHtml(extraction.publishDate)]);
  if (extraction.siteName) rows.push(['来源', escapeHtml(extraction.siteName)]);
  if (extraction.description) rows.push(['摘要', escapeHtml(extraction.description)]);
  const wordCount = extraction.contentText.length;
  rows.push(['正文字数', wordCount.toLocaleString()]);
  return rows;
}

/** 渲染元数据表格 */
function renderMetaBlock(rows: [string, string][]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(([label, value]) => `      <tr><td>${label}</td><td>${value}</td></tr>`)
    .join('\n');
  return `<table class="meta-table">\n${body}\n    </table>`;
}

/**
 * 生成最终的 HTML 文档。
 *
 * @param extraction 提取结果
 * @returns 完整的自包含 HTML 文档字符串
 */
export function formatDocument(extraction: ExtractionResult): string {
  const title = extraction.title || '无标题';
  const metaRows = buildMetaRows(extraction);
  const metaBlock = renderMetaBlock(metaRows);
  const lang = escapeHtml(extraction.language || 'zh-CN');
  const now = new Date();
  const extractedAt = now.toISOString().slice(0, 19);
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-source-url" content="${escapeHtml(extraction.finalUrl)}">
<meta name="x-extracted-at" content="${extractedAt}">
<meta name="x-extractor" content="urchin-summary-agent/0.1.0">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --fg: #1f2328;
  --fg-muted: #57606a;
  --border: #d0d7de;
  --bg: #ffffff;
  --bg-muted: #f6f8fa;
  --link: #0969da;
  --link-hover: #0550ae;
  --code-bg: #f6f8fa;
  --max-width: 820px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 2rem 1rem 4rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.75;
  color: var(--fg);
  background: var(--bg);
  word-wrap: break-word;
}
.container { max-width: var(--max-width); margin: 0 auto; }
.doc-header {
  margin-bottom: 2rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.doc-header h1 { font-size: 1.85rem; line-height: 1.3; margin: 0 0 0.75rem; }
.meta-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  color: var(--fg-muted);
}
.meta-table td { padding: 0.25rem 0; vertical-align: top; }
.meta-table td:first-child {
  width: 5.5rem;
  padding-right: 1rem;
  text-align: right;
  white-space: nowrap;
}
.meta-table a { color: var(--link); text-decoration: none; word-break: break-all; }
.meta-table a:hover { text-decoration: underline; }
.content { font-size: 1rem; }
.content h1, .content h2, .content h3, .content h4 {
  line-height: 1.3;
  margin-top: 1.8em;
  margin-bottom: 0.6em;
}
.content h1 { font-size: 1.6rem; }
.content h2 { font-size: 1.35rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.content h3 { font-size: 1.15rem; }
.content p { margin: 0 0 1em; }
.content a { color: var(--link); }
.content a:hover { color: var(--link-hover); text-decoration: underline; }
.content img { max-width: 100%; height: auto; border-radius: 4px; margin: 1em 0; }
.content blockquote {
  margin: 1em 0;
  padding: 0.5em 1em;
  border-left: 4px solid var(--border);
  color: var(--fg-muted);
  background: var(--bg-muted);
}
.content pre {
  padding: 1em;
  background: var(--code-bg);
  border-radius: 6px;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.6;
}
.content code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.content :not(pre) > code { padding: 0.15em 0.35em; background: var(--code-bg); border-radius: 3px; }
.content table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9rem; }
.content th, .content td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
.content th { background: var(--bg-muted); font-weight: 600; }
.content ul, .content ol { padding-left: 1.5em; }
.content li { margin: 0.25em 0; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
.doc-footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.8rem;
  color: var(--fg-muted);
  text-align: center;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3;
    --fg-muted: #8b949e;
    --border: #30363d;
    --bg: #0d1117;
    --bg-muted: #161b22;
    --link: #58a6ff;
    --link-hover: #79c0ff;
    --code-bg: #161b22;
  }
}
@media print {
  body { padding: 0; font-size: 11pt; }
  .doc-header { page-break-after: avoid; }
  a { color: var(--fg); text-decoration: none; }
}
</style>
</head>
<body>
<div class="container">
  <header class="doc-header">
    <h1>${escapeHtml(title)}</h1>
    ${metaBlock}
  </header>
  <article class="content">
${extraction.contentHtml || '<p><em>未能提取到正文内容。</em></p>'}
  </article>
  <footer class="doc-footer">
    本文档由 Urchin AI 助手自动生成 &middot; ${dateStr}
  </footer>
</div>
</body>
</html>`;
}
