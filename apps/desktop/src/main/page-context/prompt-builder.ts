/**
 * M14 Page Context Extractor · prompt 拼装
 *
 * 依据：契约 F §5 / PC5 决策（XML 包裹格式）
 *
 * 职责：
 * 把 ExtractedPageContext 拼装为可注入 Provider 的 CompletionRequest.messages，
 * 主流 LLM 对 XML 标签结构敏感，能正确区分"上下文"与"用户问题"。
 *
 * XML 包裹格式理由（PC5）：
 * - 比 JSON 更适合长文本（无需转义换行）
 * - 比 markdown 边界更明确（LLM 不会把页面内容误认为 system prompt 部分）
 */
import type { ChatMessage, ExtractedPageContext } from '@urchin/ipc-contract';
import type { CompletionRequest } from '@urchin/ai-provider-contract';

/** PC3 决策：上下文内容长度上限（在拼装 prompt 时再次截断保险） */
const PROMPT_CONTENT_MAX_LENGTH = 50_000;

/** PC5 决策：XML 转义 */
function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c] ?? c,
  );
}

/**
 * 把 ExtractedPageContext 拼成 XML 包裹的字符串（PC5）。
 *
 * @param ctx 抽取出的页面上下文
 * @returns XML 字符串
 */
export function buildContextXml(ctx: ExtractedPageContext): string {
  const content = ctx.markdown.slice(0, PROMPT_CONTENT_MAX_LENGTH);
  const warningsXml =
    ctx.warnings.length > 0
      ? `  <warnings>${ctx.warnings.map((w) => `<warning>${escapeXml(w)}</warning>`).join('')}</warnings>\n`
      : '';

  return `<page_context>
  <url>${escapeXml(ctx.url)}</url>
  <title>${escapeXml(ctx.title)}</title>
  <extracted_at>${escapeXml(ctx.extractedAt)}</extracted_at>${ctx.siteName ? `\n  <site_name>${escapeXml(ctx.siteName)}</site_name>` : ''}${ctx.byline ? `\n  <byline>${escapeXml(ctx.byline)}</byline>` : ''}${ctx.excerpt ? `\n  <excerpt>${escapeXml(ctx.excerpt)}</excerpt>` : ''}${ctx.language ? `\n  <language>${escapeXml(ctx.language)}</language>` : ''}
  <content>
${escapeXml(content)}
  </content>
${warningsXml}</page_context>`.trim();
}

/**
 * 构建 CompletionRequest（PC5）。
 *
 * - system 消息：声明助手身份与任务
 * - user 消息：XML 上下文 + 用户问题
 *
 * @param ctx 抽取出的页面上下文
 * @param userQuestion 用户问题
 * @param model 模型名
 */
export function buildContextPrompt(
  ctx: ExtractedPageContext,
  userQuestion: string,
  model: string,
): CompletionRequest {
  const pageXml = buildContextXml(ctx);
  const messages: readonly ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a helpful assistant analyzing the current page the user is viewing. Use the provided page context to answer the user question accurately.',
    },
    {
      role: 'user',
      content: `${pageXml}\n\nUser question: ${userQuestion}`,
    },
  ];

  return {
    messages,
    model,
  };
}
