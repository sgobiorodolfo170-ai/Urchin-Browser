/**
 * @urchin/summary-agent · 网页内容提取器
 *
 * 参考 web-extractor (Python) 的提取→清洗流程，移植为 TypeScript 实现。
 * 设计要点：
 * - 提取脚本运行在页面 DOM 上下文（通过 webContents.executeJavaScript）
 * - 去除导航、侧边栏、页脚、广告、脚本等非正文元素
 * - 保留正文中的超链接、图片、表格、代码块
 * - 规范化链接（相对→绝对）、还原懒加载图片
 * - 属性白名单剥离（去内联 style、追踪 class）
 */

// ───────────────── 提取结果 ─────────────────

/** 页面提取结果（由运行在页面上下文中的脚本返回） */
export interface ExtractionResult {
  /** 正文 HTML 片段（已去除冗余元素） */
  readonly contentHtml: string;
  /** 正文纯文本（用于字数统计） */
  readonly contentText: string;
  /** 页面标题 */
  readonly title: string;
  /** meta description */
  readonly description: string;
  /** meta author */
  readonly author: string;
  /** 发布日期（meta article:published_time 或 time 标签） */
  readonly publishDate: string;
  /** 站点名称（meta application-name 或 og:site_name） */
  readonly siteName: string;
  /** 页面语言 */
  readonly language: string;
  /** 最终 URL（可能经过重定向） */
  readonly finalUrl: string;
  /** 是否成功提取到正文 */
  readonly extracted: boolean;
}

// ───────────────── 页面提取脚本 ─────────────────

/**
 * 运行在页面 DOM 上下文中的提取脚本。
 *
 * 通过 webContents.executeJavaScript 注入执行，返回序列化结果。
 * 算法参考 trafilatura / readability 的核心思路：
 * 1. 克隆 document 避免修改原始页面
 * 2. 移除非正文标签（script/style/nav/footer/aside/form 等）
 * 3. 优先选取 article/main/[role=main] 作为正文容器
 * 4. 回退到文本密度最高的元素
 * 5. 清理属性、还原懒加载图片、规范化链接
 *
 * 注意：此函数会被 toString() 序列化后注入页面执行，
 * 因此不能引用外部变量，必须是自包含的。
 */
