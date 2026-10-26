/**
 * M15 DevTools · IPC Handler 注册
 *
 * 依据：契约 B §3 / 实施规划 §5 §11。
 * 职责：注册 devtools.* 8 个通道的 IPC handler，仅做协议适配层，
 * 业务逻辑全部委托 DevtoolsManager。tab 不存在 → NOT_FOUND，
 * 其余按 manager 返回形状透传。
 *
 * 设计理由（agents.md §七.2）：handler 只关心 zod 校验后的纯协议适配，
 * 与 tabs/register-handlers.ts / translate/register-handlers.ts 一致。
 */
import type { IpcMain } from 'electron';
import { registerHandler, IpcError, IpcErrorCode } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { DevtoolsManager } from './devtools-manager';

const log = createLogger('devtools-ipc');

/** 注册 devtools 域 IPC handler。 */
export function registerDevtoolsHandlers(ipcMain: IpcMain, manager: DevtoolsManager): void {
  registerHandler(ipcMain, 'devtools.attach', (req) => {
    log.info('devtools.attach', { tabId: req.tabId });
    return manager.attach(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.detach', (req) => {
    log.info('devtools.detach', { tabId: req.tabId });
    return manager.detach(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.status', (req) => {
    return manager.status(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.network.list', (req) => {
    return manager.listNetwork(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.network.clear', (req) => {
    return manager.clearNetwork(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.console.list', (req) => {
    return manager.listConsole(req.tabId);
  });

  registerHandler(ipcMain, 'devtools.console.clear', (req) => {
    return manager.clearConsole(req.tabId);
  });

  // evaluate 是唯一异步通道；默认 30s IPC 超时兜底死循环表达式（见已知限制）
  registerHandler(ipcMain, 'devtools.evaluate', async (req) => {
    log.info('devtools.evaluate', { tabId: req.tabId, len: req.expression.length });
    return manager.evaluate(req.tabId, req.expression, req.awaitPromise);
  });

  log.info('devtools ipc handlers registered');
}

// 抑制未使用导入告警（IpcError/IpcErrorCode 预留给后续 NOT_FOUND 增强）
void IpcError;
void IpcErrorCode;
