/**
 * M6 History · 类型定义
 *
 * 依据：契约 B §3.1 history.* 通道 / 04-模块全景 M6
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「可序列化」）：
 * - HistoryEntry 含可变字段（title / visitCount），记录访问后需就地更新
 * - id / url / visitedAt 设为 readonly，保证创建后不可变的核心字段稳定
 * - HistoryEvent / HistoryEventListener 提供 EventEmitter 模式的类型化事件分发
 */

/**
 * 历史记录条目。
 */
export interface HistoryEntry {
  /** 记录 ID（单调递增正整数，主进程分配） */
  readonly id: number;
  /** 访问的 URL */
  readonly url: string;
  /** 页面标题（可变，后续访问可更新） */
  title: string;
  /** 最近一次访问的时间戳（ms） */
  readonly visitedAt: number;
  /** 访问次数（可变，同 URL 再次访问时递增） */
  visitCount: number;
}

/**
 * 记录历史访问的选项。
 */
export interface HistoryRecordOptions {
  /** 访问的 URL */
  readonly url: string;
  /** 页面标题（可选） */
  readonly title?: string;
}

/**
 * 搜索历史的选项。
 */
export interface HistorySearchOptions {
  /** 搜索关键词 */
  readonly query: string;
  /** 返回结果上限（默认 10） */
  readonly limit?: number;
}

/**
 * 列出历史的选项。
 */
export interface HistoryListOptions {
  /** 返回结果上限（默认 100） */
  readonly limit?: number;
  /** 偏移量（默认 0） */
  readonly offset?: number;
}

/**
 * 历史事件类型。
 */
export type HistoryEvent = 'recorded' | 'deleted' | 'cleared';

/**
 * 历史事件监听器。
 * - 'recorded' / 'deleted'：传入被操作的条目
 * - 'cleared'：不传入条目（entry 为 undefined）
 */
export type HistoryEventListener = (entry?: HistoryEntry) => void;
