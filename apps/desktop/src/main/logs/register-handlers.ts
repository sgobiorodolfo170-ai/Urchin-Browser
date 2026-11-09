/**
 * 运行日志 IPC（设置 · 运行日志选项卡）
 *
 * 通道（契约见 ipc-contract logs.* schema）：
 * 1. logs.read：按级别/关键词读取最近日志（默认 500 条，新 → 旧）；
 * 2. logs.info：返回日志保存目录、当前文件名与历史文件列表。
 *
 * 目录跟随数据目录（DD1）：由 bootstrap 以 `ctx.currentDataDir/logs` 注入，
 * 不提供单独设置项（2026-11-07 用户指令）。
 */
import type { IpcMain } from 'electron';
import { registerHandler, type IpcRes } from '@urchin/ipc-contract';
import { createLogger } from '@urchin/logger';
import { getLogsInfo, initLogFile, readLogs } from './log-store';

const log = createLogger('logs-ipc');
/** 渲染进程错误专用 logger：日志页按 module=renderer 过滤即可只看前端报错 */
const rendererLog = createLogger('renderer');

/** 运行日志 handler 依赖 */
export interface LogHandlerDeps {
  /** 日志目录绝对路径（= <数据目录>/logs） */
  readonly dir: string;
}

/** 注册运行日志 IPC handler。 */
export function registerLogHandlers(ipcMain: IpcMain, deps: LogHandlerDeps): void {
  // 幂等：主进程启动早期（main/index.ts）已初始化；此处兜底 E2E/测试直接调用
  initLogFile(deps.dir);
  registerHandler(ipcMain, 'logs.read', (req) => readLogs(req));
  registerHandler(ipcMain, 'logs.info', () => getLogsInfo() satisfies IpcRes<'logs.info'>);
  // 渲染进程报错（JS 异常 / 未处理 rejection）→ 主进程结构化日志（module=renderer），
  // 与运行日志同页展示；限流在渲染侧（client-error-logging.ts）。
  registerHandler(ipcMain, 'logs.clientError', (req) => {
    rendererLog.error(req.message, {
      ...(req.stack ? { stack: req.stack } : {}),
      ...(req.source ? { source: req.source } : {}),
    });
    return { ok: true };
  });
  log.info('logs ipc handlers registered', { dir: deps.dir });
}
