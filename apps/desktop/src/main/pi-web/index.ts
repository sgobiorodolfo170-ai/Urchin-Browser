/**
 * pi 网页版启动器 · 模块入口（阶段 1）
 *
 * 依据：docs/pi-web-评估.md（依赖审查 + 三阶段方案）
 * 与 ai/ 模块的关系：完全独立——本模块只负责子进程生命周期，不 import 任何 pi 代码。
 */
export { PiWebLauncher, createPiWebLauncher } from './launcher';
export type {
  PiWebLauncherOptions,
  PiWebState,
  PiWebStatusSnapshot,
  ChildProcessLike,
  SpawnFn,
} from './launcher';
export { registerPiWebHandlers } from './register-handlers';
export { ensureAuthPlaceholder } from './auth-placeholder';
export {
  installPiWebPageEnhance,
  buildThemeFollowScript,
  buildProjectsPanelScript,
  buildThemePushCall,
  pushPiTheme,
} from './page-enhance';
export type { PiThemeTabManagerLike } from './page-enhance';
