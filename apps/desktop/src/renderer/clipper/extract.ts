/**
 * M26 剪藏 · 页面正文抽取（渲染进程）
 *
 * 使用与参考 Obsidian Web Clipper 同源的 Defuddle：
 * - 在面板渲染进程解析主进程传来的 HTML，避免主进程做 CPU 密集解析；
 * - useAsync:false 禁止 YouTube/Reddit 等异步抓取，保持剪藏只依赖当前页面；
 * - 选区存在且“选中优先”时，content 用选区 Markdown，否则使用 Defuddle 正文。
 */
import Defuddle, { createMarkdownContent } from 'defuddle/full';
import { sanitizeFragmentHtml } from './postprocess';

/** 抽取结果（页面元数据 + 两种 Markdown） */
export interface ClipperExtraction {
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly published: string;
  readonly description: string;
  readonly site: string;
  readonly domain: string;
  readonly language: string;
  readonly words: number;
  readonly favicon: string;
  readonly image: string;
  /** Defuddle 正文 HTML（用于清洗后 MHTML/PDF/截图导出） */
  readonly pageContentHtml: string;
  /** 整页正文 Markdown */
  readonly pageMarkdown: string;
  /** 选区 Markdown；无选区为空串 */
  readonly selectionMarkdown: string;
  /** 本次实际使用的 content Markdown（选中优先时为选区） */
  readonly contentMarkdown: string;
  /** 是否使用了选区 */
  readonly usedSelection: boolean;
}

interface DefuddleResultLike {
  readonly title?: string;
  readonly author?: string;
  readonly published?: string;
  readonly description?: string;
  readonly site?: string;
  readonly domain?: string;
  readonly language?: string;
  readonly wordCount?: number;
  readonly favicon?: string;
  readonly image?: string;
  readonly content?: string;
}

/**
 * 抽取页面正文。
 *
 * @param snapshot 主进程页面快照（html / selectionHtml / url / title）
 * @param selectionPriority 是否优先使用选区
 */
export function extractClipperContent(
  snapshot: {
    readonly html: string;
    readonly url: string;
    readonly title: string;
    readonly selectionHtml: string;
    readonly selectionText: string;
    readonly favicon?: string;
  },
  selectionPriority: boolean,
): ClipperExtraction {
  const doc = new DOMParser().parseFromString(snapshot.html, 'text/html');
  // DOMParser 的 doc.URL 为 about:blank；插入 <base> 保留图片/链接相对地址。
  if (!doc.querySelector('base')) {
    const base = doc.createElement('base');
    base.setAttribute('href', snapshot.url);
    doc.head?.prepend(base);
  }

  let result: DefuddleResultLike = {};
  let pageContentHtml = '';
  let pageMarkdown = '';
  try {
    const parsed = new Defuddle(doc, {
      url: snapshot.url,
      useAsync: false,
      markdown: false,
    }).parse() as unknown as DefuddleResultLike;
    result = parsed ?? {};
    pageContentHtml = parsed?.content ?? '';
    if (pageContentHtml) {
      pageMarkdown = createMarkdownContent(pageContentHtml, snapshot.url);
    }
  } catch {
    pageContentHtml = '';
    pageMarkdown = '';
  }

  // Defuddle 失败时回退到 body innerText，至少让用户能编辑/保存文本。
  if (!pageMarkdown.trim()) {
    pageContentHtml = doc.body?.innerHTML ?? '';
    const text = doc.body?.textContent ?? '';
    pageMarkdown = text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // 选区 HTML 先做安全净化（移除脚本/样式/表单/事件属性），避免选中优先
  // 把页面交互块或样式带进 Markdown；纯文本回退不经此处理。
  const selectionMarkdown =
    snapshot.selectionHtml.trim().length > 0
      ? createMarkdownContent(sanitizeFragmentHtml(snapshot.selectionHtml), snapshot.url)
      : snapshot.selectionText.trim();

  const canUseSelection = selectionPriority && selectionMarkdown.trim().length > 0;
  return {
    title: firstNonEmpty(result.title, snapshot.title),
    url: snapshot.url,
    author: (result.author ?? '').trim(),
    published: (result.published ?? '').trim(),
    description: (result.description ?? '').trim(),
    site: (result.site ?? '').trim(),
    domain: (result.domain ?? '').trim(),
    language: (result.language ?? '').trim(),
    words: typeof result.wordCount === 'number' ? result.wordCount : countWords(pageMarkdown),
    favicon: firstNonEmpty(result.favicon, snapshot.favicon),
    image: (result.image ?? '').trim(),
    pageContentHtml,
    pageMarkdown,
    selectionMarkdown,
    contentMarkdown: canUseSelection ? selectionMarkdown : pageMarkdown,
    usedSelection: canUseSelection,
  };
}

/** 取第一个非空白字符串（标题/favicon 等元数据回退） */
function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function countWords(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + latin;
}
