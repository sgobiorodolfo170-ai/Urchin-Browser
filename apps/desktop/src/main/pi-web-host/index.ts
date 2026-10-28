/**
 * pi 阶段 2 托管服务启动器 · 模块入口
 *
 * 依据：docs/pi-web-评估.md 阶段 2（自研 apps/pi-web 前端 + packages/pi-web-host 托管服务）。
 * 与阶段 1（pi-web）并存双轨：本模块只负责 utility 子进程生命周期，不 import 任何 pi 代码。
 */
export { PiWebHostLauncher, createPiWebHostLauncher, HOST_URL_LINE_RE } from './launcher';
export type {
  PiWebHostLauncherOptions,
  PiWebHostStatusSnapshot,
  PiWebHostState,
  UtilityProcessLike,
  HostForkFn,
  AgentCreds,
} from './launcher';
export { registerPiWebHostHandlers } from './register-handlers';
