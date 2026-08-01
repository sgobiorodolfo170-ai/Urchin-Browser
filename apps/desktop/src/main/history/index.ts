/**
 * M6 History · 模块入口
 *
 * 依据：04-模块全景 M6 / 契约 B §3.1 history.* 通道
 */
export { HistoryManager, type HistoryPersistence } from './history-manager';
export { registerHistoryHandlers } from './register-handlers';
export type {
  HistoryEntry,
  HistoryRecordOptions,
  HistorySearchOptions,
  HistoryListOptions,
  HistoryEvent,
  HistoryEventListener,
} from './types';