export const PAGE_EXTRACT_SCRIPT = `
(function extractPage() {
  const DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'noscript', 'svg', 'canvas',
    'nav', 'footer', 'aside', 'form', 'button', 'input', 'select',
    'textarea', 'template', 'details', 'summary',
  ]);

  // 允许保留的属性白名单
  const ALLOWED_ATTRS = {
    a: new Set(['href', 'title']),
    img: new Set(['src', 'alt', 'title', 'width', 'height']),
    table: new Set(['border', 'cellpadding', 'cellspacing']),
    th: new Set(['colspan', 'rowspan']),
    td: new Set(['colspan', 'rowspan']),
    blockquote: new Set(['cite']),
    code: new Set(['class']),
    pre: new Set(['class']),
  };

  function getMeta(name, attr) {
    attr = attr || 'name';
    const el = document.querySelector('meta[' + attr + '="' + name + '"]')
            || document.querySelector('meta[property="' + name + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function dropUnwanted(root) {
    for (const tag of DROP_TAGS) {
      root.querySelectorAll(tag).forEach(function(el) { el.remove(); });
    }
    // 移除 HTML 注释
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT, null);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(function(c) { c.remove(); });
    // 移除 hidden 元素
    root.querySelectorAll('[hidden], [aria-hidden="true"]').forEach(function(el) { el.remove(); });
  }

  function restoreLazyImages(root) {
    root.querySelectorAll('img').forEach(function(img) {
      const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-img'];
      for (const attr of lazyAttrs) {
        if (img.getAttribute(attr)) {
          img.setAttribute('src', img.getAttribute(attr));
          img.removeAttribute(attr);
          break;
        }
      }
      if (!img.getAttribute('src')) img.remove();
    });
  }

  function normalizeLinks(root, baseUrl) {
    function abs(url) {
      try { return new URL(url, baseUrl).href; } catch(e) { return url; }
    }
    root.querySelectorAll('a[href]').forEach(function(a) {
      a.setAttribute('href', abs(a.getAttribute('href')));
    });
    root.querySelectorAll('img[src]').forEach(function(img) {
      img.setAttribute('src', abs(img.getAttribute('src')));
    });
  }

  function stripAttributes(root) {
    root.querySelectorAll('*').forEach(function(tag) {
      const allowed = ALLOWED_ATTRS[tag.tagName.toLowerCase()];
      const allowedSet = allowed || ALLOWED_ATTRS['*'] || new Set();
      for (const attr of Array.from(tag.attributes)) {
        const name = attr.name;
        if (name === 'class' && (tag.tagName.toLowerCase() === 'code' || tag.tagName.toLowerCase() === 'pre')) {
          const classes = (tag.getAttribute('class') || '').split(/\\s+/).filter(function(c) {
            return c.startsWith('language-');
          });
          tag.removeAttribute('class');
          if (classes.length > 0) tag.setAttribute('class', classes.join(' '));
          continue;
        }
        if (!allowedSet.has(name)) tag.removeAttribute(name);
      }
    });
  }

  function removeAnchorMarkers(root) {
    root.querySelectorAll('a').forEach(function(a) {
      const text = (a.textContent || '').trim();
      if ((text === '\\u00b6' || text === '#') && (a.getAttribute('href') || '').includes('#')) {
        a.remove();
      }
    });
  }

  function inlineShortPre(root, maxLen) {
    maxLen = maxLen || 40;
    root.querySelectorAll('pre').forEach(function(pre) {
      var text = pre.textContent || '';
      if (text.indexOf('\\n') === -1 && text.trim().length <= maxLen) {
        var innerCode = pre.querySelector('code');
        if (innerCode) {
          var code = document.createElement('code');
          // 保留 language-* class
          var cls = innerCode.getAttribute('class');
          if (cls) code.setAttribute('class', cls);
          code.textContent = innerCode.textContent;
          pre.replaceWith(code);
        } else {
          var code2 = document.createElement('code');
          code2.textContent = text;
          pre.replaceWith(code2);
        }
      }
    });
  }

  function removeEmptyNodes(root) {
    var voidLike = new Set(['img', 'br', 'hr', 'source']);
    for (var round = 0; round < 3; round++) {
      var removed = 0;
      root.querySelectorAll('*').forEach(function(tag) {
        if (voidLike.has(tag.tagName.toLowerCase())) return;
        var hasText = (tag.textContent || '').trim().length > 0;
        var hasImg = tag.querySelector('img') !== null;
        if (!hasText && !hasImg) { tag.remove(); removed++; }
      });
      if (removed === 0) break;
    }
  }

  function findMainContent(docClone) {
    // 优先 article / main / [role=main]
    var main = docClone.querySelector('article')
            || docClone.querySelector('main')
            || docClone.querySelector('[role="main"]');
    if (main && (main.textContent || '').trim().length > 200) return main;

    // 回退：文本密度最高的元素
    var candidates = docClone.querySelectorAll('div, section');
    var best = null;
    var bestScore = 0;
    candidates.forEach(function(el) {
      var text = (el.textContent || '').trim();
      if (text.length < 200) return;
      var links = el.querySelectorAll('a').length;
      var score = text.length - links * 50; // 链接密度惩罚
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best || docClone.body;
  }

  // ── 主流程 ──
  var baseUrl = location.href;
  var docClone = document.cloneNode(true);

  dropUnwanted(docClone);

  var main = findMainContent(docClone);
  if (!main) {
    return {
      contentHtml: '', contentText: '', title: document.title || '',
      description: '', author: '', publishDate: '', siteName: '',
      language: document.documentElement.lang || '',
      finalUrl: baseUrl, extracted: false,
    };
  }

  restoreLazyImages(main);
  normalizeLinks(main, baseUrl);
  stripAttributes(main);
  removeAnchorMarkers(main);
  inlineShortPre(main);
  removeEmptyNodes(main);

  var contentHtml = main.innerHTML.trim();
  var contentText = (main.textContent || '').trim();
  var title = getMeta('og:title', 'property') || document.title || '';
  var description = getMeta('description') || getMeta('og:description', 'property') || '';
  var author = getMeta('author') || getMeta('article:author', 'property') || '';
  var publishDate = getMeta('article:published_time', 'property')
                  || (docClone.querySelector('time') ? (docClone.querySelector('time').getAttribute('datetime') || '') : '');
  var siteName = getMeta('application-name') || getMeta('og:site_name', 'property') || '';
  var language = document.documentElement.lang || getMeta('og:locale', 'property') || '';

  return {
    contentHtml: contentHtml,
    contentText: contentText,
    title: title,
    description: description,
    author: author,
    publishDate: publishDate,
    siteName: siteName,
    language: language,
    finalUrl: baseUrl,
    extracted: contentText.length > 0,
  };
})()
`;

/**
 * 从 webContents 执行页面提取脚本。
 *
 * @param executeJs 执行 JS 的函数（通常为 webContents.executeJavaScript）
 * @returns 提取结果
 */
export async function extractPageContent(
  executeJs: (script: string) => Promise<unknown>,
): Promise<ExtractionResult> {
  const result = (await executeJs(PAGE_EXTRACT_SCRIPT)) as ExtractionResult;
  return result;
}
