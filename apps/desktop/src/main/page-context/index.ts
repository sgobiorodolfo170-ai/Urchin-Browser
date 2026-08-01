/**
 * M14 Page Context Extractor · 模块入口
 *
 * 依据：04-模块全景 M14 / 契约 F
 */
export { PageContextExtractor, DEFAULT_MAX_LENGTH } from './extractor';
export { buildContextXml, buildContextPrompt } from './prompt-builder';
export { registerPageContextHandlers } from './register-handlers';
