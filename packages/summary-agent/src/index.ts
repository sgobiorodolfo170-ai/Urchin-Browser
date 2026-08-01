/**
 * @urchin/summary-agent · 网页内容提取 Agent 模块入口
 *
 * 职责：
 * - 网页内容提取（从 BrowserView DOM 提取正文）
 * - HTML 清洗（去冗余、规范化链接、属性白名单）
 * - 文档格式化（生成自包含 HTML 文档）
 * - 文档目录树类型定义
 *
 * 参考 web-extractor (Python) 的提取→清洗→格式化流程，移植为 TypeScript。
 * 在 Electron 浏览器中，页面已加载在 BrowserView，无需 Playwright 抓取，
 * 直接通过 webContents.executeJavaScript 在页面上下文执行提取脚本。
 *
 * 与 pi 模块隔离声明：
 * - 本包不依赖 @earendil-works/pi-* 任何模块
 * - 本包不依赖 @urchin/ai-extension（AiChatView 的 pi 适配层）
 */
export type {
  SummaryAgentInput,
  SummaryAgentOutput,
  SummaryAgentConfig,
  SummaryAgent,
  SummaryTreeNode,
  SummarySaveResult,
} from './types';
export type { ExtractionResult } from './extractor';
export { extractPageContent, PAGE_EXTRACT_SCRIPT } from './extractor';
export { formatDocument } from './formatter';
