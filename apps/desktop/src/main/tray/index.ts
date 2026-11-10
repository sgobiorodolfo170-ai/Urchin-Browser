/**
 * 系统托盘模块入口（见 tray-manager.ts 头注释）。
 */
export {
  TrayManager,
  MINIMIZE_TO_TRAY_KEY,
  buildTrayMenuTemplate,
  shouldHideOnClose,
} from './tray-manager';
export type { TrayManagerDeps, TrayMenuTemplateItem, CloseInterceptFlags } from './tray-manager';
