/**
 * M7 Settings · 模块入口
 *
 * 依据：04-模块全景 M7 / 契约 B §3.1 settings.* 通道
 */
export { SettingsManager } from './settings-manager';
export { registerSettingsHandlers } from './register-handlers';
export type { SettingEntry, SettingsEvent, SettingsEventListener } from './types';
