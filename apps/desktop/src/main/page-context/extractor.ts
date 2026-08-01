/**
 * M14 Page Context Extractor · 核心抽取器
 *
 * 依据：契约 F §2-§4 / PC1-PC8 决策
 *
 * 职责：
 * 1. 在 tab webContents 内执行抽取脚本（PC2/PC8 决策：executeJavaScript 注入）
 * 2. 优先策略：DOM 简化抽取（article/main/内容节点 + innerText）
 * 3. 回退策略：document.body.innerText 裸文本（PC7 决策）
 * 4. 长度截断（PC3：默认 50_000 字符 / PC4：标题 + 摘要 + 前 N 字符）
 * 5. 警告生成（paywall 检测 / 长度超限等）
 *
 * v0.1 demo 范围说明：
 * - 暂不引入 @mozilla/readability 依赖（构建期内联 bundle 见 PC8）
 * - 使用 DOM API 直接抽取主要内容节点，标记 extraction_method: 'dom-simplified'
 * - v0.2+ 升级到 Readability（extraction_method: 'readability'）+ turndown markdown 转换
 *
 * 不在本文件实现的职责：
 * - prompt 拼装（见 prompt-builder.ts，PC5 XML 包裹）
 * - 隐私同意（PC6，UI 层处理）
 */
import { createLogger } from '@urchin/logger';
import type { WebContentsLike } from '../tabs/types';
import type { ExtractedPageContext } from '@urchin/ipc-contract';

const log = createLogger('page-context');

/** PC3 决策：默认最大字符数 50_000（粗略 ~12k token） */
export const DEFAULT_MAX_LENGTH = 50_000;

/** 抽取超时 5s（契约 F §6：抽取导致 tab 性能下降 → 5s 自动 fallback） */
const EXTRACT_TIMEOUT_MS = 5_000;

/**
 * 在页面上下文执行的 DOM 简化抽取脚本。
 *
 * 策略（按优先级）：
 * 1. <article> 元素的 innerText
 * 2. <main> 元素的 innerText
 * 3. 常见内容容器选择器 [role=main] / .content / .post-body / .article-body
 * 4. 回退到 body.innerText（extraction_method: 'raw-text'）
 *
 * 同时抽取：
 * - 标题（document.title / <h1> / og:title meta）
 * - 作者（byline meta / rel=author）
 * - 站点名称（og:site_name meta）
 * - 摘要（meta description / 前 200 字符）
 * - 语言（document.documentElement.lang）
 *
 * 返回值结构需与 ExtractedPageContext 字段对齐（除 url / extractedAt 外）。
 */
const DOM_EXTRACT_SCRIPT = `
(function() {
  // 工具：安全读取 meta content
  function meta(name, attr) {
    attr = attr || 'name';
    var el = document.querySelector('meta[' + attr + '="' + name + '"]');
    return el && el.getAttribute('content') ? el.getAttribute('content') : null;
  }

  // 工具：安全读取 rel=author link
  function authorLink() {
    var el = document.querySelector('link[rel="author"]');
    return el && el.getAttribute('title') ? el.getAttribute('title') : null;
  }

  // 抽取标题
  var title = document.title
    || (document.querySelector('h1') && document.querySelector('h1').innerText)
    || meta('og:title', 'property')
    || '';

  // 抽取作者
  var byline = meta('author')
    || authorLink()
    || meta('article:author', 'property')
    || null;

  // 抽取站点名
  var siteName = meta('og:site_name', 'property') || null;

  // 抽取摘要
  var excerpt = meta('description') || meta('og:description', 'property') || null;

  // 抽取语言
  var lang = document.documentElement.lang || null;

  // 抽取主体内容（按优先级尝试多个选择器）
  var candidates = [
    'article',
    'main',
    '[role="main"]',
    '.content',
    '.post-body',
    '.article-body',
    '.entry-content',
    '#content'
  ];
  var mainEl = null;
  var method = 'dom-simplified';
  for (var i = 0; i < candidates.length; i++) {
    var el = document.querySelector(candidates[i]);
    if (el && el.innerText && el.innerText.trim().length > 200) {
      mainEl = el;
      break;
    }
  }
  if (!mainEl) {
    mainEl = document.body;
    method = 'raw-text';
  }

  var textContent = (mainEl.innerText || '').trim();
  var length = textContent.length;

  // 简化 markdown：标题 + 段落（v0.1 demo：仅返回纯文本，v0.2+ 用 turndown）
  var markdown = textContent;

  return {
    title: title,
    byline: byline,
    excerpt: excerpt,
    textContent: textContent,
    markdown: markdown,
    length: length,
    language: lang,
    siteName: siteName,
    extraction_method: method,
  };
})();
`;

