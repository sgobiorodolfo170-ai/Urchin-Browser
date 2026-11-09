/**
 * 运行日志域（设置 · 运行日志）
 *
 * 落盘位置跟随数据目录：`<数据目录>/logs/app-YYYY-MM-DD.log`（JSONL）。
 * 见 ./log-store.ts 的模块注释（设计理由 / 容量 / 隐私约束）。
 */
export {
  initLogFile,
  readLogs,
  getLogsInfo,
  __resetLogFileForTest,
  type LogQuery,
  type LogsReadResult,
  type LogsInfoResult,
  type LogFileDescriptor,
} from './log-store';
export { registerLogHandlers, type LogHandlerDeps } from './register-handlers';
