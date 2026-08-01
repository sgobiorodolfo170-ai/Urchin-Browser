/**
 * Summary 模块入口
 *
 * 摘要 Agent 模块：单 Agent AI 助手，提取网页关键信息并生成为本地网页格式文档。
 * 与 pi 模块相互隔离（不依赖 @earendil-works/pi-*）。
 */
export { SummaryManager } from './summary-manager';
export { registerSummaryHandlers, type SummaryHandlerDeps } from './register-handlers';
