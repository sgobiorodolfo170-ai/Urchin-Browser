# 契约 F · M14 Page Context Extractor

> 状态：Draft  · 日期：2026-07-27  · 关联决策：PC1-PC8
> 模块归属：main + renderer  · 关联模块：M2 / M13 / M11
> 代码示例：文中代码为示意伪码，用于表达设计意图，非可编译实现。

## 1. 设计目标

把当前激活 tab 的页面正文抽取成结构化数据，喂给 Provider 作为对话上下文。这是「AI 原生」定位实质——Side Panel 能理解"用户当前看的是哪页"。

抽完后给 Provider 的 prompt 形如：

```
<page_context>
  url: https://example.com/article
  title: ...
  extracted_at: 2026-07-27T10:30:00Z
  content:
    ## Section 1
    ...
    ## Section 2
    ...
</page_context>

User question: 总结这段内容
```

## 2. 抽取流程（跨进程）

```
[Renderer Side Panel] 用户点「摘要当前页」
        │
        ▼
[Main Process] tabManager.getActiveTab(webContents)
        │
        ▼
[Tab webContents] executeJavaScript(注入的 Readability bundle)
        │   Readability 在页面上下文内直接解析 document（PC8 决策）
        ▼
[Tab webContents] 返回 Article JSON { title, content, textContent, length, ... }
        │
        ▼
[Main Process] M14 后处理（长度截断 / warnings / prompt 拼装）
        │
        ▼
[Main Process] 通过 IPC 转发给 AI Orchestrator
        ▼
[Provider Child] stream → tokens
```

> **PC8 决策（Readability 运行位置）**：Readability 在 **tab webContents 内**运行——通过 `executeJavaScript` 注入构建期内联的 Readability bundle，直接解析页面活 DOM。否决「Main 进程内解析」：Node 主进程没有 DOM/DOMParser，需引入 jsdom/linkedom 额外依赖，且整页 HTML 字符串跨进程回传成本高；否决「Main 重新 fetch URL」：无法处理 JS 渲染页面（与 PC2 一致）。

## 3. 抽取接口

```typescript
// packages/page-context/src/extractor.ts
// READABILITY_BUNDLE：构建期由打包器内联的 @mozilla/readability 产物字符串（PC8）
import type { WebContents } from 'electron';

export interface ExtractedPageContext {
  url: string;
  title: string;
  extractedAt: string;              // ISO timestamp
  byline?: string;                  // 作者
  excerpt?: string;                 // 摘要
  textContent: string;              // 纯文本
  markdown: string;                 // 简化 markdown（标题 + 段落 + 列表）
  length: number;                   // 字符数
  language?: string;
  siteName?: string;
  // 元数据
  extraction_method: 'readability' | 'dom-simplified' | 'raw-text';
  warnings?: string[];              // 长度超限、paywall 检测等警告
}

export class PageContextExtractor {
  async extract(webContents: WebContents): Promise<ExtractedPageContext> {
    // PC8：Readability 在 tab webContents 内运行（页面上下文自带 DOM，无需 jsdom）
    // READABILITY_BUNDLE 为构建期内联的 @mozilla/readability 打包产物（PC1 决策）
    const article = await webContents.executeJavaScript(`
      (function() {
        ${READABILITY_BUNDLE}
        const reader = new Readability(document.cloneNode(true));
        const a = reader.parse();
        return a ? {
          title: a.title, byline: a.byline, excerpt: a.excerpt,
          textContent: a.textContent, content: a.content, length: a.length,
          siteName: a.siteName, lang: document.documentElement.lang,
        } : null;
      })()
    `);

    if (!article) {
      return this.fallbackExtract(webContents);   // PC7 决策
    }

    return {
      url: webContents.getURL(),
      title: article.title ?? (await webContents.executeJavaScript('document.title')),
      extractedAt: new Date().toISOString(),
      byline: article.byline ?? undefined,
      excerpt: article.excerpt ?? undefined,
      textContent: article.textContent,
      markdown: this.toMarkdown(article),
      length: article.length,
      language: article.lang,
      siteName: article.siteName,
      extraction_method: 'readability',
      warnings: this.checkWarnings(article),
    };
  }

  private async fallbackExtract(webContents: WebContents): Promise<ExtractedPageContext> {
    // Readability 失败时（如 SPA / 动态内容），回退到 body 内文本
    const text = await webContents.executeJavaScript(`document.body.innerText`);
    return {
      url: webContents.getURL(),
      title: await webContents.executeJavaScript(`document.title`),
      extractedAt: new Date().toISOString(),
      textContent: text,
      markdown: text,
      length: text.length,
      extraction_method: 'raw-text',
      warnings: ['Readability failed, used raw text fallback'],
    };
  }

  private toMarkdown(article: any): string {
    // 把 Readability 的 HTML content 转为简化 markdown
    // 用 turndown 或自实现轻量转换
    return article.content;  // v0.1 直接传 HTML，让 Provider 自行处理；v0.2+ 引入 turndown
  }

  private checkWarnings(article: any): string[] {
    const w: string[] = [];
    if (article.length > 50_000) w.push('Content too long, will be truncated');   // PC3 决策
    if (article.textContent.match(/paywall|subscribe/i)) w.push('Paywall detected');
    return w;
  }
}
```

