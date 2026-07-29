/**
 * M6 History · History IPC Handler 注册
 *
 * 依据：契约 B §3.1 history.* 通道 / 04-模块全景 M6/M17
 * 职责：
 * 注册 history.record / history.search / history.list /
 *      history.delete / history.clear IPC handler。
 *
 * 设计理由（agents.md §七.2）：
 * - IPC handler 只做协议适配，业务逻辑委托给 HistoryManager
 * - 入参出参由 registerHandler 自动 zod 校验，handler 只关心纯逻辑
 */
import type { IpcMain } from 'electron';
import { registerHandler } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import type { HistoryManager } from './history-manager';

const log = createLogger('history-ipc');

/**
 * 注册 history 域 IPC handler。
 *
 * @param ipcMain Electron ipcMain 实例
 * @param historyManager HistoryManager 实例
 */
export function registerHistoryHandlers(ipcMain: IpcMain, historyManager: HistoryManager): void {
  // history.record：记录一次访问
  registerHandler(ipcMain, 'history.record', (req) => {
    log.info('history.record', { url: req.url });

    const entry = historyManager.record(req.url, req.title);

    return { ok: true as const, entry };
  });

  // history.search：搜索历史
  registerHandler(ipcMain, 'history.search', (req) => {
    log.info('history.search', { query: req.query });

    const entries = historyManager.search(req.query, req.limit);

    return { entries };
  });

  // history.list：列出历史
  registerHandler(ipcMain, 'history.list', (req) => {
    log.info('history.list', { limit: req.limit, offset: req.offset });

    return historyManager.list(req.limit, req.offset);
  });

  // history.delete：删除指定记录
  registerHandler(ipcMain, 'history.delete', (req) => {
    log.info('history.delete', { id: req.id });

    historyManager.delete(req.id);

    return { ok: true as const, id: req.id };
  });

  // history.clear：清空所有历史
  registerHandler(ipcMain, 'history.clear', () => {
    log.info('history.clear');

    const deleted = historyManager.clear();

    return { ok: true as const, deleted };
  });

  log.info('history ipc handlers registered');
}
