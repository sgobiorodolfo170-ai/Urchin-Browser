import { Marked } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 仅生成可在浏览器标签中打开的绝对网址。 */
export function safeNoteUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// 独立实例避免改变文件查看器及其它模块的 marked 配置。
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 旧纯文本中的 HTML 保留为可见文字，绝不作为元素执行。
    html: ({ text }) => escapeHtml(text),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const url = safeNoteUrl(href);
      return url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : text;
    },
    image({ href, text }) {
      const url = safeNoteUrl(href);
      return url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}" loading="lazy" referrerpolicy="no-referrer">`
        : escapeHtml(text);
    },
  },
});

export function renderNoteMarkdown(content: string): string {
  return markdown.parse(content, { async: false });
}
