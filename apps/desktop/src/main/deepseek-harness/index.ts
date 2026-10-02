/**
 * DeepSeek Harness · 模块入口
 *
 * 与 pi-web/ 模块结构对齐：launcher（子进程生命周期）+ register-handlers（IPC）+
 * tab-lifecycle（标签关闭→停止绑定）。不 import 任何 dsh 代码，完全隔离。
 */
export { DshLauncher, createDshLauncher } from './launcher';
export type {
  DshLauncherOptions,
  DshLaunchResult,
  DshState,
  DshStatusSnapshot,
  ChildProcessLike,
  SpawnFn,
} from './launcher';
export { registerDshHandlers } from './register-handlers';
export { bindTabCloseToStop } from './tab-lifecycle';
export type { TabManagerLike, DshLauncherLike } from './tab-lifecycle';