## 4. 长度约束与截断策略（PC3 + PC4 决策）

LLM 上下文窗口有上限（如 GPT-4 ~128k token / Claude 200k token）。Provider `complete` 或 `stream` 调用时如果传超长上下文会失败。

**策略**：
- `ExtractedPageContext.maxLength = 50_000` 字符（粗略 ~12k token，留安全边界）。
- 超长时按「标题 + 摘要 + 前 N 字符」截断，warnings 标记 `Content too long, will be truncated`。
- v0.2+ 引入分块策略（map-reduce 总结），由 M11 Orchestrator 处理。

## 5. 注入到 Provider prompt 的格式（PC5 决策：XML 包裹）

```typescript
// packages/page-context/src/prompt-builder.ts
export function buildContextPrompt(
  ctx: ExtractedPageContext,
  userQuestion: string,
): CompletionRequest {
  const pageXml = `
<page_context>
  <url>${ctx.url}</url>
  <title>${escapeXml(ctx.title)}</title>
  <extracted_at>${ctx.extractedAt}</extracted_at>
  <site_name>${escapeXml(ctx.siteName ?? '')}</site_name>
  <content>
${ctx.markdown.slice(0, 50_000)}
  </content>
${ctx.warnings?.length ? `  <warnings>${ctx.warnings.map(w => `<warning>${escapeXml(w)}</warning>`).join('')}</warnings>` : ''}
</page_context>`.trim();

  return {
    messages: [
      { role: 'system', content: 'You are a helpful assistant analyzing the current page the user is viewing.' },
      { role: 'user',   content: `${pageXml}\n\nUser question: ${userQuestion}` },
    ],
    stream: true,
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
```

**XML 包裹格式理由**：
- 主流 LLM（GPT-4/Claude/Gemini）对 XML 标签结构敏感，能正确区分"上下文"与"用户问题"。
- 比 JSON 更适合长文本（无需转义换行）。
- 比 markdown 边界更明确（LLM 不会把页面内容误认为 system prompt 部分）。

## 6. 安全与隐私（PC6 决策）

| 风险 | 缓解 |
|---|---|
| 抽取到密码/敏感表单字段 | Readability 默认会过滤表单元素；v0.2+ 加敏感字段扫描 |
| 把页面内容发给第三方 Provider 泄露隐私 | **UI 显式提示「即将发送当前页面内容到 {ProviderName}」，用户必须 opt-in**（PC6 决策）；保存后不重复问 |
| 跨域 iframe 内容被误抽 | 仅抽主 frame，不递归 iframe（v0.2+ 加 iframe 白名单） |
| 抽取导致 tab 性能下降 | executeJavaScript 在 webContents 进程跑，不阻塞 Main；抽取超时 5s 自动 fallback |

```typescript
// PC6 决策实现：用户偏好持久化
async function ensureContextShareConsent(providerId: string): Promise<boolean> {
  const key = `ai.context_share_consent.${providerId}`;
  const saved = await storage.get<boolean>(key);
  if (saved) return true;

  // 弹窗确认
  const consent = await showConsentDialog({
    title: '发送页面内容到 Provider',
    message: `即将发送当前页面内容到 ${providerId} 进行 AI 处理。是否同意？此选择将被记住，今后不再询问。`,
  });

  if (consent) await storage.set(key, true);
  return consent;
}
```

## 7. 决策记录（PC1-PC7）

| ID | 决策 | 选定方案 | 否决方案理由 |
|---|---|---|---|
| PC1 | 抽取算法 | @mozilla/readability（业界事实标准） | 自研正则不稳定；商用 API 违反本地优先 |
| PC2 | 抽取执行位置 | Tab webContents 内（executeJavaScript） | Main 进程 fetch URL 重新解析无法处理 JS 渲染页面 |
| PC3 | 长度限制 | 50_000 字符 + warning | 无限制会被 Provider 拒；极简 5k 信息丢失 |
| PC4 | 截断策略 | 标题 + 摘要 + 前 N 字符 | 末尾截断语义丢失；智能分块复杂度高（留 v0.2+） |
| PC5 | prompt 注入格式 | XML 包裹 | JSON 不适合长文本；markdown 边界模糊；直接拼接语义不清 |
| PC6 | 隐私确认 | 首次抽取时弹 warning，用户 opt-in 后保存偏好 | 每次都问烦；不问侵犯隐私 |
| PC7 | Readability 失败回退 | body.innerText 裸文本 + warning | 直接报错用户体验差 |
| PC8 | Readability 运行位置 | tab webContents 内（注入构建期内联 bundle） | Main 进程无 DOMParser 需引入 jsdom/linkedom 额外依赖；整页 HTML 跨进程回传成本高 |

## 8. 未来演进

- v0.2: 引入 turndown 做 HTML → 简化 markdown 转换；map-reduce 长文分块总结；iframe 白名单抽取
- v0.3: 敏感字段扫描（密码/信用卡号等自动脱敏后再发给 Provider）
- v0.5: 跨页面对话（多个相关页面同时作为上下文）
- v1.0: 智能追问建议——基于当前页面内容主动推荐问题（与 M13 v1.0 联动）
