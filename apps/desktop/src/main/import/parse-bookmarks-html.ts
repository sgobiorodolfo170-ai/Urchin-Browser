/**
 * Import 域 · Netscape 书签 HTML 解析器（纯函数，无 I/O）
 *
 * 适用范围：Chrome / Edge / Firefox 导出的 bookmarks.html（Netscape Bookmark File Format）。
 *
 * 格式要点（tolerant 解析）：
 * - <DT><H3 ...>文件夹名</H3> → 文件夹（后续 <DL> 包裹其子项）
 * - <DT><A HREF="..." ...>书签名</A> → 书签
 * - <DL> / </DL> 控制层级嵌套；<DT>、<p>、<DT> 等容器标签可忽略
 * - <H3> 与随后的 <DL> 配对：H3 先创建待入栈的文件夹节点，<DL> 时入栈
 * - 最外层 <DL>（无前置 H3）不额外加层，根节点直接承载顶级书签/文件夹
 *
 * 设计理由（agents.md §六 可测试性）：
 * - 纯函数，输入字符串输出 ImportTreeNode；无文件 I/O，便于 jsdom/vitest 单测
 * - HTML 实体解码（&amp; &lt; &gt; &quot; &#39;）保证标题原样还原
 * - 容忍 Firefox 不闭合的 <DT>（解析器按 token 流推进，不依赖配对标签）
 */
import type { ImportTreeNode } from './types';

/** token 正则：匹配 <DL...> | </DL> | <H3 ...>text</H3> | <A ...>text</A>。 */
const TOKEN_RE = /<DL\b[^>]*>|<\/DL>|<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>/gi;

/** 可变文件夹节点（解析期间原地修改 children）。 */
interface MutableFolder extends ImportTreeNode {
  children: ImportTreeNode[];
}

/** HTML 实体解码（覆盖 Netscape 导出常见的 5 种实体）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 从 <A> 标签属性串提取 HREF（容忍大小写与属性顺序）。 */
function extractHref(attrs: string): string | undefined {
  const m = /HREF\s*=\s*"([^"]*)"/i.exec(attrs);
  return m ? decodeEntities(m[1]!) : undefined;
}

/**
 * 解析 Netscape 书签 HTML 为 ImportTreeNode 树。
 *
 * @param html 书签 HTML 文件内容（UTF-8）
 * @returns 根节点（title="导入的书签"，children 为顶级书签/文件夹）
 */
export function parseNetscapeBookmarksHtml(html: string): ImportTreeNode {
  const root: MutableFolder = { title: '导入的书签', children: [] };
  const stack: MutableFolder[] = [root];
  let pendingFolder: MutableFolder | null = null;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(html)) !== null) {
    const full = m[0] ?? '';
    const upper = full.toUpperCase();

    if (upper.startsWith('<DL')) {
      // <DL> 进入新作用域：优先用最近的 H3 文件夹（pendingFolder），
      // 否则最外层包裹 DL（stack 长度=1）不加层，其余情况建匿名文件夹
      if (pendingFolder) {
        stack.push(pendingFolder);
        pendingFolder = null;
      } else if (stack.length > 1) {
        const anon: MutableFolder = { title: '', children: [] };
        stack[stack.length - 1]!.children.push(anon);
        stack.push(anon);
      }
      // stack.length === 1 且无 pending：最外层 DL，保持 root 为作用域
    } else if (upper.startsWith('</DL')) {
      if (stack.length > 1) stack.pop();
      pendingFolder = null;
    } else if (upper.startsWith('<H3')) {
      const title = decodeEntities((m[1] ?? '').trim());
      const folder: MutableFolder = { title: title || '未命名文件夹', children: [] };
      stack[stack.length - 1]!.children.push(folder);
      pendingFolder = folder;
    } else if (upper.startsWith('<A')) {
      const url = extractHref(m[2] ?? '');
      const title = decodeEntities((m[3] ?? '').trim());
      if (url) {
        stack[stack.length - 1]!.children.push({ title: title || url, url });
      }
    }
  }

  return root;
}
