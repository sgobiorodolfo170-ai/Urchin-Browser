/**
 * M25 邮箱模块 · 邮件 HTML 预处理（主进程）
 *
 * 依据：用户反馈「邮件图片无法显示、格式丢失」（2026-09-25）
 * 职责：
 * 1. cid: 内嵌图片重写为 data: URI（邮件正文引用的附件图片，如 cid:xxx → base64 内联）
 * 2. 危险元素剥离：script/form/meta/base/iframe/object/embed + on* 事件属性 + javascript: 协议
 *
 * 安全模型（纵深防御）：
 * - 本函数剥离为**第二层**；**第一层**是渲染侧 iframe sandbox（无 allow-scripts/allow-forms），
 *   脚本与表单提交在浏览器层面已被阻断；正则剥离不追求完美，残余风险由 sandbox 兜住。
 * - 渲染文档经 urchin://mail-content 协议以独立 CSP 下发（default-src 'none'，
 *   仅放行 img/style/font/media），与主窗口 CSP 解耦——主窗口 CSP 不因此放宽。
 */
import type { MailAttachmentContent } from './types';

/** 去掉 contentId 的尖括号：'<abc@x>' → 'abc@x' */
function normalizeCid(contentId: string | undefined): string | null {
  if (!contentId) return null;
  const trimmed = contentId.trim();
  const stripped =
    trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
  return stripped.length > 0 ? stripped : null;
}

/**
 * 将 HTML 中的 cid: 引用重写为 data: URI。
 * 仅处理在 HTML 中被引用的附件（避免无关附件占用内存）。
 */
export function rewriteCidImages(
  html: string,
  attachments: readonly MailAttachmentContent[],
): string {
  let out = html;
  for (const att of attachments) {
    const cid = normalizeCid(att.contentId);
    if (!cid || !att.contentBase64) continue;
    const dataUri = `data:${att.contentType};base64,${att.contentBase64}`;
    // cid: 引用出现形式：src="cid:xxx" / src='cid:xxx' / url(cid:xxx)
    out = out.split(`cid:${cid}`).join(dataUri);
  }
  return out;
}

/** 剥离危险元素（见模块注释的安全模型：sandbox 兜底，此处做第二层） */
export function sanitizeMailHtml(html: string): string {
  return (
    html
      // script 标签（含内容与自闭合）
      .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<script[^>]*\/?>/gi, '')
      // form / iframe / object / embed 整体剥离
      .replace(/<(form|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(form|iframe|object|embed)[^>]*\/?>/gi, '')
      // meta（防 refresh 跳转）/ base（防相对链接劫持）
      .replace(/<(meta|base)[^>]*>/gi, '')
      // on* 事件属性（onclick= 等；三种引号形态）
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
      // javascript: / vbscript: 协议链接
      .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '$1=$2#$2')
  );
}

/** 组合预处理：cid 重写 + 剥离 */
export function prepareMailHtml(
  html: string,
  attachments: readonly MailAttachmentContent[],
): string {
  return sanitizeMailHtml(rewriteCidImages(html, attachments));
}
