/**
 * 本地文件域模块（M 新增 · 本地文件网页化打开）
 *
 * 职责：提供 file.stat / file.read / file.open 三个 IPC handler，
 * 支撑「以网页形式打开本地文件」：音视频/PDF/图片走 Chromium 原生渲染（file://），
 * 文本类文档走主窗口 React 查看器（urchin://file-viewer）。
 */
export { registerFileHandlers } from './register-handlers';
export { classifyFileKind, getExt, getExtensionsForKind, inferMimeType } from './file-kind';
export { VIEWABLE_KINDS } from './register-handlers';
