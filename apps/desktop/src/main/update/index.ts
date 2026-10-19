/**
 * Update · 模块入口（M20 自动更新，dev.114 提前落地）
 *
 * 结构：update-service（状态机 + electron-updater 懒加载封装）+
 * register-handlers（IPC 注册）。本模块不 import electron（依赖注入），
 * electron-updater 走动态 import（见 update-service）——开发态零副作用。
 */
export { createUpdateService, UPDATE_CHANNEL, UPDATE_EVENT_CHANNEL } from './update-service';
export type {
  UpdateService,
  UpdateServiceOptions,
  UpdaterHandle,
  UpdaterUpdateInfo,
} from './update-service';
export { registerUpdateHandlers } from './register-handlers';