/** 抽取脚本返回的原始结构 */
interface DomExtractResult {
  readonly title: string | null;
  readonly byline: string | null;
  readonly excerpt: string | null;
  readonly textContent: string;
  readonly markdown: string;
  readonly length: number;
  readonly language: string | null;
  readonly siteName: string | null;
  readonly extraction_method: 'dom-simplified' | 'raw-text';
}

/**
 * Page Context Extractor。
 *
 * 通过 executeJavaScript 在 tab webContents 内运行 DOM 抽取脚本，
 * 不在主进程引入 DOMParser/jsdom（PC8 决策）。
 */
export class PageContextExtractor {
  /**
   * 抽取指定 tab 的页面正文。
   *
   * @param webContents 目标 tab 的 webContents
   * @param maxLength 最大字符数（PC3，默认 50_000）
   * @returns ExtractedPageContext 结构化上下文
   * @throws 抽取失败（脚本错误 / 超时）
   */
  async extract(
    webContents: WebContentsLike,
    maxLength: number = DEFAULT_MAX_LENGTH,
  ): Promise<ExtractedPageContext> {
    log.info('extract start', { url: webContents.getURL(), maxLength });

    // PC2/PC8：在 tab webContents 内执行脚本（带超时保护）
    const raw = await this.executeWithTimeout<DomExtractResult>(
      webContents,
      DOM_EXTRACT_SCRIPT,
      EXTRACT_TIMEOUT_MS,
    );

    if (!raw || typeof raw !== 'object' || typeof raw.textContent !== 'string') {
      log.warn('extract returned invalid result, fallback to raw-text', { raw });
      return this.fallbackExtract(webContents, maxLength);
    }

    // 长度截断（PC3/PC4）
    const warnings: string[] = [];
    let textContent = raw.textContent;
    let markdown = raw.markdown;
    if (textContent.length > maxLength) {
      warnings.push(`Content too long (${textContent.length} chars), truncated to ${maxLength}`);
      // PC4：标题 + 摘要 + 前 N 字符
      const truncated = textContent.slice(0, maxLength);
      textContent = truncated;
      markdown = truncated;
    }

    // paywall 检测（契约 F §3 checkWarnings）
    if (/paywall|subscribe|订阅|付费阅读/i.test(textContent)) {
      warnings.push('Paywall detected');
    }

    const result: ExtractedPageContext = {
      url: webContents.getURL(),
      title: raw.title ?? '',
      extractedAt: new Date().toISOString(),
      byline: raw.byline ?? undefined,
      excerpt: raw.excerpt ?? undefined,
      textContent,
      markdown,
      length: raw.length,
      language: raw.language ?? undefined,
      siteName: raw.siteName ?? undefined,
      extraction_method: raw.extraction_method,
      warnings,
    };

    log.info('extract done', {
      url: result.url,
      method: result.extraction_method,
      length: result.length,
      warnings: result.warnings.length,
    });

    return result;
  }

  /**
   * PC7 决策：Readability 失败时回退到 body.innerText。
   */
  private async fallbackExtract(
    webContents: WebContentsLike,
    maxLength: number,
  ): Promise<ExtractedPageContext> {
    log.warn('using fallback raw-text extraction');

    const text = await this.executeWithTimeout<string>(
      webContents,
      'document.body ? (document.body.innerText || "") : ""',
      EXTRACT_TIMEOUT_MS,
    );

    const safeText = typeof text === 'string' ? text : '';
    const truncated = safeText.slice(0, maxLength);
    const warnings: string[] = ['Readability failed, used raw text fallback'];
    if (safeText.length > maxLength) {
      warnings.push(`Content too long (${safeText.length} chars), truncated to ${maxLength}`);
    }

    const title = await this.executeWithTimeout<string>(
      webContents,
      'document.title || ""',
      EXTRACT_TIMEOUT_MS,
    ).catch(() => '');

    return {
      url: webContents.getURL(),
      title: typeof title === 'string' ? title : '',
      extractedAt: new Date().toISOString(),
      textContent: truncated,
      markdown: truncated,
      length: safeText.length,
      extraction_method: 'raw-text',
      warnings,
    };
  }

  /**
   * 带超时保护执行 executeJavaScript。
   * 契约 F §6：抽取导致 tab 性能下降 → 5s 自动 fallback。
   */
  private async executeWithTimeout<T>(
    webContents: WebContentsLike,
    code: string,
    timeoutMs: number,
  ): Promise<T> {
    // 保存 timer handle，Promise.race 结束后立即 clearTimeout，
    // 避免 executeJavaScript 先 resolve 时 timer 残留 5s 才触发（产生无人捕获的 rejected Promise）
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        webContents.executeJavaScript<T>(code, true),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`executeJavaScript timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
