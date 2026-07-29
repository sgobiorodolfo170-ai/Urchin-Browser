/**
 * M7 Settings · Settings IPC Handler 注册
 *
 * 依据：契约 B §3.1 settings.* 通道 / 04-模块全景 M7/M17
 * 职责：
 * 注册 settings.get / settings.set / settings.getAll IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 SettingsManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { SettingsManager } from './settings-manager';

const log = createLogger('settings-ipc');

/**
 * 注册 settings 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param settingsManager SettingsManager 实例
 */
export function registerSettingsHandlers(ipcMain: IpcMain, settingsManager: SettingsManager): void {
  // settings.get：获取指定键的值
  registerHandler(ipcMain, 'settings.get', (req) => {
    log.info('settings.get', { key: req.key });

    const value = settingsManager.get(req.key);

    // 键不存在时返回 null（与 settingsGetResSchema 的 nullable 一致）
    return { value: value === undefined ? null : value };
  });

  // settings.set：设置指定键的值
  registerHandler(ipcMain, 'settings.set', (req) => {
    log.info('settings.set', { key: req.key });

    settingsManager.set(req.key, req.value);

    return { ok: true as const };
  });

  // settings.getAll：获取全部设置条目
  registerHandler(ipcMain, 'settings.getAll', () => {
    log.info('settings.getAll');

    const entries = settingsManager.getAll();

    return { entries };
  });

  log.info('settings ipc handlers registered');
}
